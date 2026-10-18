import assert from "node:assert/strict";
import { File } from "node:buffer";
import { createImageWorkflow, normalizeRegion, regionPixelRect, buildEditPrompt } from "../image-workflow.js";

// Exercise selections and asynchronous requests with the actual workflow module.
// The canvas is a deterministic test double: these are not browser pixel tests.
const reports = [];
async function test(name, callback) {
  try { await callback(); reports.push({ name, pass: true }); }
  catch (error) { reports.push({ name, pass: false, error: error.stack }); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const png = value => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
const response = body => ({ ok: true, json: async () => body });
const config = { available: true, provider: "Seedream", model: "test-image-editor", promptAvailable: false };
const sampleRegion = { x: .1, y: .1, width: .5, height: .5 };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function environment({ ink = true, fetchImpl, speech = false } = {}) {
  const legacyIds = new Set(["imageEditPrompt", "editRegionThen3DBtn", "restoreRegionSourceBtn", "editedRegionImage", "editedRegionCard"]);
  let now = 0, nextTimer = 1;
  const timers = new Map();
  const clock = {
    setTimeout(callback, delay = 0) { const id = nextTimer++; timers.set(id, { callback, deadline: now + Number(delay) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, task]) => task.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline || a[0] - b[0])[0];
        if (!due) break;
        now = due[1].deadline; timers.delete(due[0]); due[1].callback();
      }
      now = target;
    },
    get pending() { return timers.size; }
  };
  const elements = new Map(), captures = [], requests = [], messages = [], handedOff = [];
  let finishCount = 0;
  class Node {
    constructor(tag = "div", id = "") {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.events = new Map();
      this.dataset = {}; this.style = {}; this.attrs = {}; this.textContent = ""; this.value = "";
      this.hidden = false; this.disabled = false; this.checked = false; this.files = [];
      this.width = 900; this.height = 550; this.clientWidth = 900; this.clientHeight = 550;
      this.ink = ink; this.imageToken = "initial ink";
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, force) => { const value = force ?? !classes.has(name); if (value) classes.add(name); else classes.delete(name); return value; }
      };
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, []); this.events.get(type).push(handler); }
    removeEventListener(type, handler) { this.events.set(type, (this.events.get(type) || []).filter(item => item !== handler)); }
    dispatch(type, extra = {}) { return Promise.all((this.events.get(type) || []).map(handler => handler({ target: this, currentTarget: this, preventDefault() {}, ...extra }))); }
    click() { if (this.disabled) return Promise.resolve(); return this.dispatch("click"); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    getContext() {
      const node = this;
      return {
        clearRect() { node.ink = false; }, fillRect() {}, save() {}, restore() {}, scale() {}, translate() {},
        drawImage(source, ...args) { node.ink = source.ink; node.imageToken = source.imageToken; captures.push({ source, args, target: node }); },
        getImageData(x, y, width, height) {
          const data = new Uint8ClampedArray(width * height * 4);
          if (node.ink) { data[0] = 55; data[1] = 180; data[2] = 120; data[3] = 255; }
          return { data, width, height };
        }
      };
    }
    toDataURL() { return png(this.imageToken); }
    toBlob(callback) { callback(new Blob([this.imageToken], { type: "image/png" })); }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Node("div", id)); return elements.get(id); };
  const doc = {
    getElementById: id => legacyIds.has(id) ? null : get(id),
    createElement: tag => new Node(tag),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    body: new Node("body")
  };
  const speechInstances = [];
  class Speech {
    constructor() { speechInstances.push(this); this.active = false; }
    start() { this.active = true; this.onstart?.(); }
    stop() {
      this.active = false; this.stopped = true;
      queueMicrotask(() => {
        if (this.finalTranscript) this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: this.finalTranscript }, length: 1, isFinal: true }] });
        this.onend?.();
      });
    }
    abort() { this.active = false; this.aborted = true; this.onend?.(); }
  }
  const window = {
    devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, URL, Blob, File,
    Image: class {
      constructor() { this.width = this.naturalWidth = 640; this.height = this.naturalHeight = 480; }
      set src(value) { this.value = value; this.imageToken = Buffer.from(value.split(",")[1], "base64").toString(); this.ink = true; queueMicrotask(() => this.onload?.()); }
    },
    ...(speech ? { SpeechRecognition: Speech } : {})
  };
  const canvas = new Node("canvas", "drawingCanvas");
  const workflow = createImageWorkflow({
    canvas, doc, window,
    fetchImpl: async (...args) => { requests.push(args); return fetchImpl ? fetchImpl(...args) : { ok: true, json: async () => ({ available: false }) }; },
    finishDrawing: () => { finishCount += 1; },
    setStatus: (...args) => messages.push(args),
    onUseFor3D: value => handedOff.push(value)
  });
  let timestamp = 0;
  const track = (point, selectionPinchRatio, rest = {}) => {
    timestamp = rest.timestamp ?? timestamp + 100;
    return workflow.handleTracking({ point, selectionPinchRatio, pinchRatio: .8, timestamp, ...rest });
  };
  const arm = () => { workflow.startSelection(); track({ x: .1, y: .1 }, .8); };
  const release = (point, rest = {}) => { track(point, .8, rest); track(point, .8); };
  return { workflow, get, elements, captures, requests, messages, handedOff, canvas, speechInstances, clock, track, arm, release, get finishCount() { return finishCount; } };
}

