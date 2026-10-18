import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createImageEditService, IMAGE_EDIT_REQUEST_LIMIT, ImageEditError } from "./image-edit-service.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const API_ORIGIN = "https://api.hyper3d.com";
const MAX_API_BODY = 55 * 1024 * 1024;
const MAX_MODEL_BYTES = 240 * 1024 * 1024;
const imageEditService = createImageEditService();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".task": "application/octet-stream",
  ".obj": "text/plain; charset=utf-8", ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".zip": "application/zip",
};

async function loadLocalEnv() {
  try {
    const contents = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[Air Drawing] Could not read .env:", error.message);
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  response.end(body);
}

async function readBody(request, limit = MAX_API_BODY) {
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) {
    const error = new Error(`请求内容过大（上限 ${Math.ceil(limit / (1024 * 1024))} MB）。`);
    error.status = 413;
    throw error;
  }
  return Buffer.concat(chunks, length);
}

async function parseJsonBody(request, limit = 64 * 1024) {
  const raw = await readBody(request, limit);
  try { return JSON.parse(raw.toString("utf8")); }
  catch {
    const error = new Error("请求 JSON 格式无效。");
    error.status = 400;
    throw error;
  }
}

async function forwardApi(request, response, endpoint, body, headers = {}) {
  const apiKey = process.env.RODIN_API_KEY?.trim();
  if (!apiKey) return sendJson(response, 503, { error: "HYPER3D_API_KEY_NOT_CONFIGURED", message: "请在项目根目录 .env 中设置 RODIN_API_KEY，然后重启本地服务。" });
  try {
    const upstream = await fetch(`${API_ORIGIN}${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, ...headers },
      body,
      signal: AbortSignal.timeout(180_000),
    });
    const result = await upstream.text();
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(result),
    });
    response.end(result);
  } catch (error) {
    console.error(`[Air Drawing] Hyper3D ${endpoint} request failed:`, error.message);
    sendJson(response, 502, { error: "HYPER3D_UPSTREAM_UNAVAILABLE", message: "无法连接 Hyper3D API。请检查网络、API 状态和本机代理设置。" });
  }
}

function permittedDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const suffixes = (process.env.HYPER3D_DOWNLOAD_HOSTS || "hyper3d.com,hyper3d.ai,amazonaws.com,cloudfront.net,googleapis.com").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  return url;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function requireLocalOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) {
    sendJson(response, 403, { error: "LOCAL_ORIGIN_REQUIRED", message: "本地 API 只接受来自应用页面的请求。" });
    return false;
  }
  try {
    const originUrl = new URL(origin);
    const requestHost = new URL(`http://${request.headers.host || ""}`);
    if (originUrl.host.toLowerCase() !== requestHost.host.toLowerCase() || !isLoopbackHost(originUrl.hostname)) throw new Error("origin mismatch");
    return true;
  } catch {
    sendJson(response, 403, { error: "INVALID_LOCAL_ORIGIN", message: "API 请求必须来自此电脑上的本地应用页面。" });
    return false;
  }
}

async function fetchGeneratedFile(request, response, requestUrl) {
  let current = permittedDownloadUrl(requestUrl.searchParams.get("url") || "");
  if (!current) return sendJson(response, 400, { error: "INVALID_DOWNLOAD_URL", message: "模型下载地址不是受支持的 HTTPS 文件地址。" });
  if (!process.env.RODIN_API_KEY?.trim()) return sendJson(response, 503, { error: "HYPER3D_API_KEY_NOT_CONFIGURED", message: "请先配置 Hyper3D API Key。" });
  try {
    let result;
    for (let redirects = 0; redirects <= 4; redirects++) {
      result = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      if (![301, 302, 303, 307, 308].includes(result.status)) break;
      const location = result.headers.get("location");
      if (!location || redirects === 4) throw new Error("下载服务重定向次数过多。");
      current = permittedDownloadUrl(new URL(location, current).toString());
      if (!current) throw new Error("下载地址重定向到非受信任域名。");
    }
    if (!result?.ok) throw new Error(`文件下载 HTTP ${result?.status || "失败"}`);
    const chunks = [];
    let length = 0;
    if (!result.body) throw new Error("下载服务返回空文件。");
    for await (const chunk of result.body) {
      length += chunk.length;
      if (length > MAX_MODEL_BYTES) throw new Error("模型文件超过 240 MB 上限。");
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks, length);
    response.writeHead(200, { "Content-Type": "model/gltf-binary", "Content-Length": data.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(data);
  } catch (error) {
    console.error("[Air Drawing] Hyper3D model download failed:", error.message);
    sendJson(response, 502, { error: "MODEL_DOWNLOAD_FAILED", message: error.message || "模型文件下载失败。" });
  }
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/image-edit/config") {
    return sendJson(response, 200, imageEditService.configuration());
  }
  if (request.method === "GET" && url.pathname === "/api/hyper3d/config") {
    return sendJson(response, 200, { available: Boolean(process.env.RODIN_API_KEY?.trim()), provider: "Hyper3D Rodin Gen-2.5", server: "local" });
  }
  if (request.method === "POST" && !requireLocalOrigin(request, response)) return;
  if (request.method === "POST" && url.pathname === "/api/image-edit") {
    if ((request.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return sendJson(response, 415, { error: "JSON_REQUIRED", message: "图像编辑请求必须使用 application/json。" });
    const payload = await parseJsonBody(request, IMAGE_EDIT_REQUEST_LIMIT);
    return sendJson(response, 200, await imageEditService.edit(payload));
  }
  if (request.method === "POST" && url.pathname === "/api/image-edit/prompt") {
    if ((request.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") return sendJson(response, 415, { error: "JSON_REQUIRED", message: "AI 起草请求必须使用 application/json。" });
    const payload = await parseJsonBody(request, IMAGE_EDIT_REQUEST_LIMIT);
    return sendJson(response, 200, await imageEditService.draftPrompt(payload));
  }
  if (request.method === "POST" && url.pathname === "/api/hyper3d/generate") {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !contentType.includes("boundary=")) return sendJson(response, 400, { error: "MULTIPART_REQUIRED", message: "生成请求必须使用 multipart/form-data。" });
    const body = await readBody(request);
    return forwardApi(request, response, "/api/v2/rodin", body, { "Content-Type": contentType });
  }
  if (request.method === "POST" && url.pathname === "/api/hyper3d/task-status") {
    const payload = await parseJsonBody(request);
    if (typeof payload.subscription_key !== "string" || payload.subscription_key.length > 512) return sendJson(response, 400, { error: "INVALID_SUBSCRIPTION_KEY", message: "任务状态查询缺少有效的 subscription_key。" });
    return forwardApi(request, response, "/api/v2/status", JSON.stringify({ subscription_key: payload.subscription_key }), { "Content-Type": "application/json" });
  }
  if (request.method === "POST" && url.pathname === "/api/hyper3d/download") {
    const payload = await parseJsonBody(request);
    if (typeof payload.task_uuid !== "string" || payload.task_uuid.length > 128) return sendJson(response, 400, { error: "INVALID_TASK_UUID", message: "模型下载缺少有效的任务编号。" });
    return forwardApi(request, response, "/api/v2/download", JSON.stringify({ task_uuid: payload.task_uuid }), { "Content-Type": "application/json" });
  }
  if (request.method === "GET" && url.pathname === "/api/hyper3d/file") return fetchGeneratedFile(request, response, url);
  sendJson(response, 404, { error: "NOT_FOUND", message: "API 路由不存在。" });
}

async function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relativePath);
  if (target !== ROOT && !target.startsWith(`${ROOT}${path.sep}`)) return sendJson(response, 403, { error: "FORBIDDEN" });
  if (path.basename(target).startsWith(".") || ["server.mjs", "image-edit-service.mjs", ".env"].includes(path.basename(target))) return sendJson(response, 404, { error: "NOT_FOUND" });
  try {
    const info = await stat(target);
    if (!info.isFile()) return sendJson(response, 404, { error: "NOT_FOUND" });
    const headers = { "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream", "Content-Length": info.size, "X-Content-Type-Options": "nosniff" };
    if (["index.html", "styles.css", "app.js", "image-workflow.js", "pinch-owner.js"].includes(relativePath)) headers["Cache-Control"] = "no-store";
    response.writeHead(200, headers);
    response.end(await readFile(target));
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "NOT_FOUND" });
    console.error("[Air Drawing] Static file error:", error.message);
    sendJson(response, 500, { error: "STATIC_FILE_ERROR" });
  }
}

await loadLocalEnv();
const server = http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host || "localhost"}`); }
  catch { return sendJson(response, 400, { error: "INVALID_URL" }); }
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return await serveStatic(request, response, url);
  } catch (error) {
    if (error instanceof ImageEditError) return sendJson(response, error.status, { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    console.error("[Air Drawing] Request failed:", error.message);
    sendJson(response, error.status || 500, { error: "REQUEST_FAILED", message: error.message || "请求处理失败。" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Air Drawing running at http://localhost:${PORT}`);
  console.log(`Hyper3D API key: ${process.env.RODIN_API_KEY?.trim() ? "configured" : "not configured (add it to .env to enable generation)"}`);
  console.log(`Seedream image editing: ${imageEditService.configuration().available ? "configured" : "not configured (set SEEDREAM_API_KEY and SEEDREAM_MODEL in .env)"}`);
});
