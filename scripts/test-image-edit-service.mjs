import assert from "node:assert/strict";
import { createImageEditService, ImageEditError, validateImageEditInput } from "../image-edit-service.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";
const image = `data:image/png;base64,${PNG_BASE64}`;
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const key = "secret-test-key-never-send-to-client";
const env = { SEEDREAM_API_KEY: key, SEEDREAM_MODEL: "ep-configured-test-model" };
const input = { image, prompt: "把线稿完善为红色陶瓷杯" };
let checks = 0;

async function check(name, action) {
  try { await action(); checks++; console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}`); throw error; }
}

function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function mockService(handler, values = env) {
  let calls = 0;
  return {
    service: createImageEditService({ env: values, fetchImpl: async (...args) => { calls++; return handler(...args); } }),
    calls: () => calls,
  };
}

async function expectError(service, payload, code, status) {
  await assert.rejects(service.edit(payload), error => {
    assert.ok(error instanceof ImageEditError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(key));
    return true;
  });
}

await check("配置状态不包含 API Key", () => {
  const { service } = mockService(() => {});
  assert.deepEqual(service.configuration(), { available: true, provider: "Seedream", model: env.SEEDREAM_MODEL, missing: [], promptAvailable: false, promptModel: "" });
  assert.ok(!JSON.stringify(service.configuration()).includes(key));
});

await check("未配置时同时列出两项必填配置", () => {
  const { service } = mockService(() => {}, {});
  assert.deepEqual(service.configuration().missing, ["SEEDREAM_API_KEY", "SEEDREAM_MODEL"]);
  assert.equal(service.configuration().available, false);
});

await check("不猜测模型 ID，模型缺失时不调用上游", async () => {
  const mock = mockService(() => {}, { SEEDREAM_API_KEY: key });
  await expectError(mock.service, input, "IMAGE_EDIT_NOT_CONFIGURED", 503);
  assert.equal(mock.calls(), 0);
});

await check("无效模型 ID 和换行密钥不能用于调用", () => {
  const { service } = mockService(() => {}, { SEEDREAM_API_KEY: "key\nHeader:value", SEEDREAM_MODEL: "wrong model" });
  assert.equal(service.configuration().available, false);
  assert.equal(service.configuration().model, "");
});

await check("成功请求使用固定官方地址、服务端认证和 base64 输出参数", async () => {
  const mock = mockService((url, options) => {
    assert.equal(url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { model: env.SEEDREAM_MODEL, prompt: input.prompt, image, size: "2K", response_format: "b64_json", watermark: false });
    return response({ data: [{ b64_json: PNG_BASE64 }] });
  });
  assert.deepEqual(await mock.service.edit(input), { image, provider: "Seedream", model: env.SEEDREAM_MODEL });
  assert.equal(mock.calls(), 1);
});

await check("准备 3D 时附加主体与背景要求", () => {
  const result = validateImageEditInput({ ...input, prompt: `  ${input.prompt}  `, prepareFor3D: true });
  assert.ok(result.prompt.startsWith(input.prompt));
  assert.ok(result.prompt.includes("仅呈现一个完整、独立的主体"));
});

await check("未勾选 3D 时保留用户要求", () => {
  assert.equal(validateImageEditInput({ ...input, prepareFor3D: false }).prompt, input.prompt);
});

await check("正确识别供应商 JPEG 输出而不伪装为 PNG", async () => {
  const { service } = mockService(() => response({ data: [{ b64_json: JPEG_BASE64 }] }));
  assert.equal((await service.edit(input)).image, `data:image/jpeg;base64,${JPEG_BASE64}`);
});

for (const [name, payload, code] of [
  ["拒绝空请求体", null, "INVALID_IMAGE"],
  ["拒绝数组请求体", [], "INVALID_IMAGE"],
  ["拒绝空提示词", { ...input, prompt: "   " }, "INVALID_PROMPT"],
  ["拒绝非字符串提示词", { ...input, prompt: 123 }, "INVALID_PROMPT"],
  ["拒绝超长提示词", { ...input, prompt: "字".repeat(4001) }, "INVALID_PROMPT"],
  ["拒绝非布尔 3D 选项", { ...input, prepareFor3D: "false" }, "INVALID_PREPARE_FOR_3D"],
  ["拒绝公网图片地址", { ...input, image: "https://example.com/image.png" }, "INVALID_IMAGE"],
  ["拒绝 JPEG 输入伪装选区", { ...input, image: image.replace("image/png", "image/jpeg") }, "INVALID_IMAGE"],
  ["拒绝伪造 PNG 头的 SVG", { ...input, image: `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}` }, "INVALID_IMAGE"],
  ["拒绝无效 base64", { ...input, image: "data:image/png;base64,%%%%" }, "INVALID_IMAGE"],
  ["拒绝非标准 base64 填充", { ...input, image: `${image}==` }, "INVALID_IMAGE"],
  ["拒绝截断的 PNG", { ...input, image: `data:image/png;base64,${Buffer.from(PNG_BASE64, "base64").subarray(0, 40).toString("base64")}` }, "INVALID_IMAGE"],
]) {
  await check(name, async () => {
    const mock = mockService(() => { throw new Error("should not call upstream"); });
    await expectError(mock.service, payload, code, 400);
    assert.equal(mock.calls(), 0);
  });
}

for (const [name, width, height] of [["拒绝零宽图片", 0, 1], ["拒绝超大单边", 8193, 1], ["拒绝超大像素总数", 8192, 8192]]) {
  await check(name, async () => {
    const bytes = Buffer.from(PNG_BASE64, "base64");
    bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    const mock = mockService(() => {});
    await expectError(mock.service, { ...input, image: `data:image/png;base64,${bytes.toString("base64")}` }, "INVALID_IMAGE", 400);
    assert.equal(mock.calls(), 0);
  });
}

await check("拒绝超过 10 MB 的输入", async () => {
  const mock = mockService(() => {});
  await expectError(mock.service, { ...input, image: `data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}` }, "INVALID_IMAGE", 400);
  assert.equal(mock.calls(), 0);
});

for (const [status, code, returnedStatus] of [[401, "IMAGE_EDIT_AUTH_FAILED", 502], [403, "IMAGE_EDIT_MODEL_ACCESS_DENIED", 502], [429, "IMAGE_EDIT_RATE_LIMITED", 429], [400, "IMAGE_EDIT_INVALID_PARAMETERS", 502], [500, "IMAGE_EDIT_UPSTREAM_REJECTED", 502]]) {
  await check(`上游 HTTP ${status} 使用安全错误，不回传供应商原文或密钥`, async () => {
    const mock = mockService(() => response({ error: { message: `echo ${key}` } }, status));
    await expectError(mock.service, input, code, returnedStatus);
  });
}

for (const [name, status, providerError, suffix, expectedText] of [
  ["余额不足不会误报成密钥错误", 403, { code: "AccountOverdueError", message: `Insufficient account balance ${key}` }, "BILLING_REQUIRED", "账户余额"],
  ["模型未开通有独立处理", 400, { code: "ModelNotOpen", message: `Model is not open ${key}` }, "MODEL_ACCESS_DENIED", "模型尚未开通"],
  ["模型不存在提示核实授权而不推断模型下线", 404, { code: "InvalidEndpoint", message: key }, "MODEL_NOT_FOUND", "模型授权"],
  ["HTTP 404 明确未开通时优先指出权限", 404, { code: "AccessDenied.ModelNotOpen", message: key }, "MODEL_ACCESS_DENIED", "模型尚未开通"],
  ["400 模型不存在不误报成分辨率错误", 400, { code: "InvalidParameter", message: `The model does not exist: ${key}` }, "MODEL_NOT_FOUND", "模型或推理接入点不存在"],
  ["API Key 错误优先于权限状态", 403, { code: "InvalidApiKey", message: key }, "AUTH_FAILED", "鉴权失败"],
  ["参数错误只公开已知参数的说明", 400, { code: "InvalidParameter", param: "response_format", message: key }, "INVALID_PARAMETERS", "图片输出格式"],
  ["从错误文本识别参考图参数但不回传原文", 400, { code: "InvalidParameter", message: `Parameter image is invalid: ${key}` }, "INVALID_PARAMETERS", "参考图片"],
  ["内容审核失败有独立提示", 400, { code: "InputImageSensitiveContentDetected", message: key }, "CONTENT_REJECTED", "内容审核"],
  ["服务端错误不误导用户修改接口参数", 503, { code: "InternalServiceError", message: key }, "UPSTREAM_REJECTED", "暂时无法处理"],
]) {
  await check(name, async () => {
    const mock = mockService(() => response({ error: providerError }, status));
    await assert.rejects(mock.service.edit(input), error => {
      assert.equal(error.code, `IMAGE_EDIT_${suffix}`);
      assert.ok(error.message.includes(expectedText));
      assert.ok(error.message.includes(`HTTP ${status}`));
      assert.ok(!error.message.includes(key));
      assert.equal(error.details.providerCode, providerError.code);
      assert.ok(error.message.includes(`错误码：${providerError.code}`));
      return true;
    });
    assert.equal(mock.calls(), 1, "a rejected generation must never auto-retry or use another model");
  });
}

await check("未知供应商错误码和参数不能成为泄漏渠道", async () => {
  const mock = mockService(() => response({ error: { code: key, param: key, message: key } }, 400));
  await assert.rejects(mock.service.edit(input), error => {
    assert.equal(error.code, "IMAGE_EDIT_INVALID_PARAMETERS");
    assert.deepEqual(error.details, { httpStatus: 400 });
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
});

await check("诊断只公开已知错误码、参数和受限请求编号", async () => {
  const requestId = "20261018120000abcdef1234567890";
  const mock = mockService(() => response({ error: { code: "InvalidParameter", param: "image", message: key } }, 400, { "x-request-id": requestId }));
  await assert.rejects(mock.service.edit(input), error => {
    assert.deepEqual(error.details, { httpStatus: 400, providerCode: "InvalidParameter", parameter: "image", requestId });
    assert.ok(error.message.includes("错误码：InvalidParameter"));
    assert.ok(error.message.includes(`请求编号：${requestId}`));
    assert.ok(!error.message.includes(key));
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
});

await check("错误头中的密钥不会被当作请求编号公开", async () => {
  const mock = mockService(() => response({ error: { code: key, param: key, message: key } }, 400, { "x-request-id": key }));
  await assert.rejects(mock.service.edit(input), error => {
    assert.deepEqual(error.details, { httpStatus: 400 });
    return true;
  });
});

await check("非 JSON 拒绝响应仍保留平台 HTTP 状态而不回传原文", async () => {
  const mock = mockService(() => new Response(`<html>${key}</html>`, { status: 403 }));
  await expectError(mock.service, input, "IMAGE_EDIT_MODEL_ACCESS_DENIED", 502);
});

await check("非结构化 404 不武断归为模型 ID 错误", async () => {
  const mock = mockService(() => new Response(`<html>${key}</html>`, { status: 404 }));
  await assert.rejects(mock.service.edit(input), error => {
    assert.equal(error.code, "IMAGE_EDIT_ENDPOINT_NOT_FOUND");
    assert.ok(error.message.includes("不能确认"));
    assert.deepEqual(error.details, { httpStatus: 404 });
    assert.ok(!error.message.includes(key));
    return true;
  });
});

await check("方舟模型或接入点不可访问错误码可用于安全排查", async () => {
  const mock = mockService(() => response({ error: { code: "InvalidEndpointOrModel.NotFound", message: key } }, 404));
  await assert.rejects(mock.service.edit(input), error => {
    assert.equal(error.code, "IMAGE_EDIT_MODEL_NOT_FOUND");
    assert.deepEqual(error.details, { httpStatus: 404, providerCode: "InvalidEndpointOrModel.NotFound" });
    assert.ok(error.message.includes("错误码：InvalidEndpointOrModel.NotFound"));
    assert.ok(error.message.includes("仅凭 404 不能确定模型已下线"));
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
});

await check("图像编辑区分模型 ID 访问禁用与模型不存在", async () => {
  const providerCode = "InvalidEndpointOrModel.ModelIDAccessDisabled";
  const providerMessage = `provider-private-edit-message ${key}`;
  const mock = mockService(() => response({ error: { code: providerCode, message: providerMessage } }, 404));
  await assert.rejects(mock.service.edit(input), error => {
    assert.ok(error instanceof ImageEditError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "IMAGE_EDIT_MODEL_ID_ACCESS_DISABLED");
    assert.deepEqual(error.details, { httpStatus: 404, providerCode });
    assert.ok(error.message.includes(`错误码：${providerCode}`));
    assert.ok(error.message.includes("SEEDREAM_MODEL"));
    assert.ok(!error.message.includes("IMAGE_PROMPT_MODEL"));
    assert.ok(!error.message.includes(providerMessage));
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
  assert.equal(mock.calls(), 1, "disabled model access must not trigger a fallback or retry");
});

await check("错误响应超过 64KB 上限时中止读取并保留安全分类", async () => {
  let cancelled = false;
  const mock = mockService(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; },
  }), { status: 400 }));
  await expectError(mock.service, input, "IMAGE_EDIT_INVALID_PARAMETERS", 502);
  assert.equal(cancelled, true);
});

await check("网络错误不泄漏异常中的密钥", async () => {
  const mock = mockService(() => { throw new Error(`request headers contained ${key}`); });
  await expectError(mock.service, input, "IMAGE_EDIT_UPSTREAM_UNAVAILABLE", 502);
});

await check("上游返回外链时不自动下载，避免任意 URL 抓取", async () => {
  const mock = mockService(() => response({ data: [{ url: "http://127.0.0.1/private" }] }));
  await expectError(mock.service, input, "IMAGE_EDIT_BASE64_REQUIRED", 502);
  assert.equal(mock.calls(), 1);
});

await check("上游重定向不被跟随，不转发认证到新地址", async () => {
  const mock = mockService((_url, options) => {
    assert.equal(options.redirect, "error");
    return new Response(null, { status: 302, headers: { Location: "https://example.com/capture" } });
  });
  await expectError(mock.service, input, "IMAGE_EDIT_UPSTREAM_REJECTED", 502);
  assert.equal(mock.calls(), 1);
});

await check("上游无效 JSON 转换为安全错误", async () => {
  const mock = mockService(() => new Response(`<html>${key}</html>`));
  await expectError(mock.service, input, "IMAGE_EDIT_UPSTREAM_UNAVAILABLE", 502);
});

await check("上游 Content-Length 超限时停止读取", async () => {
  const mock = mockService(() => response({ data: [] }, 200, { "Content-Length": "999999999" }));
  await expectError(mock.service, input, "IMAGE_EDIT_UPSTREAM_UNAVAILABLE", 502);
});

for (const [name, data] of [["拒绝空结果", []], ["拒绝 SVG 结果", [{ b64_json: Buffer.from("<svg/>").toString("base64") }]], ["拒绝无效结果 base64", [{ b64_json: "%%%%" }]], ["拒绝只有供应商错误信息的结果", undefined]]) {
  await check(name, async () => {
    const mock = mockService(() => response({ data, error: { message: key } }));
    await expectError(mock.service, input, "IMAGE_EDIT_INVALID_RESULT", 502);
  });
}

const promptEnv = { SEEDREAM_API_KEY: key, IMAGE_PROMPT_MODEL: "ep-vision-test-model" };
const promptInput = { image, intent: "保留杯子轮廓，改成红色陶瓷", prepareFor3D: true };

async function expectPromptError(service, payload, code, status) {
  await assert.rejects(service.draftPrompt(payload), error => {
    assert.ok(error instanceof ImageEditError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!error.message.includes(key));
    return true;
  });
}

await check("AI 起草与图像编辑的模型配置相互独立", () => {
  const { service } = mockService(() => {}, promptEnv);
  const config = service.configuration();
  assert.equal(config.available, false);
  assert.equal(config.promptAvailable, true);
  assert.equal(config.promptModel, promptEnv.IMAGE_PROMPT_MODEL);
  assert.ok(!JSON.stringify(config).includes(key));
});

for (const model of ["doubao-seedream-4-0-250828", "doubao-seededit-3-0-i2i-250628"]) {
  await check(`不会把 ${model} 图片生成模型当作视觉聊天模型`, async () => {
    const mock = mockService(() => {}, { ...env, IMAGE_PROMPT_MODEL: model });
    assert.equal(mock.service.configuration().available, true);
    assert.equal(mock.service.configuration().promptAvailable, false);
    assert.equal(mock.service.configuration().promptIssue, "IMAGE_PROMPT_MODEL_NEEDS_VISION");
    await expectPromptError(mock.service, promptInput, "IMAGE_PROMPT_INVALID_MODEL", 503);
    assert.equal(mock.calls(), 0);
  });
}

await check("未知自定义接入点不被本地能力猜测误拒绝", () => {
  const mock = mockService(() => {}, { ...env, IMAGE_PROMPT_MODEL: "ep-custom-vision-endpoint" });
  assert.equal(mock.service.configuration().promptAvailable, true);
});

await check("AI 起草提交参考图和编辑意图到视觉聊天接口", async () => {
  const mock = mockService((url, options) => {
    assert.equal(url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.model, promptEnv.IMAGE_PROMPT_MODEL);
    assert.equal(body.messages[0].role, "system");
    assert.deepEqual(body.messages[1].content[1], { type: "image_url", image_url: { url: image } });
    assert.ok(body.messages[1].content[0].text.includes(promptInput.intent));
    assert.ok(body.messages[1].content[0].text.includes("图像转 3D"));
    return response({ choices: [{ message: { content: "  保持杯子轮廓，完善为红色陶瓷杯，使用干净背景。  " } }] });
  }, promptEnv);
  assert.deepEqual(await mock.service.draftPrompt(promptInput), { prompt: "保持杯子轮廓，完善为红色陶瓷杯，使用干净背景。", provider: "火山方舟", model: promptEnv.IMAGE_PROMPT_MODEL });
});

await check("空编辑意图可根据参考图起草", async () => {
  const { service } = mockService((_url, options) => {
    assert.ok(JSON.parse(options.body).messages[1].content[0].text.includes("请观察这张图片"));
    return response({ choices: [{ message: { content: "完善草图，保留主体轮廓。" } }] });
  }, promptEnv);
  assert.equal((await service.draftPrompt({ image, intent: "" })).prompt, "完善草图，保留主体轮廓。");
});

await check("未配置视觉模型时返回明确错误而不伪装 AI", async () => {
  const mock = mockService(() => {}, env);
  await expectPromptError(mock.service, promptInput, "IMAGE_PROMPT_NOT_CONFIGURED", 503);
  assert.equal(mock.calls(), 0);
});

await check("未配置密钥时不会调用起草服务", async () => {
  const mock = mockService(() => {}, { IMAGE_PROMPT_MODEL: "ep-vision-test" });
  await expectPromptError(mock.service, promptInput, "IMAGE_PROMPT_NOT_CONFIGURED", 503);
  assert.equal(mock.calls(), 0);
});

for (const [name, payload, code] of [
  ["起草拒绝超长意图", { ...promptInput, intent: "字".repeat(4001) }, "INVALID_INTENT"],
  ["起草拒绝非字符串意图", { ...promptInput, intent: {} }, "INVALID_INTENT"],
  ["起草拒绝任意外部图片地址", { ...promptInput, image: "http://127.0.0.1/private" }, "INVALID_IMAGE"],
  ["起草拒绝错误 3D 选项类型", { ...promptInput, prepareFor3D: 1 }, "INVALID_PREPARE_FOR_3D"],
]) {
  await check(name, async () => {
    const mock = mockService(() => {}, promptEnv);
    await expectPromptError(mock.service, payload, code, 400);
    assert.equal(mock.calls(), 0);
  });
}

for (const [name, makeResponse, code, status] of [
  ["起草上游鉴权失败不会泄漏错误原文", () => response({ error: key }, 401), "IMAGE_PROMPT_AUTH_FAILED", 502],
  ["起草模型 ID 不存在时提示修正配置", () => response({ error: { code: "InvalidEndpoint", message: key } }, 404), "IMAGE_PROMPT_MODEL_NOT_FOUND", 502],
  ["起草模型未开通和图片编辑错误相互独立", () => response({ error: { code: "ModelNotOpen", message: key } }, 400), "IMAGE_PROMPT_MODEL_ACCESS_DENIED", 502],
  ["起草模型不支持图片时指出图片输入", () => response({ error: { code: "InvalidParameter", param: "messages", message: key } }, 400), "IMAGE_PROMPT_INVALID_PARAMETERS", 502],
  ["起草上游限流有明确反馈", () => response({ error: key }, 429), "IMAGE_PROMPT_RATE_LIMITED", 429],
  ["起草拒绝无效 JSON", () => new Response(key), "IMAGE_PROMPT_UPSTREAM_UNAVAILABLE", 502],
  ["起草拒绝空结果", () => response({ choices: [] }), "IMAGE_PROMPT_INVALID_RESULT", 502],
  ["起草拒绝超长结果", () => response({ choices: [{ message: { content: "字".repeat(4001) } }] }), "IMAGE_PROMPT_INVALID_RESULT", 502],
  ["起草限制供应商响应体大小", () => response({}, 200, { "Content-Length": "999999" }), "IMAGE_PROMPT_UPSTREAM_UNAVAILABLE", 502],
]) {
  await check(name, async () => {
    const { service } = mockService(makeResponse, promptEnv);
    await expectPromptError(service, promptInput, code, status);
  });
}

await check("起草网络错误不会泄漏密钥", async () => {
  const { service } = mockService(() => { throw new Error(key); }, promptEnv);
  await expectPromptError(service, promptInput, "IMAGE_PROMPT_UPSTREAM_UNAVAILABLE", 502);
});

await check("AI 起草区分模型 ID 访问禁用并指出视觉模型配置", async () => {
  const providerCode = "InvalidEndpointOrModel.ModelIDAccessDisabled";
  const providerMessage = `provider-private-prompt-message ${key}`;
  const mock = mockService(() => response({ error: { code: providerCode, message: providerMessage } }, 404), promptEnv);
  await assert.rejects(mock.service.draftPrompt(promptInput), error => {
    assert.ok(error instanceof ImageEditError);
    assert.equal(error.status, 502);
    assert.equal(error.code, "IMAGE_PROMPT_MODEL_ID_ACCESS_DISABLED");
    assert.deepEqual(error.details, { httpStatus: 404, providerCode });
    assert.ok(error.message.includes(`错误码：${providerCode}`));
    assert.ok(error.message.includes("IMAGE_PROMPT_MODEL"));
    assert.ok(!error.message.includes("SEEDREAM_MODEL"));
    assert.ok(!error.message.includes(providerMessage));
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
  assert.equal(mock.calls(), 1, "disabled model access must not trigger a fallback or retry");
});

console.log(`\n${checks} image-edit service checks passed (mock API only; no paid API requests).`);