await test("selection normalizes reverse drags and clamps them to canvas bounds", () => {
  assert.deepEqual(normalizeRegion({ x: .8, y: .9 }, { x: .2, y: .3 }), { x: .2, y: .3, width: .6000000000000001, height: .6000000000000001 });
  assert.deepEqual(normalizeRegion({ x: -1, y: -.5 }, { x: 2, y: 1.5 }), { x: 0, y: 0, width: 1, height: 1 });
});

await test("pixel crop rounds outward using actual backing pixels", () => {
  assert.deepEqual(regionPixelRect({ x: .101, y: .203, width: .303, height: .406 }, 1800, 1100), { x: 181, y: 223, width: 547, height: 447 });
  assert.deepEqual(regionPixelRect({ x: 0, y: 0, width: 1, height: 1 }, 1800, 1100), { x: 0, y: 0, width: 1800, height: 1100 });
  assert.deepEqual(regionPixelRect({ x: .1, y: .2, width: .5, height: .4 }, 1800, 1100), { x: 180, y: 220, width: 900, height: 440 }, "floating point addition must not add an extra pixel row");
});

await test("prompt assistance preserves the user's actual request", () => {
  const intent = "把鸟变成红色陶瓷，胸前加一个爱心";
  assert(buildEditPrompt(intent, false).includes(intent));
  assert(buildEditPrompt(intent, true).includes(intent));
  assert.notEqual(buildEditPrompt(intent, true), buildEditPrompt(intent, false));
  assert.equal(buildEditPrompt("", false), "", "template assistance must ask for an intent rather than invent one");
});

await test("refining the shared input repeatedly does not duplicate the template", () => {
  const request = "把爱心改成红色陶瓷";
  const first = buildEditPrompt(request, false);
  assert.equal(buildEditPrompt(first, false), first);
  assert.equal(buildEditPrompt(first, true), buildEditPrompt(request, true));
  assert.equal(buildEditPrompt(buildEditPrompt(request, true), false), first);
});

await test("entering selection ends any drawing and consumes a previously held pinch", async () => {
  const r = environment();
  r.workflow.startSelection();
  assert(r.finishCount > 0); assert(r.workflow.isSelecting()); assert(r.workflow.isBlocking());
  r.track({ x: .1, y: .1 }, .1); r.track({ x: .8, y: .8 }, .1);
  assert.equal(r.workflow.getState().drag, null);
  assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .1, y: .1 }, .8);
  r.track({ x: .1, y: .1 }, .1); r.track({ x: .8, y: .8 }, .1);
  assert(r.workflow.getState().drag);
  assert.equal(r.workflow.getState().asset, null);
  r.workflow.destroy();
});

await test("middle-thumb shortcut waits for deliberate contact and blocks ink during recognition", () => {
  const r = environment();
  r.track({ x: .2, y: .2 }, .1, { timestamp: 100 });
  assert(!r.workflow.isSelecting()); assert(r.workflow.isBlocking());
  r.track({ x: .21, y: .21 }, .1, { timestamp: 220 });
  assert(!r.workflow.isSelecting(), "two frames cannot activate the shortcut");
  r.track({ x: .22, y: .22 }, .1, { timestamp: 340 });
  assert(r.workflow.isSelecting()); assert(r.workflow.getState().drag);
  assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .7, y: .8 }, .1, { timestamp: 360 });
  assert.equal(r.workflow.getState().asset, null, "held middle pinch drags without capture");
  r.workflow.destroy();
});

await test("shortcut rejects incidental, ambiguous, paused, model, and modal contacts", async () => {
  for (const rest of [{ pinchRatio: .12 }, { enabled: false }, { workspace: "model" }]) {
    const r = environment();
    for (const timestamp of [100, 220, 340, 460]) r.track({ x: .2, y: .2 }, .1, { timestamp, ...rest });
    assert(!r.workflow.isSelecting()); assert.equal(r.workflow.getState().drag, null);
    r.workflow.destroy();
  }
  const brief = environment();
  brief.track({ x: .2, y: .2 }, .1, { timestamp: 100 });
  brief.track({ x: .2, y: .2 }, .8, { timestamp: 150 });
  assert(!brief.workflow.isSelecting()); assert(!brief.workflow.isBlocking()); brief.workflow.destroy();
  const modal = environment(); await modal.workflow.captureSelection(sampleRegion);
  for (const timestamp of [100, 220, 340]) modal.track({ x: .2, y: .2 }, .1, { timestamp });
  assert(!modal.workflow.isSelecting()); assert.equal(modal.workflow.getState().drag, null); modal.workflow.destroy();
});

