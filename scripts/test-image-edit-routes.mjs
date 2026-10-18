import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createImageEditService, IMAGE_EDIT_REQUEST_LIMIT, ImageEditError } from "../image-edit-service.mjs";

// Execute the actual server handler with an in-memory HTTP facade. No port is
// opened, .env is never read, and both providers receive mock requests only.
const serverUrl = new URL("../server.mjs", import.meta.url).href;
const originalSource = await readFile(new URL(serverUrl), "utf8");
assert.match(originalSource, /^await loadLocalEnv\(\);$/m);
const serverSource = originalSource
  .replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", "__serverUrl")
  .replace(/^await loadLocalEnv\(\);$/m, "");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
const image = `data:image/png;base64,${PNG}`;
const secret = "route-test-key-do-not-expose";
const configuredEnv = { SEEDREAM_API_KEY: secret, SEEDREAM_MODEL: "ep-image-route-test", IMAGE_PROMPT_MODEL: "ep-vision-route-test", RODIN_API_KEY: "rodin-route-test-key" };
let checks = 0;

async function check(name, action) {
  try { await action(); checks++; console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}`); throw error; }
}

function runtime({ env = configuredEnv, upstream } = {}) {
  const calls = [], fileReads = [], fileStats = [], logs = [];
  let listener, listenCalls = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (upstream) return upstream(url, options);
    if (String(url).endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "保持线稿轮廓，完善为红色陶瓷杯。" } }] });
    if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ b64_json: PNG }] });
    if (String(url).endsWith("/api/v2/status")) return Response.json({ jobs: [{ status: "Done" }] });
    throw new Error("Unexpected upstream request");
  };
  const context = vm.createContext({
    __serverUrl: serverUrl,
    path, fileURLToPath, Buffer, URL, AbortSignal, ImageEditError, IMAGE_EDIT_REQUEST_LIMIT,
    process: { env: { ...env } },
    createImageEditService: () => createImageEditService({ env, fetchImpl }),
    fetch: fetchImpl,
    readFile: async (target) => { fileReads.push(target); return Buffer.from("static content"); },
    stat: async (target) => { fileStats.push(target); return { isFile: () => true, size: 14 }; },
    console: { error: (...values) => logs.push(values), log: (...values) => logs.push(values) },
    http: { createServer(callback) { listener = callback; return { listen() { listenCalls++; } }; } },
  });
  new vm.Script(serverSource, { filename: "server.mjs (route test)" }).runInContext(context);
  assert.equal(typeof listener, "function", "the actual server must register its request handler");
  assert.equal(listenCalls, 1, "server.listen is replaced with a facade, never a real socket");

  async function send({ method = "POST", url = "/api/image-edit", origin = "http://localhost:8000", host = "localhost:8000", contentType = "application/json", body = { image, prompt: "红色陶瓷杯" }, chunks } = {}) {
    let bodyReads = 0;
    const request = {
      method, url,
      headers: { host, ...(origin === null ? {} : { origin }), ...(contentType === null ? {} : { "content-type": contentType }) },
      async *[Symbol.asyncIterator]() {
        bodyReads++;
        if (chunks) { for (const chunk of chunks) yield chunk; }
        else yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      },
    };
    let status, headers, raw, ended = false;
    const response = {
      writeHead(value, nextHeaders) { status = value; headers = nextHeaders; },
      end(value) { raw = value; ended = true; },
    };
    await listener(request, response);
    assert.equal(ended, true);
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    assert.ok(!text.includes(secret), "API responses must not expose the Seedream key");
    return { status, headers, text, get payload() { return JSON.parse(text); }, bodyReads };
  }
  return { send, calls, fileReads, fileStats, logs };
}

await check("GET 配置公开可用性与模型名，不读取 .env 或泄漏密钥", async () => {
  const r = runtime();
  const result = await r.send({ method: "GET", url: "/api/image-edit/config", origin: null });
  assert.equal(result.status, 200);
  assert.equal(result.payload.available, true);
  assert.equal(result.payload.promptAvailable, true);
  assert.equal(result.payload.model, configuredEnv.SEEDREAM_MODEL);
  assert.equal(result.payload.promptModel, configuredEnv.IMAGE_PROMPT_MODEL);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(r.calls.length, 0); assert.equal(r.fileReads.length, 0); assert.equal(result.bodyReads, 0);
});

await check("未配置时 GET 正确列出缺失项", async () => {
  const r = runtime({ env: {} });
  const result = await r.send({ method: "GET", url: "/api/image-edit/config" });
  assert.equal(result.payload.available, false);
  assert.deepEqual(result.payload.missing, ["SEEDREAM_API_KEY", "SEEDREAM_MODEL"]);
  assert.equal(result.payload.promptAvailable, false);
});

for (const url of ["/api/image-edit", "/api/image-edit/prompt"]) {
  await check(`${url} 无 Origin 时在读请求体前拒绝`, async () => {
    const r = runtime(); const result = await r.send({ url, origin: null });
    assert.equal(result.status, 403); assert.equal(result.payload.error, "LOCAL_ORIGIN_REQUIRED");
    assert.equal(result.bodyReads, 0); assert.equal(r.calls.length, 0);
  });
  await check(`${url} 外域 Origin 时拒绝`, async () => {
    const r = runtime(); const result = await r.send({ url, origin: "https://example.com" });
    assert.equal(result.status, 403); assert.equal(result.payload.error, "INVALID_LOCAL_ORIGIN");
    assert.equal(result.bodyReads, 0); assert.equal(r.calls.length, 0);
  });
}

for (const [name, origin, host] of [
  ["本地域名但端口不同", "http://localhost:9000", "localhost:8000"],
  ["相同外部主机伪装", "http://example.com:8000", "example.com:8000"],
  ["file 页面 null Origin", "null", "localhost:8000"],
]) {
  await check(`${name}不可调用付费接口`, async () => {
    const r = runtime(); const result = await r.send({ origin, host });
    assert.equal(result.status, 403); assert.equal(r.calls.length, 0);
  });
}

for (const [name, origin, host] of [
  ["localhost", "http://localhost:8000", "localhost:8000"],
  ["IPv4 loopback", "http://127.0.0.1:8000", "127.0.0.1:8000"],
  ["IPv6 loopback", "http://[::1]:8000", "[::1]:8000"],
]) {
  await check(`${name}有效同源编辑请求调用图片接口`, async () => {
    const r = runtime(); const result = await r.send({ origin, host, contentType: "application/json; charset=utf-8" });
    assert.equal(result.status, 200); assert.equal(result.payload.image, image);
    assert.equal(r.calls.length, 1); assert.ok(r.calls[0].url.endsWith("/images/generations"));
    assert.equal(JSON.parse(r.calls[0].options.body).prompt, "红色陶瓷杯");
  });
}

await check("有效同源 AI 起草路由只调用视觉接口", async () => {
  const r = runtime(); const result = await r.send({ url: "/api/image-edit/prompt", body: { image, intent: "红色陶瓷", prepareFor3D: true } });
  assert.equal(result.status, 200); assert.equal(result.payload.prompt, "保持线稿轮廓，完善为红色陶瓷杯。");
  assert.equal(r.calls.length, 1); assert.ok(r.calls[0].url.endsWith("/chat/completions"));
});

for (const url of ["/api/image-edit", "/api/image-edit/prompt"]) {
  for (const contentType of ["text/plain", "application/json-evil", null]) {
    await check(`${url} 拒绝 Content-Type ${contentType ?? "缺失"}`, async () => {
      const r = runtime(); const result = await r.send({ url, contentType });
      assert.equal(result.status, 415); assert.equal(result.payload.error, "JSON_REQUIRED");
      assert.equal(result.bodyReads, 0); assert.equal(r.calls.length, 0);
    });
  }
  await check(`${url} 无效 JSON 返回 400`, async () => {
    const r = runtime(); const result = await r.send({ url, body: "{invalid json" });
    assert.equal(result.status, 400); assert.match(result.payload.message, /JSON/); assert.equal(r.calls.length, 0);
  });
}

const overLimit = Buffer.alloc(IMAGE_EDIT_REQUEST_LIMIT + 1, 0x61);
for (const url of ["/api/image-edit", "/api/image-edit/prompt"]) {
  await check(`${url} 超过请求体上限返回 413`, async () => {
    const r = runtime(); const result = await r.send({ url, chunks: [overLimit.subarray(0, 1024), overLimit.subarray(1024)] });
    assert.equal(result.status, 413); assert.match(result.payload.message, /过大/); assert.equal(r.calls.length, 0);
  });
}

await check("有效 JSON 的输入校验错误保留专用错误码", async () => {
  const r = runtime(); const result = await r.send({ body: { image: "data:image/png;base64,%%%%", prompt: "陶瓷杯" } });
  assert.equal(result.status, 400); assert.equal(result.payload.error, "INVALID_IMAGE"); assert.equal(r.calls.length, 0);
});

await check("未配置图片服务的 POST 返回 503", async () => {
  const r = runtime({ env: {} }); const result = await r.send();
  assert.equal(result.status, 503); assert.equal(result.payload.error, "IMAGE_EDIT_NOT_CONFIGURED"); assert.equal(r.calls.length, 0);
});

await check("未配置视觉模型的 POST 不回退假 AI", async () => {
  const r = runtime({ env: { SEEDREAM_API_KEY: secret } });
  const result = await r.send({ url: "/api/image-edit/prompt", body: { image, intent: "" } });
  assert.equal(result.status, 503); assert.equal(result.payload.error, "IMAGE_PROMPT_NOT_CONFIGURED"); assert.equal(r.calls.length, 0);
});

await check("上游敏感错误原文不会出现在路由响应或日志", async () => {
  const r = runtime({ upstream: () => Response.json({ error: `echo ${secret}` }, { status: 401 }) });
  const result = await r.send();
  assert.equal(result.status, 502); assert.equal(result.payload.error, "IMAGE_EDIT_AUTH_FAILED");
  assert.ok(!JSON.stringify(r.logs).includes(secret));
});

await check("路由保留安全诊断字段，但不公开供应商错误原文", async () => {
  const requestId = "20261018120000abcdef1234567890";
  const r = runtime({ upstream: () => Response.json({ error: { code: "InvalidParameter", param: "image", message: `raw-provider-text ${secret}` } }, { status: 400, headers: { "x-request-id": requestId } }) });
  const result = await r.send();
  assert.equal(result.status, 502);
  assert.equal(result.payload.error, "IMAGE_EDIT_INVALID_PARAMETERS");
  assert.deepEqual(result.payload.details, { httpStatus: 400, providerCode: "InvalidParameter", parameter: "image", requestId });
  assert.ok(!result.text.includes("raw-provider-text"));
  assert.ok(!JSON.stringify(r.logs).includes(secret));
  assert.equal(r.calls.length, 1);
});

await check("未知错误码和敏感请求编号不会经路由回传", async () => {
  const r = runtime({ upstream: () => Response.json({ error: { code: secret, param: secret, message: secret } }, { status: 400, headers: { "x-request-id": secret } }) });
  const result = await r.send();
  assert.deepEqual(result.payload.details, { httpStatus: 400 });
  assert.ok(!JSON.stringify(r.logs).includes(secret));
});

await check("误用图片生成模型作 AI 润色模型时无需上游调用", async () => {
  const r = runtime({ env: { ...configuredEnv, IMAGE_PROMPT_MODEL: "doubao-seedream-4-0-250828" } });
  const config = await r.send({ method: "GET", url: "/api/image-edit/config" });
  assert.equal(config.payload.available, true);
  assert.equal(config.payload.promptAvailable, false);
  assert.equal(config.payload.promptIssue, "IMAGE_PROMPT_MODEL_NEEDS_VISION");
  const result = await r.send({ url: "/api/image-edit/prompt", body: { image, intent: "修改风格" } });
  assert.equal(result.status, 503);
  assert.equal(result.payload.error, "IMAGE_PROMPT_INVALID_MODEL");
  assert.equal(r.calls.length, 0);
});

for (const url of ["/image-edit-service.mjs", "/server.mjs", "/.env"]) {
  await check(`静态路由不暴露 ${url}`, async () => {
    const r = runtime(); const result = await r.send({ method: "GET", url, origin: null });
    assert.equal(result.status, 404); assert.equal(r.fileReads.length, 0); assert.equal(r.fileStats.length, 0);
  });
}

await check("普通前端模块仍可通过静态路由读取", async () => {
  const r = runtime(); const result = await r.send({ method: "GET", url: "/image-workflow.js", origin: null });
  assert.equal(result.status, 200); assert.equal(result.text, "static content"); assert.equal(r.fileReads.length, 1);
  assert.equal(result.headers["Content-Type"], "text/javascript; charset=utf-8");
});

await check("原有 Rodin 配置与状态转发路由保留", async () => {
  const r = runtime();
  const configResult = await r.send({ method: "GET", url: "/api/hyper3d/config", origin: null });
  assert.equal(configResult.status, 200); assert.equal(configResult.payload.available, true);
  const statusResult = await r.send({ url: "/api/hyper3d/task-status", body: { subscription_key: "subscription-route-test" } });
  assert.equal(statusResult.status, 200); assert.equal(statusResult.payload.jobs[0].status, "Done");
  assert.equal(r.calls[0].url, "https://api.hyper3d.com/api/v2/status");
  assert.equal(r.calls[0].options.headers.Authorization, `Bearer ${configuredEnv.RODIN_API_KEY}`);
});

await check("未知图像编辑 API 不会调用上游", async () => {
  const r = runtime(); const result = await r.send({ method: "GET", url: "/api/image-edit/unknown" });
  assert.equal(result.status, 404); assert.equal(r.calls.length, 0);
});

console.log(`\n${checks} server route checks passed (in-memory HTTP, mock providers; no sockets or paid requests).`);
