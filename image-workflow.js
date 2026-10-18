import { createPinchOwner, MIDDLE_PINCH_START, MIDDLE_PINCH_END } from "./pinch-owner.js?v=20261018-pinch-v4";
const clamp = (value) => Math.max(0, Math.min(1, value));
const REGION_PINCH_START = MIDDLE_PINCH_START;
const REGION_PINCH_END = MIDDLE_PINCH_END;
const REGION_ACTIVATE_MS = 240;
const REGION_RELEASE_MS = 80;
const REGION_TRACKING_GRACE_MS = 300;
const VOICE_SILENCE_MS = 3000;

export function normalizeRegion(start, end) {
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return null;
  const x = Math.min(clamp(start.x), clamp(end.x));
  const y = Math.min(clamp(start.y), clamp(end.y));
  return { x, y, width: Math.abs(clamp(end.x) - clamp(start.x)), height: Math.abs(clamp(end.y) - clamp(start.y)) };
}

export function regionPixelRect(region, width, height) {
  if (!region || ![region.x, region.y, region.width, region.height, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const left = Math.floor(clamp(region.x) * width), top = Math.floor(clamp(region.y) * height);
  const right = Math.ceil(clamp(region.x + Math.max(0, region.width)) * width - 1e-9);
  const bottom = Math.ceil(clamp(region.y + Math.max(0, region.height)) * height - 1e-9);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function buildEditPrompt(intent, prepareFor3D = true) {
  let request = String(intent || "").trim();
  if (!request) return "";
  const common = "以参考图片为基础进行编辑，保留未要求改变的主体轮廓、主要结构和比例。";
  const endings = ["保持画面清晰，不添加未要求的文字或无关物体。", "主体完整、独立、居中，背景简洁，不添加文字或无关物体，便于后续生成三维模型。"];
  // Refinement now writes into the same input. Repeated clicks should replace
  // our own template suffix rather than duplicate it in the user's request.
  for (const ending of endings) {
    const suffix = `\n${common}${ending}`;
    if (request.endsWith(suffix)) request = request.slice(0, -suffix.length).trim();
  }
  return `${request}\n${common}${endings[Number(prepareFor3D)]}`.slice(0, 2000);
}

// No camera pixels enter this module: its only image source is drawingCanvas.
export function createImageWorkflow(options) {
  const { canvas, finishDrawing = () => {}, setStatus = () => {}, onUseFor3D = () => {} } = options;
  const doc = options.doc || globalThis.document;
  const win = options.window || globalThis.window || globalThis;
  const fetchImpl = options.fetchImpl || win.fetch?.bind(win) || globalThis.fetch;
  const $ = (id) => doc.getElementById(id);
  const dialog = $("imageWorkflowDialog");
  const listeners = [];
  const gestureOwner = createPinchOwner();
  let selecting = false, armed = false, pinched = false, drag = null, region = null;
  let activation = null, release = null, lastTrackingAt = null, shortcutNeedsRelease = false, shortcutReserved = false;
  let asset = null, selectedVersionId = null, sequence = 0, opened = false, busy = false;
  let epoch = 0, configSequence = 0, controller = null, recognition = null, pointerId = null;
  let voiceSilenceTimer = null, finishVoice = null, voiceStopping = false;
  const setTimer = (callback, delay) => (win.setTimeout || globalThis.setTimeout)(callback, delay);
  const clearTimer = (timer) => (win.clearTimeout || globalThis.clearTimeout)(timer);
  let config = { available: false, promptAvailable: false };
  const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  const listen = (element, name, callback) => {
    if (!element?.addEventListener) return;
    element.addEventListener(name, callback);
    listeners.push(() => element.removeEventListener?.(name, callback));
  };
  const message = (text, kind = "info") => {
    const node = $("imageEditState");
    if (node) { node.textContent = text; node.dataset.kind = kind; }
  };
  const currentVersion = () => asset?.versions.find((version) => version.id === selectedVersionId) || asset?.source;
  const inputValue = (id) => String($(id)?.value || "").trim();
  const for3D = () => $("prepareImageFor3D")?.checked !== false;
  const block = () => selecting || opened || Boolean(activation) || shortcutReserved;

  function renderSelection() {
    $("selectRegionBtn")?.setAttribute("aria-pressed", String(selecting));
    if ($("cancelRegionBtn")) $("cancelRegionBtn").hidden = !selecting;
    const pixels = regionPixelRect(region, canvas.width, canvas.height);
    const bounds = canvas.getBoundingClientRect();
    const canConfirm = Boolean(pixels && pixels.width >= 8 && pixels.height >= 8 && region.width * bounds.width >= 8 && region.height * bounds.height >= 8);
    if ($("confirmRegionBtn")) { $("confirmRegionBtn").hidden = !selecting; $("confirmRegionBtn").disabled = !canConfirm; }
    const hint = $("regionSelectionHint");
    if (hint) {
      hint.hidden = !selecting && !activation;
      const text = activation ? "保持中指与拇指捏合，稍停进入框选…" : drag ? "保持中指与拇指捏合，移动食指调整选框；松开稍停完成，也可点击“完成截取”。" : armed ? "中指与拇指捏合确定起点，保持捏合移动食指，松开完成；也可用鼠标拖选。" : "先松开中指与拇指，再捏合拖出选框；也可用鼠标拖选。";
      if (hint.textContent !== text) hint.textContent = text;
    }
    const overlay = $("regionSelectionOverlay");
    if (!overlay) return;
    overlay.hidden = !selecting || !region;
    if (region) Object.assign(overlay.style, { left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` });
  }

  function renderAsset() {
    if (!asset) return;
    const selected = currentVersion();
    if ($("sourceRegionImage")) $("sourceRegionImage").src = selected.image;
    if ($("currentRegionLabel")) $("currentRegionLabel").textContent = selected.label;
    if ($("regionDimensions")) $("regionDimensions").textContent = `${selected.width} × ${selected.height} px`;
    const versions = $("imageVersionSelect");
    if (versions) {
      versions.replaceChildren();
      for (const version of asset.versions) {
        const option = doc.createElement("option");
        option.value = version.id; option.textContent = version.label; versions.append(option);
      }
      versions.value = selectedVersionId;
    }
    renderButtons();
  }

  function renderButtons() {
    if ($("editRegionImageBtn")) { $("editRegionImageBtn").disabled = busy || !asset || !config.available; $("editRegionImageBtn").textContent = busy ? "处理中…" : "生成编辑图"; }
    if ($("organizeImagePromptBtn")) { $("organizeImagePromptBtn").disabled = busy || !asset; $("organizeImagePromptBtn").textContent = config.promptAvailable ? "✨ AI 润色" : "简单润色"; }
    if ($("imageVersionSelect")) $("imageVersionSelect").disabled = busy || !asset;
    if ($("downloadRegionBtn")) $("downloadRegionBtn").disabled = !asset;
    if ($("useImageFor3DBtn")) { const ready = Boolean(asset && currentVersion()?.id !== asset.source.id); $("useImageFor3DBtn").hidden = !ready; $("useImageFor3DBtn").disabled = busy || !ready; }
    if ($("voiceImagePromptBtn")) $("voiceImagePromptBtn").disabled = !SpeechRecognition || busy || voiceStopping;
  }

  async function refreshConfig() {
    const requestId = ++configSequence, assetId = asset?.id;
    const isCurrent = () => requestId === configSequence && asset?.id === assetId && opened;
    try {
      const response = await fetchImpl("/api/image-edit/config", { cache: "no-store" });
      if (!response.ok) throw new Error("连接失败");
      const nextConfig = await response.json();
      if (!isCurrent()) return;
      config = nextConfig;
      if ($("imagePromptHelp")) $("imagePromptHelp").textContent = config.promptAvailable ? "AI 润色结合当前图片和文字，可在生成前修改。" : config.promptIssue ? "AI 润色需要视觉理解模型，不能使用图片生成模型；当前使用本地文字模板。" : "简单润色使用本地文字模板。配置视觉模型后可启用 AI 润色。";
      if ($("imageEditConnectionState")) $("imageEditConnectionState").textContent = config.available ? `图像模型已配置：${config.model}；实际可用性以生成结果为准。` : "图像编辑未配置";
      if (!config.available) message("图片已保存在当前预览中。配置 SEEDREAM_API_KEY 与 SEEDREAM_MODEL 并重启服务后，可使用图像编辑；现在可以下载 PNG、整理提示词。");
    } catch {
      if (!isCurrent()) return;
      config = { available: false, promptAvailable: false };
      if ($("imageEditConnectionState")) $("imageEditConnectionState").textContent = "图片编辑服务未连接";
      message("请使用 npm start 启动项目服务。截取和下载 PNG 仍可使用。");
    }
    renderButtons();
  }

  function clearVoiceTimer() {
    if (voiceSilenceTimer !== null) clearTimer(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }

  function stopVoice() {
    clearVoiceTimer(); finishVoice = null; voiceStopping = false;
    if (recognition) {
      const previous = recognition; recognition = null;
      for (const event of ["onresult", "onend", "onerror", "onstart", "onaudiostart", "onspeechstart", "onspeechend", "onsoundstart", "onsoundend", "onnomatch"]) previous[event] = null;
      try { previous.abort?.(); } catch { /* Some browsers already ended capture. */ }
    }
    if ($("voiceImagePromptBtn")) $("voiceImagePromptBtn").textContent = "🎙 语音输入";
  }

  function invalidateRequest() {
    epoch += 1; configSequence += 1; controller?.abort(); controller = null; busy = false; stopVoice(); renderButtons();
  }

  function cancelSelection() {
    if (pointerId !== null) { try { canvas.releasePointerCapture?.(pointerId); } catch { /* The pointer may already have ended. */ } }
    if (activation || pinched) { shortcutNeedsRelease = true; shortcutReserved = true; }
    selecting = false; armed = false; pinched = false; drag = null; region = null; pointerId = null; activation = null; release = null; renderSelection();
  }

  function startSelection(gesturePoint = null) {
    if (opened) return;
    finishDrawing(); selecting = true; armed = false; pinched = false; drag = null; region = null; activation = null; release = null;
    if (gesturePoint) {
      armed = true; pinched = true; drag = { x: clamp(gesturePoint.x), y: clamp(gesturePoint.y) }; region = normalizeRegion(drag, drag);
      shortcutNeedsRelease = true; shortcutReserved = true;
    }
    renderSelection();
    setStatus(gesturePoint ? "已进入截取：保持中指与拇指捏合，移动食指调整选框，松开稍停完成。" : "截取模式：先松开中指与拇指，再捏合拖出矩形，松开稍停完成。也可用鼠标拖选；Esc 取消。");
  }

  function close() {
    cancelSelection();
    invalidateRequest(); opened = false;
    if (typeof dialog?.close === "function") dialog.close();
    else dialog?.removeAttribute("open");
    finishDrawing();
  }

  function open() {
    if (!asset) return;
    finishDrawing(); cancelSelection(); opened = true; renderAsset();
    if (typeof dialog?.showModal === "function") { if (!dialog.open) dialog.showModal(); }
    else dialog?.setAttribute("open", "");
    message("已恢复当前图片素材，可继续编辑、切换版本或下载。");
    void refreshConfig();
  }

  function captureSelection(selectedRegion) {
    const pixels = regionPixelRect(selectedRegion, canvas.width, canvas.height);
    const bounds = canvas.getBoundingClientRect();
    if (!pixels || pixels.width < 8 || pixels.height < 8 || selectedRegion.width * bounds.width < 8 || selectedRegion.height * bounds.height < 8) throw new Error("选区太小，请框选更大的区域。");
    finishDrawing();
    const snapshot = doc.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(pixels.width, pixels.height));
    snapshot.width = Math.max(1, Math.round(pixels.width * scale)); snapshot.height = Math.max(1, Math.round(pixels.height * scale));
    const context = snapshot.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, pixels.x, pixels.y, pixels.width, pixels.height, 0, 0, snapshot.width, snapshot.height);
    const rgba = context.getImageData(0, 0, snapshot.width, snapshot.height).data;
    let hasInk = false;
    for (let index = 3; index < rgba.length; index += 4) if (rgba[index] > 12) { hasInk = true; break; }
    if (!hasInk) throw new Error("选区内没有可见线条，请重新框选。");
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, snapshot.width, snapshot.height);
    context.globalCompositeOperation = "source-over";
    const image = snapshot.toDataURL("image/png");
    if (!image.startsWith("data:image/png;base64,")) throw new Error("PNG 导出失败，请重试。");
    invalidateRequest();
    const id = `region-${++sequence}`;
    const source = { id: `${id}-source`, image, width: snapshot.width, height: snapshot.height, label: "原始选区" };
    asset = { id, source, versions: [source], region: { ...selectedRegion } }; selectedVersionId = source.id;
    if ($("openImageWorkflowBtn")) $("openImageWorkflowBtn").hidden = false;
    cancelSelection(); opened = true;
    if ($("imagePromptIntent")) $("imagePromptIntent").value = "";
    if ($("region3DPrompt")) $("region3DPrompt").value = "";
    renderAsset();
    if (typeof dialog?.showModal === "function") { if (!dialog.open) dialog.showModal(); }
    else dialog?.setAttribute("open", "");
    message("已截取选区。填写想怎么修改，编辑结果满意后可继续生成 3D。");
    void refreshConfig();
    return asset;
  }

  function commitSelection() {
    const selected = region;
    drag = null; pinched = false; armed = false; release = null; shortcutNeedsRelease = true;
    try { return captureSelection(selected); }
    catch (error) { region = null; renderSelection(); setStatus(error.message, "error"); }
  }

  function handleTracking({ point, pinchRatio, selectionPinchRatio, pinchOwner, timestamp = win.performance?.now?.() ?? Date.now(), present = true, enabled = true, workspace = "draw" } = {}) {
    const owner = pinchOwner ?? gestureOwner.update({ indexRatio: pinchRatio, middleRatio: selectionPinchRatio, present, enabled: enabled && workspace === "draw" });
    if (!enabled || workspace !== "draw") {
      cancelSelection(); shortcutReserved = false; shortcutNeedsRelease = true; lastTrackingAt = null; return opened;
    }
    if (pointerId !== null) return true;
    const valid = present && point && [point.x, point.y, selectionPinchRatio, timestamp].every(Number.isFinite);
    const gap = lastTrackingAt === null ? Infinity : timestamp - lastTrackingAt;
    if (!valid) {
      release = null; activation = null;
      if (gap > REGION_TRACKING_GRACE_MS) {
        activation = null; shortcutReserved = false; shortcutNeedsRelease = true;
        drag = null; region = null; pinched = false; armed = false; renderSelection();
      }
      return block();
    }
    // Lost observations never count as a release. A brief gap preserves the
    // last rectangle, but confirmation still needs visible open-finger frames.
    if (gap > REGION_TRACKING_GRACE_MS) {
      activation = null; release = null;
      if (lastTrackingAt !== null && pointerId === null) { drag = null; region = null; pinched = false; armed = false; }
    }
    lastTrackingAt = timestamp;
    if (selectionPinchRatio >= REGION_PINCH_END) { shortcutNeedsRelease = false; shortcutReserved = false; }
    if (opened) { activation = null; return true; }
    if (!selecting) {
      // The shared owner may rearm the same drawing finger after its own
      // release. Do not keep a stale crop reservation from that pause.
      if (owner === "index" && !shortcutNeedsRelease) shortcutReserved = false;
      if (owner === "ambiguous" || owner === "release") {
        shortcutReserved = true; activation = null; renderSelection(); return true;
      }
      const active = owner === "middle" && selectionPinchRatio < (activation ? REGION_PINCH_END : REGION_PINCH_START);
      if (shortcutNeedsRelease || !active) { activation = null; renderSelection(); return block(); }
      if (!activation) { finishDrawing(); activation = { since: timestamp, frames: 0 }; }
      activation.frames += 1;
      if (timestamp - activation.since >= REGION_ACTIVATE_MS && activation.frames >= 3) startSelection(point);
      else renderSelection();
      return true;
    }
    const active = selectionPinchRatio < (pinched ? REGION_PINCH_END : REGION_PINCH_START) && (pinched || owner === "middle");
    if (!armed) { if (selectionPinchRatio >= REGION_PINCH_END) armed = true; renderSelection(); return true; }
    if (active && !pinched) drag = { x: clamp(point.x), y: clamp(point.y) };
    if (active && drag) { release = null; region = normalizeRegion(drag, point); }
    if (!active && pinched && drag) {
      if (!release) release = { since: timestamp, frames: 0 };
      release.frames += 1;
      // Freeze the last pinched corner: opening the hand can move the cursor.
      if (timestamp - release.since >= REGION_RELEASE_MS && release.frames >= 2) commitSelection();
      renderSelection(); return true;
    }
    pinched = active; renderSelection(); return true;
  }

  async function normalizeImage(image) {
    if (!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\r\n]+$/.test(image || "") || image.length > 24 * 1024 * 1024) throw new Error("编辑服务未返回有效图片。");
    if (options.decodeImage) return options.decodeImage(image);
    const ImageClass = win.Image || globalThis.Image;
    const bitmap = new ImageClass();
    await new Promise((resolve, reject) => { bitmap.onload = resolve; bitmap.onerror = () => reject(new Error("编辑结果无法解码为图片。")); bitmap.src = image; });
    if (!bitmap.naturalWidth || !bitmap.naturalHeight || bitmap.naturalWidth * bitmap.naturalHeight > 24_000_000) throw new Error("编辑结果的图片尺寸不受支持。");
    const output = doc.createElement("canvas");
    const scale = Math.min(1, 2048 / Math.max(bitmap.naturalWidth, bitmap.naturalHeight));
    output.width = Math.max(1, Math.round(bitmap.naturalWidth * scale)); output.height = Math.max(1, Math.round(bitmap.naturalHeight * scale));
    output.getContext("2d").drawImage(bitmap, 0, 0, output.width, output.height);
    const normalized = output.toDataURL("image/png");
    if (normalized.length > 13_981_016) throw new Error("编辑结果的 PNG 超过 10 MB，请尝试更简洁的图片或较低分辨率。");
    return { image: normalized, width: output.width, height: output.height };
  }

  async function request(path, body, operation) {
    if (busy) return;
    const requestEpoch = ++epoch, assetId = asset?.id;
    controller = new (win.AbortController || globalThis.AbortController)();
    busy = true; stopVoice(); renderButtons();
    try {
      const response = await fetchImpl(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const payload = await response.json();
      if (epoch !== requestEpoch || asset?.id !== assetId || !opened) return;
      if (!response.ok || payload.error) throw new Error(payload.message || "服务请求失败，请稍后重试。");
      await operation(payload, () => epoch === requestEpoch && asset?.id === assetId && opened);
    } catch (error) {
      if (epoch === requestEpoch && error.name !== "AbortError") message(error.message || "服务请求失败。", "error");
    } finally {
      if (epoch === requestEpoch) { busy = false; controller = null; renderButtons(); }
    }
  }

  async function organizePrompt() {
    if (!asset || busy) return;
    const intent = inputValue("imagePromptIntent");
    if (!config.promptAvailable) {
      const prompt = buildEditPrompt(intent, for3D());
      if (!prompt) { message("先填写想怎么修改，再整理提示词。", "error"); return; }
      $("imagePromptIntent").value = prompt;
      message("已润色修改要求，可以继续调整。"); return;
    }
    message("AI 正在结合当前图片起草提示词…");
    const previousPrompt = $("imagePromptIntent").value;
    await request("/api/image-edit/prompt", { image: currentVersion().image, intent, prepareFor3D: for3D() }, async (payload) => {
      if (typeof payload.prompt !== "string" || !payload.prompt.trim()) throw new Error("AI 未返回提示词，请重试或手动输入。");
      if ($("imagePromptIntent").value !== previousPrompt) { message("已保留你刚输入的修改要求；需要 AI 润色时可再次点击。"); return; }
      $("imagePromptIntent").value = payload.prompt.slice(0, 2000);
      message("已润色，可直接修改后生成编辑图。");
    });
  }

  async function editImage() {
    if (!asset || busy) return;
    if (!config.available) { message("请先配置 Seedream API Key 与模型 ID。", "error"); return; }
    const prompt = inputValue("imagePromptIntent");
    if (!prompt) { message("请填写或说出修改要求。", "error"); return; }
    const sourceId = currentVersion().id;
    message("正在生成编辑图，请稍候…");
    await request("/api/image-edit", { image: currentVersion().image, prompt, prepareFor3D: for3D() }, async (payload, isCurrent) => {
      const result = await normalizeImage(payload.image);
      if (!isCurrent()) return;
      const version = { ...result, id: `${asset.id}-edit-${++sequence}`, label: `编辑结果 ${asset.versions.length}`, prompt, sourceId };
      asset.versions.push(version);
      // Keep the original and the latest seven edits to bound in-memory images.
      if (asset.versions.length > 8) asset.versions.splice(1, asset.versions.length - 8);
      selectedVersionId = version.id; renderAsset();
      message("编辑完成。可继续修改、下载 PNG，或使用选定结果生成 3D。", "active");
    });
  }

  async function useFor3D() {
    const selected = currentVersion();
    if (!selected || selected.id === asset.source.id) { message("请先编辑图片，再选择编辑结果生成 3D。", "error"); return; }
    const base64 = selected.image.split(",")[1];
    const binary = (win.atob || globalThis.atob)(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const FileClass = win.File || globalThis.File;
    const file = new FileClass([bytes], `${asset.id}-${selected.id}.png`, { type: "image/png" });
    const handoff = { file, image: selected.image, label: selected.label, prompt: inputValue("region3DPrompt"), assetId: asset.id, versionId: selected.id };
    close();
    await onUseFor3D(handoff);
  }

  function download() {
    const selected = currentVersion(); if (!selected) return;
    const link = doc.createElement("a"); link.href = selected.image; link.download = `${asset.id}-${selected.id}.png`;
    doc.body.append(link); link.click(); link.remove?.();
  }

  function startVoice() {
    if (!SpeechRecognition || !opened || busy) return;
    if (recognition) { finishVoice?.("manual"); return; }
    try {
      const session = new SpeechRecognition(); recognition = session;
      session.lang = "zh-CN"; session.interimResults = true; session.continuous = true;
      const sessionAssetId = asset.id;
      const isCurrent = () => recognition === session && opened && asset?.id === sessionAssetId;
      const received = new Set();
      let speaking = false, stopReason = null, hadText = false, failed = false;
      const showVoiceState = (text) => { if ($("voicePromptState")) $("voicePromptState").textContent = text; };
      finishVoice = (reason) => {
        if (!isCurrent() || voiceStopping) return;
        clearVoiceTimer(); voiceStopping = true; stopReason = reason;
        showVoiceState(reason === "silence" ? "静音 3 秒，正在结束语音…" : "正在结束语音…");
        if ($("voiceImagePromptBtn")) $("voiceImagePromptBtn").textContent = "结束中…";
        renderButtons();
        // stop() lets the browser deliver its last final transcript. Aborting
        // here would discard the final words just before the silence timeout.
        if (typeof session.stop === "function") {
          try { session.stop(); }
          catch { stopVoice(); showVoiceState("语音已结束，已转写文字保留。"); renderButtons(); }
        }
        else { stopVoice(); renderButtons(); }
      };
      const armSilenceTimer = () => {
        if (!isCurrent() || voiceStopping) return;
        clearVoiceTimer();
        voiceSilenceTimer = setTimer(() => { voiceSilenceTimer = null; if (isCurrent()) finishVoice?.("silence"); }, VOICE_SILENCE_MS);
      };
      const voiceStarted = () => { if (isCurrent() && !voiceStopping) armSilenceTimer(); };
      const speechStarted = () => { if (isCurrent() && !voiceStopping) { speaking = true; clearVoiceTimer(); } };
      const speechEnded = () => { if (isCurrent() && !voiceStopping) { speaking = false; armSilenceTimer(); } };
      session.onstart = voiceStarted;
      session.onaudiostart = voiceStarted;
      session.onspeechstart = speechStarted;
      session.onsoundstart = speechStarted;
      session.onspeechend = speechEnded;
      session.onsoundend = speechEnded;
      session.onnomatch = speechEnded;
      session.onresult = (event) => {
        if (!isCurrent()) return;
        const parts = [];
        for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal === false || received.has(index)) continue;
          const transcript = String(result[0]?.transcript || "").trim();
          if (transcript) { received.add(index); parts.push(transcript); }
        }
        if (parts.length) {
          const input = $("imagePromptIntent");
          input.value = [inputValue("imagePromptIntent"), ...parts].filter(Boolean).join(" ").slice(0, Number(input.maxLength) > 0 ? input.maxLength : 2000);
          hadText = true;
          if (!voiceStopping) showVoiceState("已记下；继续说，或静音 3 秒结束。");
        }
        if (!speaking && !voiceStopping) armSilenceTimer();
      };
      session.onerror = (event) => {
        if (!isCurrent()) return;
        failed = true;
        showVoiceState(event.error === "no-speech" ? "未检测到语音，已结束。" : `语音未完成（${event.error || "未知原因"}），可直接输入。`);
        stopVoice(); renderButtons();
      };
      session.onend = () => {
        if (!isCurrent()) return;
        clearVoiceTimer(); recognition = null; finishVoice = null; voiceStopping = false;
        if ($("voiceImagePromptBtn")) $("voiceImagePromptBtn").textContent = "🎙 语音输入";
        if (!failed) showVoiceState(stopReason === "silence" ? hadText ? "静音 3 秒，语音已结束，文字可继续修改。" : "静音 3 秒，语音已结束。" : hadText ? "语音已填入，可继续修改。" : "语音已结束，可直接输入修改要求。");
        renderButtons();
      };
      $("voiceImagePromptBtn").textContent = "■ 停止语音";
      showVoiceState("正在聆听，静音 3 秒自动结束。");
      session.start();
    } catch { stopVoice(); if ($("voicePromptState")) $("voicePromptState").textContent = "此浏览器无法启用语音，可手动输入或使用 Mac 听写。"; }
  }

  listen($("selectRegionBtn"), "click", () => selecting ? cancelSelection() : startSelection());
  listen($("cancelRegionBtn"), "click", cancelSelection);
  listen($("confirmRegionBtn"), "click", () => { if (selecting && region) commitSelection(); });
  listen($("openImageWorkflowBtn"), "click", open);
  listen($("returnToImageWorkflowBtn"), "click", open);
  listen($("closeImageWorkflowBtn"), "click", close);
  listen(dialog, "cancel", (event) => { event.preventDefault(); close(); });
  listen(dialog, "close", () => { if (opened) { opened = false; invalidateRequest(); finishDrawing(); } });
  listen($("organizeImagePromptBtn"), "click", () => { void organizePrompt(); });
  listen($("voiceImagePromptBtn"), "click", startVoice);
  listen($("editRegionImageBtn"), "click", () => { void editImage(); });
  listen($("useImageFor3DBtn"), "click", () => { void useFor3D().catch((error) => message(error.message, "error")); });
  listen($("downloadRegionBtn"), "click", download);
  listen($("imageVersionSelect"), "change", () => { if (!busy) { selectedVersionId = $("imageVersionSelect").value; renderAsset(); } });
  listen(doc, "keydown", (event) => { if (event.key === "Escape" && selecting) { cancelSelection(); event.preventDefault(); } });
  const pointerPoint = (event) => { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; };
  listen(canvas, "pointerdown", (event) => {
    if (!selecting || event.button !== 0) return;
    event.preventDefault(); pointerId = event.pointerId; activation = null; release = null; armed = true; drag = pointerPoint(event); region = normalizeRegion(drag, drag); pinched = true;
    canvas.setPointerCapture?.(pointerId); renderSelection();
  });
  listen(canvas, "pointermove", (event) => { if (selecting && drag && event.pointerId === pointerId) { region = normalizeRegion(drag, pointerPoint(event)); renderSelection(); } });
  listen(canvas, "pointerup", (event) => { if (selecting && drag && event.pointerId === pointerId) { region = normalizeRegion(drag, pointerPoint(event)); pointerId = null; commitSelection(); } });
  listen(canvas, "pointercancel", () => { drag = null; region = null; pinched = false; armed = false; pointerId = null; release = null; renderSelection(); });
  if ($("voicePromptState")) $("voicePromptState").textContent = SpeechRecognition ? "语音需浏览器麦克风权限；也可直接输入。" : "此浏览器未提供语音识别，可手动输入或使用 Mac 听写。";
  renderButtons(); renderSelection();
  return {
    isSelecting: () => selecting, isBlocking: block, isOpen: () => opened, isActivating: () => Boolean(activation), startSelection, cancelSelection, handleTracking, captureSelection, close, open,
    getState: () => ({ selection: selecting, opened, activating: Boolean(activation), drag: drag && { ...drag }, region: region && { ...region }, asset: asset && JSON.parse(JSON.stringify(asset)), selectedVersionId, busy, voiceSupported: Boolean(SpeechRecognition) }),
    destroy() { close(); cancelSelection(); listeners.forEach((remove) => remove()); }
  };
}