await test("middle shortcut keeps its strict contact boundary", () => {
  const boundary = environment();
  for (const timestamp of [100, 220, 340]) boundary.track({ x: .2, y: .2 }, .24, { timestamp });
  assert(!boundary.workflow.isSelecting()); assert(!boundary.workflow.isBlocking()); boundary.workflow.destroy();
  const r = environment();
  for (const timestamp of [100, 220, 340]) r.track({ x: .2, y: .2 }, .239, { timestamp });
  assert(r.workflow.isSelecting()); r.workflow.destroy();
});

await test("ambiguous index and middle contacts reserve input without beginning a crop", () => {
  for (const [middleRatio, indexRatio] of [[.125, .125], [.1, .12]]) {
    const r = environment();
    for (const timestamp of [100, 220, 340, 460]) {
      r.track({ x: .2, y: .2 }, middleRatio, { timestamp, pinchRatio: indexRatio });
      assert(!r.workflow.isSelecting()); assert(r.workflow.isBlocking());
      assert.equal(r.workflow.getState().drag, null); assert.equal(r.workflow.getState().asset, null);
    }
    r.track({ x: .2, y: .2 }, .8, { timestamp: 560, pinchRatio: .8 });
    assert(!r.workflow.isBlocking(), "visible release must clear the ambiguity reservation");
    for (const timestamp of [660, 780, 900]) r.track({ x: .2, y: .2 }, .1, { timestamp });
    assert(r.workflow.isSelecting(), "a fresh clear middle pinch can select after release");
    r.workflow.destroy();
  }
});

await test("selection uses middle contact independently of index writing pinch", () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .8, { pinchRatio: .1 });
  r.track({ x: .7, y: .7 }, .8, { pinchRatio: .1 });
  assert.equal(r.workflow.getState().drag, null, "index-thumb writing contact must not drag a selection");
  r.track({ x: .2, y: .2 }, .1);
  assert.equal(r.workflow.getState().drag, null, "a held writing contact cannot switch fingers without release");
  r.track({ x: .2, y: .2 }, .8);
  r.track({ x: .2, y: .2 }, .1);
  r.track({ x: .7, y: .7 }, .1);
  assert(r.workflow.getState().drag); assert.equal(r.workflow.getState().asset, null); r.workflow.destroy();
});

await test("an index repinch clears its released-input reservation while the middle stays folded", () => {
  const r = environment();
  for (let stroke = 0; stroke < 3; stroke += 1) {
    r.track({ x: .2, y: .2 }, .28, { pinchRatio: .1 });
    assert(!r.workflow.isBlocking(), "confirmed index writing must not retain a prior release reservation");
    assert(!r.workflow.isSelecting());
    r.track({ x: .2, y: .2 }, .28, { pinchRatio: .35 });
    assert(r.workflow.isBlocking(), "the release frame still reserves uncertain input");
    assert.equal(r.workflow.getState().drag, null);
    assert.equal(r.workflow.getState().asset, null);
  }
  r.workflow.destroy();
});

await test("selection release requires 80 ms and resets when contact returns", async () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .1, { timestamp: 200 });
  r.track({ x: .7, y: .7 }, .1, { timestamp: 220 });
  r.track({ x: .9, y: .9 }, .4, { timestamp: 240 });
  r.track({ x: .9, y: .9 }, .4, { timestamp: 300 });
  assert.equal(r.workflow.getState().asset, null, "multiple frames shorter than 80 ms cannot commit");
  r.track({ x: .75, y: .75 }, .1, { timestamp: 310 });
  r.track({ x: .9, y: .9 }, .4, { timestamp: 320 });
  r.track({ x: .9, y: .9 }, .4, { timestamp: 400 }); await tick();
  assert(r.workflow.getState().asset);
  assert(Math.abs(r.workflow.getState().asset.region.width - .55) < 1e-9);
  r.workflow.destroy();
});

await test("middle release hysteresis tolerates contact noise but opens at the exact 0.40 boundary", () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .1, { timestamp: 200 });
  for (const [index, ratio] of [.24, .30, .399].entries()) r.track({ x: .6 + index * .05, y: .6 + index * .05 }, ratio, { timestamp: 220 + index * 20 });
  assert(r.workflow.getState().drag); assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .95, y: .95 }, .4, { timestamp: 280 });
  r.track({ x: .95, y: .95 }, .4, { timestamp: 360 });
  assert(r.workflow.getState().asset); assert(Math.abs(r.workflow.getState().asset.region.width - .5) < 1e-9);
  r.workflow.destroy();
});

await test("short hand dropout preserves a rectangle and cannot itself complete it", async () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .1, { timestamp: 200 });
  r.track({ x: .7, y: .7 }, .1, { timestamp: 220 });
  r.track(null, Infinity, { present: false, timestamp: 280 });
  r.track(null, Infinity, { present: false, timestamp: 480 }); await tick();
  assert(r.workflow.getState().drag); assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .75, y: .75 }, .1, { timestamp: 500 });
  r.release({ x: .9, y: .9 }, { timestamp: 520 }); await tick();
  assert(r.workflow.getState().asset); assert(Math.abs(r.workflow.getState().asset.region.width - .55) < 1e-9);
  r.workflow.destroy();
});

await test("explicit confirmation captures a valid held rectangle without requiring release", async () => {
  const r = environment(); r.arm();
  assert(r.get("confirmRegionBtn").disabled);
  r.track({ x: .2, y: .2 }, .1); r.track({ x: .7, y: .7 }, .1);
  assert.equal(r.get("confirmRegionBtn").disabled, false);
  await r.get("confirmRegionBtn").click(); await tick();
  assert(r.workflow.getState().asset); assert(!r.workflow.isSelecting()); assert(r.get("imageWorkflowDialog").open);
  r.workflow.destroy();
});

await test("held shortcut cannot retrigger after cancellation until middle fingers visibly release", () => {
  const r = environment();
  for (const timestamp of [100, 220, 340]) r.track({ x: .2, y: .2 }, .1, { timestamp });
  assert(r.workflow.isSelecting()); r.workflow.cancelSelection();
  for (const timestamp of [400, 520, 640]) r.track({ x: .4, y: .4 }, .1, { timestamp });
  assert(!r.workflow.isSelecting());
  r.track({ x: .4, y: .4 }, .8, { timestamp: 740 });
  for (const timestamp of [840, 960, 1080]) r.track({ x: .2, y: .2 }, .1, { timestamp });
  assert(r.workflow.isSelecting()); r.workflow.destroy();
});

await test("stable middle-thumb release confirms the last held rectangle", async () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .3 }, .1); r.track({ x: .7, y: .8 }, .2);
  assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .95, y: .95 }, .8);
  assert.equal(r.workflow.getState().asset, null, "one open sample cannot confirm");
  r.track({ x: .99, y: .99 }, .8); await tick();
  const state = r.workflow.getState();
  assert(state.asset?.source?.image?.startsWith("data:image/png;base64,"));
  assert(Math.abs(state.asset.region.x - .2) < 1e-9);
  assert(Math.abs(state.asset.region.width - .5) < 1e-9);
  assert.equal(state.drag, null);
  assert.equal(state.selectedVersionId, state.asset.source.id);
  r.workflow.destroy();
});

await test("prolonged loss cancels a drag without converting it into a release", async () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .1); r.track({ x: .8, y: .8 }, .1);
  r.track(null, Infinity, { present: false, timestamp: 700 }); await tick();
  assert.equal(r.workflow.getState().drag, null); assert.equal(r.workflow.getState().asset, null);
  r.release({ x: .8, y: .8 }); await tick();
  assert.equal(r.workflow.getState().asset, null);
  r.workflow.destroy();
});

await test("paused or non-drawing tracking cannot confirm a crop", async () => {
  for (const state of [{ enabled: false }, { workspace: "model" }]) {
    const r = environment(); r.arm();
    r.track({ x: .2, y: .2 }, .1); r.track({ x: .8, y: .8 }, .1);
    r.track({ x: .8, y: .8 }, .8, state); await tick();
    assert.equal(r.workflow.getState().asset, null); assert.equal(r.workflow.getState().drag, null);
    r.workflow.destroy();
  }
});

await test("tiny and blank selections are rejected without creating a usable asset", async () => {
  for (const [ink, region] of [[true, { x: .2, y: .2, width: .001, height: .001 }], [false, { x: .2, y: .2, width: .5, height: .5 }]]) {
    const r = environment({ ink });
    assert.throws(() => r.workflow.captureSelection(region), /选区/); await tick();
    assert.equal(r.workflow.getState().asset, null);
    r.workflow.destroy();
  }
});

await test("capture uses normalized canvas coordinates independently of CSS size", async () => {
  const r = environment(); r.canvas.width = 1800; r.canvas.height = 1100;
  await r.workflow.captureSelection({ x: .1, y: .2, width: .5, height: .3 });
  const draw = r.captures.find(item => item.source === r.canvas);
  assert(draw, "capture must copy the drawing canvas");
  assert.deepEqual(draw.args.slice(0, 4), [180, 220, 900, 330]);
  const asset = r.workflow.getState().asset;
  assert.equal(asset.source.width, 900); assert.equal(asset.source.height, 330);
  r.workflow.destroy();
});

await test("later canvas changes cannot mutate an existing captured PNG", async () => {
  const r = environment();
  await r.workflow.captureSelection({ x: .1, y: .1, width: .5, height: .5 });
  const original = r.workflow.getState().asset.source.image;
  r.canvas.imageToken = "new drawing after capture";
  assert.equal(r.workflow.getState().asset.source.image, original);
  await r.workflow.captureSelection({ x: .1, y: .1, width: .5, height: .5 });
  assert.notEqual(r.workflow.getState().asset.source.image, original);
  r.workflow.destroy();
});

await test("cancel and destroy clear an unfinished drag", async () => {
  for (const method of ["cancelSelection", "destroy"]) {
    const r = environment(); r.arm();
    r.track({ x: .2, y: .2 }, .1); r.track({ x: .8, y: .8 }, .1);
    r.workflow[method]();
    assert.equal(r.workflow.getState().drag, null); assert.equal(r.workflow.isSelecting(), false);
    r.track({ x: .8, y: .8 }, .8); await tick();
    assert.equal(r.workflow.getState().asset, null);
    r.workflow.destroy();
  }
});

await test("manual prompts remain usable when browser speech recognition is absent", async () => {
  const editedImage = png("manual edit result");
  const r = environment({ fetchImpl: async url => response(String(url).includes("config") ? config : { image: editedImage, provider: "Seedream", model: "test-image-editor" }) });
  await r.workflow.captureSelection(sampleRegion); await tick();
  const manual = "保留我的轮廓，将主体改成红色陶瓷";
  r.get("imagePromptIntent").value = manual;
  await r.get("editRegionImageBtn").click(); await tick();
  const request = r.requests.find(([url]) => String(url).endsWith("/api/image-edit"));
  assert(request, "manual edit should submit without SpeechRecognition");
  assert.equal(JSON.parse(request[1].body).prompt, manual);
  assert.equal(r.workflow.getState().asset.versions.at(-1).image, editedImage);
  r.workflow.destroy();
});

await test("template prompt assistance includes intent and leaves the result editable", async () => {
  const r = environment({ fetchImpl: async () => response(config) });
  await r.workflow.captureSelection(sampleRegion); await tick();
  r.get("imagePromptIntent").value = "胸前加一个爱心";
  r.get("prepareImageFor3D").checked = true;
  await r.get("organizeImagePromptBtn").click(); await tick();
  assert(r.get("imagePromptIntent").value.includes("胸前加一个爱心"));
  r.get("imagePromptIntent").value += "，保持蓝色眼睛";
  assert(r.get("imagePromptIntent").value.endsWith("保持蓝色眼睛"));
  assert(!r.requests.some(([url]) => String(url).endsWith("/api/image-edit/prompt")), "template assistance should not silently submit an AI request");
  r.workflow.destroy();
});

await test("optional AI prompt assistance uses the selected snapshot and user's intent", async () => {
  const r = environment({ fetchImpl: async url => response(String(url).includes("config") ? { ...config, promptAvailable: true } : { prompt: "AI整理：保留轮廓，红色陶瓷" }) });
  await r.workflow.captureSelection(sampleRegion); await tick();
  const image = r.workflow.getState().asset.source.image;
  r.get("imagePromptIntent").value = "红色陶瓷";
  await r.get("organizeImagePromptBtn").click(); await tick();
  const request = r.requests.find(([url]) => String(url).endsWith("/api/image-edit/prompt"));
  assert(request);
  const body = JSON.parse(request[1].body);
  assert.equal(body.image, image); assert.equal(body.intent, "红色陶瓷");
  assert.equal(r.get("imagePromptIntent").value, "AI整理：保留轮廓，红色陶瓷");
  r.workflow.destroy();
});

await test("image edits preserve the source and the selected version controls 3D handoff", async () => {
  let editIndex = 0;
  const r = environment({ fetchImpl: async url => response(String(url).includes("config") ? config : { image: png(`edited ${++editIndex}`), provider: "Seedream", model: "test-image-editor" }) });
  await r.workflow.captureSelection(sampleRegion); await tick();
  const original = r.workflow.getState().asset.source;
  r.get("imagePromptIntent").value = "第一次修改"; await r.get("editRegionImageBtn").click(); await tick();
  const firstEdit = r.workflow.getState().asset.versions.at(-1);
  r.get("imagePromptIntent").value = "第二次修改"; await r.get("editRegionImageBtn").click(); await tick();
  const state = r.workflow.getState();
  assert.equal(state.asset.source.image, original.image); assert.equal(state.asset.versions.length, 3);
  const secondRequest = r.requests.filter(([url]) => String(url).endsWith("/api/image-edit"))[1];
  assert.equal(JSON.parse(secondRequest[1].body).image, firstEdit.image, "continued editing should use the selected edit");
  r.get("imageVersionSelect").value = original.id; await r.get("imageVersionSelect").dispatch("change");
  assert(r.get("useImageFor3DBtn").disabled, "raw source should be edited before 3D generation");
  r.get("imageVersionSelect").value = firstEdit.id; await r.get("imageVersionSelect").dispatch("change");
  r.get("region3DPrompt").value = "完整陶瓷鸟模型";
  await r.get("useImageFor3DBtn").click(); await tick();
  assert.equal(r.handedOff.length, 1); assert.equal(r.handedOff[0].image, firstEdit.image);
  assert.equal(r.handedOff[0].assetId, state.asset.id); assert.equal(r.handedOff[0].versionId, firstEdit.id);
  assert.equal(r.handedOff[0].prompt, "完整陶瓷鸟模型");
  assert.equal(r.handedOff[0].file.type, "image/png");
  assert(!r.requests.some(([url]) => String(url).includes("rodin")), "handoff must not automatically submit a paid Rodin task");
  r.workflow.destroy();
});

await test("editing updates the single preview and waits for an explicit 3D handoff", async () => {
  const editedImage = png("fresh result for 3D");
  const r = environment({ fetchImpl: async url => response(String(url).includes("config") ? config : { image: editedImage, provider: "Seedream", model: "test-image-editor" }) });
  await r.workflow.captureSelection(sampleRegion); await tick();
  assert(r.get("useImageFor3DBtn").hidden, "3D handoff is hidden before an edited result exists");
  r.get("imagePromptIntent").value = "完整单个主体，干净背景";
  await r.get("editRegionImageBtn").click(); await tick();
  assert.equal(r.handedOff.length, 0, "editing must never auto hand off to 3D");
  assert.equal(r.get("sourceRegionImage").src, editedImage, "the same preview shows the selected result");
  assert.equal(r.get("useImageFor3DBtn").hidden, false);
  assert(r.get("currentRegionLabel").textContent.includes("编辑"));
  await r.get("useImageFor3DBtn").click(); await tick();
  assert.equal(r.handedOff.length, 1); assert.equal(r.handedOff[0].image, editedImage);
  assert.notEqual(r.handedOff[0].versionId, r.workflow.getState().asset.source.id);
  r.workflow.destroy();
});

await test("speech adds to the user's text and stops when the material panel closes", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  r.get("imagePromptIntent").value = "保留原始轮廓。";
  await r.get("voiceImagePromptBtn").click();
  const speech = r.speechInstances.at(-1); assert(speech?.active);
  speech.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: "改成红色陶瓷" }, length: 1, isFinal: true }] });
  assert(r.get("imagePromptIntent").value.includes("保留原始轮廓"));
  assert(r.get("imagePromptIntent").value.includes("改成红色陶瓷"));
  r.workflow.close(); assert.equal(speech.active, false);
  r.workflow.destroy();
});

await test("an old edit response cannot attach to or generate 3D from a newer selection", async () => {
  const pending = deferred();
  const r = environment({ fetchImpl: async url => String(url).includes("config") ? response(config) : pending.promise });
  await r.workflow.captureSelection(sampleRegion); await tick();
  r.get("imagePromptIntent").value = "旧选区的编辑要求";
  await r.get("editRegionImageBtn").click(); await tick();
  assert(r.workflow.getState().busy);
  const oldId = r.workflow.getState().asset.id;
  const editRequest = r.requests.find(([url]) => String(url).endsWith("/api/image-edit"));
  r.workflow.close();
  r.canvas.imageToken = "new selection";
  await r.workflow.captureSelection(sampleRegion); await tick();
  const current = r.workflow.getState().asset;
  assert.notEqual(current.id, oldId); assert(editRequest[1].signal.aborted);
  pending.resolve(response({ image: png("stale edit result"), provider: "Seedream", model: "test-image-editor" }));
  await tick(); await tick();
  const final = r.workflow.getState();
  assert.equal(final.asset.id, current.id); assert.equal(final.asset.versions.length, 1);
  assert.equal(final.asset.source.image, current.source.image); assert.equal(r.handedOff.length, 0);
  r.workflow.destroy();
});

await test("an old AI prompt response cannot overwrite a newer material's manual prompt", async () => {
  const pending = deferred();
  const r = environment({ fetchImpl: async url => String(url).includes("config") ? response({ ...config, promptAvailable: true }) : pending.promise });
  await r.workflow.captureSelection(sampleRegion); await tick();
  r.get("imagePromptIntent").value = "旧素材"; await r.get("organizeImagePromptBtn").click(); await tick();
  assert(r.workflow.getState().busy);
  r.workflow.close(); r.canvas.imageToken = "new prompt material";
  await r.workflow.captureSelection(sampleRegion); await tick();
  r.get("imagePromptIntent").value = "新素材的手动提示词";
  pending.resolve(response({ prompt: "旧素材的AI提示词" })); await tick(); await tick();
  assert.equal(r.get("imagePromptIntent").value, "新素材的手动提示词");
  assert.equal(r.workflow.getState().busy, false);
  r.workflow.destroy();
});

await test("a lost hand must visibly release before another selection can start", async () => {
  const r = environment(); r.arm();
  r.track({ x: .2, y: .2 }, .1); r.track({ x: .7, y: .7 }, .1);
  r.track(null, Infinity, { present: false, timestamp: 700 });
  r.track({ x: .8, y: .8 }, .1); r.track({ x: .9, y: .9 }, .1);
  assert.equal(r.workflow.getState().drag, null);
  r.release({ x: .9, y: .9 }); await tick();
  assert.equal(r.workflow.getState().asset, null);
  r.track({ x: .2, y: .2 }, .1); r.track({ x: .8, y: .8 }, .1); r.release({ x: .8, y: .8 }); await tick();
  assert(r.workflow.getState().asset);
  r.workflow.destroy();
});

await test("invalid geometry cannot create an export or a gesture drag", async () => {
  assert.equal(normalizeRegion({ x: NaN, y: .2 }, { x: .5, y: .5 }), null);
  assert.equal(regionPixelRect({ x: 0, y: 0, width: Infinity, height: 1 }, 100, 100), null);
  const r = environment(); r.arm();
  r.track({ x: NaN, y: .2 }, .1); r.track({ x: .8, y: .8 }, .35); await tick();
  assert.equal(r.workflow.getState().asset, null); assert.equal(r.workflow.getState().drag, null);
  r.workflow.destroy();
});

await test("pointer drags ignore simultaneous camera samples until pointer release", async () => {
  const r = environment(); r.workflow.startSelection();
  await r.canvas.dispatch("pointerdown", { button: 0, pointerId: 7, clientX: 90, clientY: 55 });
  await r.canvas.dispatch("pointermove", { pointerId: 7, clientX: 540, clientY: 330 });
  r.track({ x: .9, y: .9 }, .8);
  r.track(null, Infinity, { present: false, timestamp: 500 });
  r.track(null, Infinity, { present: false, timestamp: 1000 });
  assert.equal(r.workflow.getState().asset, null); assert(r.workflow.getState().drag);
  await r.canvas.dispatch("pointerup", { pointerId: 7, clientX: 540, clientY: 330 });
  assert(r.workflow.getState().asset); assert.equal(r.workflow.getState().drag, null);
  r.workflow.destroy();
});

await test("stale configuration responses cannot disable editing for a new selection", async () => {
  const first = deferred(), second = deferred(); let configCount = 0;
  const r = environment({ fetchImpl: async () => (++configCount === 1 ? first.promise : second.promise) });
  await r.workflow.captureSelection(sampleRegion); r.workflow.close();
  r.canvas.imageToken = "new config asset"; await r.workflow.captureSelection(sampleRegion);
  second.resolve(response(config)); await tick();
  assert.equal(r.get("editRegionImageBtn").disabled, false);
  first.resolve(response({ available: false, promptAvailable: false })); await tick();
  assert.equal(r.get("editRegionImageBtn").disabled, false);
  assert(r.get("imageEditConnectionState").textContent.includes(config.model));
  r.workflow.destroy();
});

await test("manually stopping speech retains its final transcript", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  await r.get("voiceImagePromptBtn").click();
  const speech = r.speechInstances.at(-1); speech.finalTranscript = "停止前最后一句";
  await r.get("voiceImagePromptBtn").click(); await tick();
  assert(speech.stopped); assert(!speech.aborted);
  assert(r.get("imagePromptIntent").value.includes("停止前最后一句"));
  assert.equal(speech.active, false);
  r.workflow.destroy();
});

await test("state snapshots do not expose mutable source or version records", async () => {
  const r = environment(); await r.workflow.captureSelection(sampleRegion);
  const state = r.workflow.getState(), original = state.asset.source.image;
  state.asset.source.image = "invalid external mutation"; state.asset.versions.length = 0;
  state.asset.region.x = .9;
  const actual = r.workflow.getState();
  assert.equal(actual.asset.source.image, original); assert.equal(actual.asset.versions.length, 1);
  assert.equal(actual.asset.region.x, sampleRegion.x);
  r.workflow.destroy();
});

await test("late AI drafting cannot overwrite manual prompt changes on the same material", async () => {
  const pending = deferred();
  const r = environment({ fetchImpl: async url => String(url).includes("config") ? response({ ...config, promptAvailable: true }) : pending.promise });
  await r.workflow.captureSelection(sampleRegion); await tick();
  r.get("imagePromptIntent").value = "卡通风格";
  await r.get("organizeImagePromptBtn").click(); await tick();
  r.get("imagePromptIntent").value = "我手动改成了红色陶瓷，不要卡通";
  pending.resolve(response({ prompt: "迟到的卡通风格AI草稿" })); await tick();
  assert.equal(r.get("imagePromptIntent").value, "我手动改成了红色陶瓷，不要卡通");
  r.workflow.destroy();
});

await test("voice automatically stops after three seconds of initial silence and retains its final words", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  await r.get("voiceImagePromptBtn").click();
  const speech = r.speechInstances.at(-1);
  assert.equal(speech.continuous, true); assert.equal(speech.interimResults, true);
  speech.onaudiostart?.();
  r.clock.advance(2999); assert.equal(speech.stopped, undefined);
  speech.finalTranscript = "自动结束前最后一句";
  r.clock.advance(1); await tick();
  assert(speech.stopped); assert(!speech.aborted);
  assert(r.get("imagePromptIntent").value.includes("自动结束前最后一句"));
  assert.equal(r.clock.pending, 0);
  r.workflow.destroy();
});

await test("voice activity cancels initial silence and restarts a full three-second gap after speech", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  await r.get("voiceImagePromptBtn").click();
  const speech = r.speechInstances.at(-1); speech.onaudiostart?.();
  r.clock.advance(2500); speech.onspeechstart?.(); r.clock.advance(4000);
  assert.equal(speech.stopped, undefined, "ongoing speech must not be stopped by the initial timer");
  speech.onspeechend?.(); r.clock.advance(2500); speech.onspeechstart?.(); r.clock.advance(1000);
  assert.equal(speech.stopped, undefined, "new speech cancels the previous gap timer");
  speech.onspeechend?.(); r.clock.advance(2999); assert.equal(speech.stopped, undefined);
  r.clock.advance(1); await tick(); assert(speech.stopped); assert.equal(r.clock.pending, 0);
  r.workflow.destroy();
});

await test("continuous voice appends each final result once and never repeats interim words", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  r.get("imagePromptIntent").value = "保留轮廓";
  await r.get("voiceImagePromptBtn").click(); const speech = r.speechInstances.at(-1);
  const result = (text, isFinal) => ({ 0: { transcript: text }, length: 1, isFinal });
  speech.onresult?.({ resultIndex: 0, results: [result("变成", false)] });
  assert.equal(r.get("imagePromptIntent").value, "保留轮廓", "interim recognition should not become permanent prompt text");
  speech.onresult?.({ resultIndex: 0, results: [result("变成卡通", true)] });
  speech.onresult?.({ resultIndex: 1, results: [result("变成卡通", true), result("红色", false)] });
  speech.onresult?.({ resultIndex: 1, results: [result("变成卡通", true), result("红色陶瓷", true)] });
  speech.onresult?.({ resultIndex: 0, results: [result("变成卡通", true), result("红色陶瓷", true)] });
  const text = r.get("imagePromptIntent").value;
  assert.equal(text.match(/变成卡通/g)?.length, 1); assert.equal(text.match(/红色陶瓷/g)?.length, 1);
  assert(text.includes("保留轮廓"));
  r.workflow.destroy();
});

await test("closing the panel or replacing its asset cancels silence timers and late speech", async () => {
  for (const action of ["close", "replace"]) {
    const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
    await r.get("voiceImagePromptBtn").click(); const speech = r.speechInstances.at(-1);
    speech.onaudiostart?.(); assert.equal(r.clock.pending, 1);
    const lateResult = speech.onresult;
    if (action === "close") r.workflow.close();
    else { r.canvas.imageToken = "replacement material"; await r.workflow.captureSelection(sampleRegion); }
    assert(speech.aborted); assert.equal(r.clock.pending, 0);
    lateResult?.({ resultIndex: 0, results: [{ 0: { transcript: "旧会话迟到的内容" }, length: 1, isFinal: true }] });
    r.clock.advance(5000); await tick();
    assert(!r.get("imagePromptIntent").value.includes("旧会话迟到的内容"));
    assert.equal(speech.stopped, undefined);
    r.workflow.destroy();
  }
});

await test("a speech error clears its silence timer", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  await r.get("voiceImagePromptBtn").click(); const speech = r.speechInstances.at(-1);
  speech.onaudiostart?.(); assert.equal(r.clock.pending, 1);
  speech.onerror?.({ error: "not-allowed" });
  assert.equal(r.clock.pending, 0); r.clock.advance(5000); await tick();
  assert.equal(speech.stopped, undefined);
  assert(r.get("voicePromptState").textContent.includes("not-allowed"));
  r.workflow.destroy();
});

await test("an old speech session ending late cannot clear a new recording or its timer", async () => {
  const r = environment({ speech: true }); await r.workflow.captureSelection(sampleRegion);
  await r.get("voiceImagePromptBtn").click(); const first = r.speechInstances.at(-1), oldEnd = first.onend;
  await r.get("voiceImagePromptBtn").click(); await tick();
  await r.get("voiceImagePromptBtn").click(); const second = r.speechInstances.at(-1);
  assert.notEqual(second, first); second.onaudiostart?.(); assert.equal(r.clock.pending, 1);
  oldEnd?.(); assert.equal(r.clock.pending, 1);
  await r.get("voiceImagePromptBtn").click(); await tick();
  assert(second.stopped, "the voice button must still control the active second session");
  assert.equal(r.speechInstances.length, 2); assert.equal(r.clock.pending, 0);
  r.workflow.destroy();
});

for (const report of reports) console.log(`${report.pass ? "PASS" : "FAIL"} ${report.name}${report.error ? `\n${report.error}` : ""}`);
const failed = reports.filter(report => !report.pass).length;
console.log(`\n${reports.length - failed}/${reports.length} image workflow checks passed. Live camera, speech services, and paid APIs are not covered.`);
if (failed) process.exitCode = 1;
