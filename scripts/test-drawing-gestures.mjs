import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import * as RealTHREE from "../vendor/three/three.module.js";
import { createImageWorkflow } from "../image-workflow.js";
import * as PinchOwner from "../pinch-owner.js";

// These checks execute the complete app with a virtual DOM and synthetic hand
// landmarks. They do not test browser layout, rendered pixels, or live tracking.
const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");
const source = fs.readFileSync(new URL("app.js", root), "utf8").replace(/^import .*;\n/gm, "");

async function runtime() {
  const ids = new Map(), elements = [], frames = new Map();
  let frameId = 0;
  const ctx = new Proxy({}, {
    get: (object, key) => object[key] ?? (key === "measureText" ? text => ({ width: text.length * 6 }) : key === "getImageData" ? () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) : () => {}),
    set: (object, key, value) => (object[key] = value, true)
  });
  function matches(node, selector) {
    if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return node.attrs.id === selector.slice(1);
    if (selector.startsWith("[")) return selector.slice(1, -1) in node.attrs;
    return node.tagName === selector.toUpperCase();
  }
  class Element {
    constructor(tag, attrs = {}) {
      Object.assign(this, {
        tagName: tag.toUpperCase(), attrs, children: [], parentElement: null,
        dataset: {}, style: {}, events: new Map(), textContent: "", value: attrs.value || "",
        hidden: "hidden" in attrs, disabled: "disabled" in attrs, width: 300, height: 150,
        clientWidth: 900, clientHeight: 550, videoWidth: 1280, videoHeight: 720, files: []
      });
      const names = new Set((attrs.class || "").split(/\s+/));
      this.classList = {
        add(...values) { values.forEach(value => names.add(value)); },
        remove(...values) { values.forEach(value => names.delete(value)); },
        contains(value) { return names.has(value); },
        toggle(value, force) {
          const enabled = force ?? !names.has(value);
          if (enabled) names.add(value); else names.delete(value);
          return enabled;
        }
      };
      for (const [name, value] of Object.entries(attrs)) {
        if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      }
      elements.push(this);
      if (attrs.id) ids.set(attrs.id, this);
    }
    getBoundingClientRect() { return { width: 900, height: 550, left: 0, top: 0 }; }
    getContext() { return ctx; }
    // Routing checks need a PNG-like snapshot; actual blank/crop behavior is
    // covered by test-image-workflow.mjs with a dedicated canvas double.
    toDataURL() { return "data:image/png;base64,aW5r"; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === "hidden") this.hidden = true; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    toggleAttribute(key, force) {
      const enabled = force ?? !(key in this.attrs);
      if (enabled) this.attrs[key] = ""; else delete this.attrs[key];
      if (key === "hidden") this.hidden = enabled;
      return enabled;
    }
    addEventListener(type, callback) {
      if (!this.events.has(type)) this.events.set(type, []);
      this.events.get(type).push(callback);
    }
    removeEventListener(type, callback) { this.events.set(type, (this.events.get(type) || []).filter(handler => handler !== callback)); }
    appendChild(node) {
      if (node.parentElement) node.parentElement.children = node.parentElement.children.filter(child => child !== node);
      this.children.push(node); node.parentElement = this;
      return node;
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    prepend(node) { this.appendChild(node); this.children.unshift(this.children.pop()); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    querySelectorAll(selector) {
      const found = [];
      const visit = node => {
        for (const child of node.children) { if (matches(child, selector)) found.push(child); visit(child); }
      };
      visit(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
      let node = this;
      while (node) { if (matches(node, selector)) return node; node = node.parentElement; }
      return null;
    }
    click() { return this.dispatch("click"); }
    dispatch(type) {
      return Promise.all((this.events.get(type) || []).map(callback => callback({ target: this, currentTarget: this, button: 0, preventDefault() {} })));
    }
  }

  const virtual = new Element("root"), stack = [virtual];
  const voidTags = new Set(["meta", "link", "input", "br", "hr", "img", "source"]);
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>/gi)) {
    const text = token[0];
    if (text.startsWith("<!")) continue;
    if (text.startsWith("</")) {
      const tag = text.match(/^<\/([^\s>]+)/)[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName.toLowerCase() === tag) { stack.length = index; break; }
      }
      continue;
    }
    const tag = text.match(/^<([^\s/>]+)/)[1].toLowerCase(), attrs = {};
    for (const attribute of text.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[attribute[1]] = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    }
    const node = new Element(tag, attrs);
    stack.at(-1).appendChild(node);
    if (!voidTags.has(tag) && !text.endsWith("/>")) stack.push(node);
  }
  const document = {
    getElementById: id => ids.get(id) ?? null,
    createElement: tag => new Element(tag),
    querySelectorAll: selector => elements.filter(element => matches(element, selector)),
    body: elements.find(element => element.tagName === "BODY")
  };
  class Renderer {
    constructor() { this.domElement = new Element("canvas"); }
    setPixelRatio() {} setSize() {} render() {}
  }
  class Controls {
    constructor() { this.target = new RealTHREE.Vector3(); this.enabled = true; }
    addEventListener() {} update() {} dispose() {}
  }
  class Transform extends RealTHREE.Object3D { setMode() {} setSpace() {} detach() {} }
  const sandbox = {
    ...PinchOwner,
    console, document, window: { devicePixelRatio: 1, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { throw new Error("Camera disabled in synthetic tests"); } } },
    devicePixelRatio: 1, performance, ResizeObserver: class { observe() {} },
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id), setTimeout, clearTimeout, URL, Blob,
    FilesetResolver: {}, HandLandmarker: {}, THREE: { ...RealTHREE, WebGLRenderer: Renderer },
    OBJLoader: class {}, GLTFLoader: class {}, OrbitControls: Controls, TransformControls: Transform,
    Option: class extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } },
    fetch: async url => ({ ok: true, json: async () => String(url).includes("catalog") ? [] : { available: false } })
  };
  sandbox.createImageWorkflow = createImageWorkflow;
  vm.createContext(sandbox);
  const run = code => vm.runInContext(code, sandbox, { timeout: 1000 });
  run(source);
  await new Promise(resolve => setTimeout(resolve, 0));
  function flushFrames() {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(performance.now());
  }
  flushFrames();
  run("globalThis.testRendered=[]; drawingCtx.stroke=function(){testRendered.push(this.globalCompositeOperation);}; drawingCtx.fill=function(){testRendered.push(this.globalCompositeOperation);};");
  return {
    run, ids, flushFrames,
    sample(fixture, timestamp) {
      sandbox.testImage = fixture?.image ?? null;
      sandbox.testWorld = fixture?.world ?? null;
      run(`updateTracking(testImage,${timestamp},null,testWorld);`);
      return this.state();
    },
    state() {
      return run("({strokes,currentStroke,drawingActive,indexModeActive,isEraser,gestureEraser,drawingPinchActive,drawEnabled,drawingFrameDiagnostics,rendered:[...testRendered]})");
    },
    diagnose(timestamp = 1000) {
      run(`stream={};updateCameraDiagnostics({hands:[{label:'Right',interactive:true}],active:{},ambiguous:false},${timestamp});`);
      return ids.get("cameraPenReason").textContent;
    }
  };
}

// Independent bone chains allow PIP, DIP, spread, and rigid hand motion to vary.
function hand({ index = 179, middle = 90, ring = 90, pinky = 90, dip = 179, thumb = "folded", spread = 1, middleBase = -.01, pinch = null, middlePinch = null, x = 0, y = 0, rotation = 0 } = {}) {
  const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  world[0] = { x: 0, y: .08, z: 0 };
  for (const [mcp, pip, baseX, baseY] of [[5, index, -.03, 0], [9, middle, middleBase, -.005], [13, ring, .01, 0], [17, pinky, .03, .01]]) {
    const base = { x: baseX, y: baseY, z: 0 }, direction = (180 - pip) * Math.PI / 180;
    const distal = direction + (180 - (typeof dip === "number" ? dip : dip[mcp] ?? 179)) * Math.PI / 180;
    world[mcp] = base;
    world[mcp + 1] = { x: baseX, y: baseY - .04, z: 0 };
    world[mcp + 2] = { x: baseX * spread, y: world[mcp + 1].y - .026 * Math.cos(direction), z: .026 * Math.sin(direction) };
    world[mcp + 3] = { x: world[mcp + 2].x, y: world[mcp + 2].y - .02 * Math.cos(distal), z: world[mcp + 2].z + .02 * Math.sin(distal) };
  }
  if (thumb === "extended") {
    world[1] = { x: -.055, y: .065, z: 0 }; world[2] = { x: -.055, y: .04, z: 0 };
    world[3] = { x: -.05, y: .015, z: 0 }; world[4] = { x: -.045, y: -.01, z: 0 };
  } else {
    world[1] = { x: -.055, y: .065, z: 0 }; world[2] = { x: -.045, y: .04, z: 0 };
    world[3] = { x: -.025, y: .025, z: .015 }; world[4] = { x: -.01, y: .04, z: .025 };
  }
  if (pinch !== null) {
    const palmWidth = Math.hypot(world[5].x - world[17].x, world[5].y - world[17].y, world[5].z - world[17].z);
    world[4] = { ...world[8], x: world[8].x + pinch * palmWidth };
  }
  if (middlePinch !== null) {
    const palmWidth = Math.hypot(world[5].x - world[17].x, world[5].y - world[17].y, world[5].z - world[17].z);
    world[4] = { ...world[12], x: world[12].x + middlePinch * palmWidth };
  }
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  const moved = world.map(point => ({ x: point.x * cosine - point.y * sine + x, y: point.x * sine + point.y * cosine + y, z: point.z }));
  return { world: moved, image: project(moved) };
}
function project(world) {
  return world.map(point => ({ x: .5 + 3 * point.x, y: .55 + 3 * point.y / (720 / 1280), z: 3 * point.z }));
}
const pen = (options = {}) => hand({ pinch: .1, ...options });
const regionHand = (options = {}) => hand({ middlePinch: .1, ...options });
const small = (options = {}) => hand({ index: 179, middle: 179, ring: 90, pinky: 90, middleBase: -.012, ...options });
const openPalm = (options = {}) => hand({ index: 179, middle: 179, ring: 179, pinky: 179, thumb: "extended", ...options });
function degenerateThumb(fixture) {
  for (const index of [1, 2, 3, 4]) fixture.world[index] = { x: -.01, y: .03, z: 0 };
  fixture.image = project(fixture.world);
  return fixture;
}
function exactPinch(ratio) {
  const fixture = pen();
  fixture.world[5] = { x: 0, y: 0, z: 0 };
  fixture.world[17] = { x: .125, y: 0, z: 0 };
  fixture.world[8] = { x: 0, y: -.05, z: 0 };
  fixture.world[4] = { x: ratio * .125, y: -.05, z: 0 };
  // These fixtures isolate the index threshold. The independently specified
  // middle-contact fixture below overrides this open position when needed.
  fixture.world[12] = { ...fixture.world[4], x: fixture.world[4].x + .125 };
  fixture.image = project(fixture.world);
  return fixture;
}
function exactTwoPinches(indexRatio, middleRatio) {
  const fixture = exactPinch(indexRatio);
  fixture.world[12] = { ...fixture.world[4], x: fixture.world[4].x + middleRatio * .125 };
  fixture.image = project(fixture.world);
  return fixture;
}
function thumbAngles(fixture, { mcp, ip }) {
  const base = fixture.world[2], joint = fixture.world[3];
  const length = Math.hypot(joint.x - base.x, joint.y - base.y);
  const direction = { x: (joint.x - base.x) / length, y: (joint.y - base.y) / length };
  const rotated = degrees => {
    const angle = degrees * Math.PI / 180;
    return { x: direction.x * Math.cos(angle) - direction.y * Math.sin(angle), y: direction.x * Math.sin(angle) + direction.y * Math.cos(angle) };
  };
  const proximal = rotated(mcp), distal = rotated(180 - ip);
  fixture.world[1] = { x: base.x + proximal.x * .025, y: base.y + proximal.y * .025, z: base.z };
  fixture.world[4] = { x: joint.x + distal.x * .025, y: joint.y + distal.y * .025, z: joint.z };
  fixture.image = project(fixture.world);
  return fixture;
}
function bendFingerAtMcp(fixture, base, angle) {
  const origin = new RealTHREE.Vector3().copy(fixture.world[base]);
  const towardWrist = new RealTHREE.Vector3().copy(fixture.world[0]).sub(origin).normalize();
  const flexion = (180 - angle) * Math.PI / 180;
  const direction = towardWrist.clone().multiplyScalar(-Math.cos(flexion)).add(new RealTHREE.Vector3(0, 0, Math.sin(flexion)));
  const previous = new RealTHREE.Vector3().copy(fixture.world[base + 1]).sub(origin).normalize();
  const rotation = new RealTHREE.Quaternion().setFromUnitVectors(previous, direction);
  for (let index = base + 1; index <= base + 3; index += 1) {
    const point = new RealTHREE.Vector3().copy(fixture.world[index]).sub(origin).applyQuaternion(rotation).add(origin);
    fixture.world[index] = { x: point.x, y: point.y, z: point.z };
  }
  fixture.image = project(fixture.world);
  return fixture;
}
function distortedWorldWithAccuratePlane(fixture) {
  const planar = fixture.world.map(point => ({ ...point, z: 0 }));
  // Bend the folded fingers in the image plane, where their curl remains
  // observable even when the estimated 3D bone depths are wrong.
  for (const mcp of [5, 9, 13, 17]) for (const index of [mcp + 2, mcp + 3]) planar[index].x += fixture.world[index].z;
  fixture.image = project(planar);
  fixture.world = planar.map(point => ({ ...point }));
  for (const index of [6, 10, 14, 18]) fixture.world[index].z = .1;
  for (const index of [7, 11, 15, 19]) fixture.world[index].z = -.1;
  return fixture;
}
function visiblyFoldOtherFingers(fixture) {
  // Preserve the true index/middle depth curl while keeping the two folded
  // fingers visible in XY, so the planar candidate is otherwise a valid small
  // eraser. This tests that depth fallback does not flatten a real curl.
  for (const mcp of [13, 17]) for (const index of [mcp + 2, mcp + 3]) {
    fixture.world[index].x += fixture.world[index].z; fixture.world[index].z = 0;
  }
  fixture.image = project(fixture.world);
  return fixture;
}
function thumbCurlTowardCamera(ip) {
  const fixture = openPalm(), joint = fixture.world[3], base = fixture.world[2];
  const length = Math.hypot(joint.x - base.x, joint.y - base.y);
  const flexion = (180 - ip) * Math.PI / 180;
  fixture.world[4] = {
    x: joint.x + (joint.x - base.x) * Math.cos(flexion),
    y: joint.y + (joint.y - base.y) * Math.cos(flexion),
    z: joint.z + length * Math.sin(flexion)
  };
  fixture.image = project(fixture.world);
  return fixture;
}

const reports = [];
async function test(name, callback) {
  try { await callback(); reports.push({ name, pass: true }); }
  catch (error) { reports.push({ name, pass: false, error: error.stack }); }
}

await test("removed selection button does not break full app initialization", async () => {
  const r = await runtime();
  assert(!r.ids.has("selectStrokeBtn"));
  for (const id of ["penBtn", "eraserBtn", "drawToggleBtn", "consoleToggleBtn", "startCameraBtn"]) assert(r.ids.get(id).events.size, id);
  await r.ids.get("eraserBtn").click(); assert(r.state().isEraser);
  await r.ids.get("penBtn").click(); assert(!r.state().isEraser);
  await r.ids.get("consoleToggleBtn").click(); r.flushFrames(); assert(r.ids.get("controlRail").hidden);
  await r.ids.get("consoleToggleBtn").click(); r.flushFrames(); assert(!r.ids.get("controlRail").hidden);
});

await test("region selection blocks pen and small eraser in the integrated app", async () => {
  const r = await runtime();
  await r.ids.get("selectRegionBtn").click();
  assert(r.run("imageWorkflow.isSelecting()"));
  for (const fixture of [pen, small, openPalm]) {
    for (let frame = 0; frame < 10; frame += 1) {
      const state = r.sample(fixture({ x: frame * .001 }), 100 + frame * 20);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    }
  }
  assert.equal(r.state().strokes.length, 0);
});

await test("integrated selection captures on release and its preview blocks further ink", async () => {
  const r = await runtime(); await r.ids.get("selectRegionBtn").click();
  r.sample(hand({ x: -.02, y: .03 }), 100);
  r.sample(regionHand({ x: -.02, y: .03 }), 120);
  r.sample(regionHand({ x: .08, y: .08 }), 140);
  assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  assert.equal(r.run("imageWorkflow.getState().asset"), null);
  r.sample(hand({ x: .08, y: .08 }), 160);
  assert.equal(r.run("imageWorkflow.getState().asset"), null);
  r.sample(hand({ x: .12, y: .12 }), 240);
  assert(r.run("Boolean(imageWorkflow.getState().asset)")); assert(r.ids.get("imageWorkflowDialog").open);
  const state = r.sample(pen({ x: -.1, y: .05 }), 260);
  assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 0);
  assert(r.run("imageWorkflow.isBlocking()"));
});

await test("integrated hand loss does not confirm an unfinished region", async () => {
  const r = await runtime(); await r.ids.get("selectRegionBtn").click();
  r.sample(hand({ x: -.02, y: .03 }), 100); r.sample(regionHand({ x: -.02, y: .03 }), 120); r.sample(regionHand({ x: .08, y: .08 }), 140);
  r.sample(null, 160);
  assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  assert.equal(r.run("imageWorkflow.getState().asset"), null);
  r.sample(null, 500);
  assert.equal(r.run("imageWorkflow.getState().drag"), null); assert.equal(r.run("imageWorkflow.getState().asset"), null);
  r.sample(hand({ x: .08, y: .08 }), 520);
  assert.equal(r.run("imageWorkflow.getState().asset"), null); assert.equal(r.state().currentStroke, null);
});

await test("pause and workspace changes cancel an integrated unfinished region", async () => {
  for (const id of ["drawToggleBtn", "modelWorkspaceBtn"]) {
    const r = await runtime(); await r.ids.get("selectRegionBtn").click();
    r.sample(hand({ x: -.02, y: .03 }), 100); r.sample(regionHand({ x: -.02, y: .03 }), 120); r.sample(regionHand({ x: .08, y: .08 }), 140);
    await r.ids.get(id).click();
    assert.equal(r.run("imageWorkflow.isSelecting()"), false);
    assert.equal(r.run("imageWorkflow.getState().drag"), null); assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
});

await test("closing image preview requires a visible release before drawing resumes", async () => {
  const r = await runtime(); await r.ids.get("selectRegionBtn").click();
  r.sample(hand({ x: -.02, y: .03 }), 100); r.sample(regionHand({ x: -.02, y: .03 }), 120); r.sample(regionHand({ x: .08, y: .08 }), 140); r.sample(hand({ x: .08, y: .08 }), 160); r.sample(hand({ x: .08, y: .08 }), 240);
  assert(r.ids.get("imageWorkflowDialog").open);
  r.sample(pen(), 260); await r.ids.get("closeImageWorkflowBtn").click();
  assert(!r.sample(pen(), 280).drawingActive);
  r.sample(exactPinch(.35), 300);
  assert(r.sample(pen(), 320).drawingActive);
});

await test("middle-thumb gesture enters region selection without an index writing stroke", async () => {
  const r = await runtime();
  for (const timestamp of [100, 220]) {
    const state = r.sample(regionHand(), timestamp);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    assert(!r.run("imageWorkflow.isSelecting()")); assert(r.run("imageWorkflow.isBlocking()"));
  }
  r.sample(regionHand(), 340);
  assert(r.run("imageWorkflow.isSelecting()")); assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  r.sample(regionHand({ x: .1, y: .05 }), 360);
  r.sample(hand({ x: .12, y: .08 }), 380);
  r.sample(hand({ x: .15, y: .10 }), 460);
  assert(r.run("Boolean(imageWorkflow.getState().asset)"));
  assert.equal(r.state().strokes.length, 0); assert.equal(r.state().currentStroke, null);
});

await test("ambiguous index-middle contact produces neither accidental ink nor a crop", async () => {
  const r = await runtime();
  for (const [frame, timestamp] of [100, 220, 340, 460].entries()) {
    const fixture = exactTwoPinches(.12, .1);
    fixture.image = fixture.image.map(point => ({ ...point, x: point.x + frame * .02 }));
    const state = r.sample(fixture, timestamp);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 0);
    assert(!r.run("imageWorkflow.isSelecting()"));
    assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
});

await test("an ambiguous contact requires visible release before it can become writing", async () => {
  const r = await runtime();
  r.sample(exactTwoPinches(.12, .1), 100);
  for (const timestamp of [116, 236, 356]) {
    const state = r.sample(exactTwoPinches(.1, .8), timestamp);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 0);
  }
  r.sample(exactTwoPinches(.8, .8), 372);
  const state = r.sample(exactTwoPinches(.1, .8), 388);
  assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1);
});

await test("a confirmed writing pinch keeps ownership through incidental middle contact", async () => {
  const r = await runtime();
  const first = r.sample(exactTwoPinches(.1, .8), 100);
  assert(first.drawingActive); const stroke = first.currentStroke;
  for (const [frame, timestamp] of [116, 236, 356, 476].entries()) {
    const fixture = exactTwoPinches(.1, .1);
    fixture.image = fixture.image.map(point => ({ ...point, x: point.x + (frame + 1) * .02 }));
    const state = r.sample(fixture, timestamp);
    assert(state.drawingActive); assert.equal(state.currentStroke, stroke); assert.equal(state.strokes.length, 0);
    assert(!r.run("imageWorkflow.isSelecting()")); assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
});

await test("lifting and repinching the index can write repeated strokes while the middle stays folded", async () => {
  const r = await runtime();
  for (let stroke = 0; stroke < 3; stroke += 1) {
    const started = r.sample(exactTwoPinches(.1, .28), 100 + stroke * 100);
    assert(started.drawingActive); assert(started.currentStroke);
    assert.equal(started.strokes.length, stroke);
    const stopped = r.sample(exactTwoPinches(.35, .28), 116 + stroke * 100);
    assert(!stopped.drawingActive); assert.equal(stopped.currentStroke, null);
    assert.equal(stopped.strokes.length, stroke + 1);
    assert(!r.run("imageWorkflow.isSelecting()"));
    assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
});

await test("releasing a writing pinch cannot switch straight into a middle crop", async () => {
  const r = await runtime();
  assert(r.sample(exactTwoPinches(.1, .28), 100).drawingActive);
  r.sample(exactTwoPinches(.35, .28), 116);
  for (const timestamp of [132, 252, 372, 492]) {
    const state = r.sample(exactTwoPinches(.8, .1), timestamp);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null);
    assert.equal(state.strokes.length, 1);
    assert(!r.run("imageWorkflow.isSelecting()"));
    assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
  r.sample(exactTwoPinches(.8, .8), 508);
  for (const timestamp of [524, 644, 764]) r.sample(exactTwoPinches(.8, .1), timestamp);
  assert(r.run("imageWorkflow.isSelecting()"));
  assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  assert.equal(r.state().strokes.length, 1);
});

await test("a confirmed middle pinch keeps selection ownership when the index moves near the thumb", async () => {
  const r = await runtime();
  for (const timestamp of [100, 220, 340]) r.sample(exactTwoPinches(.8, .1), timestamp);
  assert(r.run("imageWorkflow.isSelecting()")); assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  const fixture = exactTwoPinches(.1, .1);
  fixture.image = fixture.image.map(point => ({ ...point, x: point.x + .15, y: point.y + .15 }));
  const state = r.sample(fixture, 460);
  assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 0);
  assert(r.run("imageWorkflow.isSelecting()")); assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  assert.equal(r.run("imageWorkflow.getState().asset"), null);
});

await test("middle-thumb shortcut has no effect while paused or in the 3D workspace", async () => {
  for (const id of ["drawToggleBtn", "modelWorkspaceBtn"]) {
    const r = await runtime(); await r.ids.get(id).click();
    for (const timestamp of [100, 220, 340, 460]) r.sample(regionHand(), timestamp);
    assert(!r.run("imageWorkflow.isSelecting()")); assert.equal(r.run("imageWorkflow.getState().asset"), null);
  }
});

await test("middle-thumb shortcut follows visible contact despite erroneous depth estimates", async () => {
  const r = await runtime();
  const fixture = regionHand();
  fixture.world[4].z = 5;
  fixture.image[4].z = 10; fixture.image[12].z = -10;
  for (const timestamp of [100, 220, 340]) r.sample(fixture, timestamp);
  assert(r.run("imageWorkflow.isSelecting()")); assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  assert.equal(r.state().strokes.length, 0); assert.equal(r.state().currentStroke, null);
});

await test("internal canvas resizing preserves a normalized gesture selection until release", async () => {
  const r = await runtime();
  for (const timestamp of [100, 220, 340]) r.sample(regionHand(), timestamp);
  r.sample(regionHand({ x: .1, y: .05 }), 360);
  const before = r.run("(({drag,region}) => JSON.stringify({drag,region}))(imageWorkflow.getState())");
  r.run("resizeAll()");
  assert(r.run("imageWorkflow.isSelecting()"));
  assert.equal(r.run("(({drag,region}) => JSON.stringify({drag,region}))(imageWorkflow.getState())"), before);
  r.sample(hand({ x: .12, y: .08 }), 380);
  r.sample(hand({ x: .15, y: .10 }), 460);
  assert(r.run("Boolean(imageWorkflow.getState().asset)"));
  assert.equal(r.state().currentStroke, null); assert.equal(r.state().strokes.length, 0);
});

await test("explicit console layout changes still cancel a gesture selection", async () => {
  const r = await runtime();
  for (const timestamp of [100, 220, 340]) r.sample(regionHand(), timestamp);
  r.sample(regionHand({ x: .1, y: .05 }), 360);
  assert(r.run("Boolean(imageWorkflow.getState().drag)"));
  await r.ids.get("consoleToggleBtn").click(); r.flushFrames();
  assert(!r.run("imageWorkflow.isSelecting()"));
  assert.equal(r.run("imageWorkflow.getState().drag"), null); assert.equal(r.run("imageWorkflow.getState().asset"), null);
});

await test("pinch starts promptly and fast hand translation remains one stroke", async () => {
  const r = await runtime();
  for (let index = 0; index < 8; index += 1) {
    const state = r.sample(pen({ x: -.08 + index * .02 }), 100 + index * 16);
    assert(state.drawingActive); assert.equal(state.currentStroke.tool, "pen"); assert.equal(state.strokes.length, 0);
  }
  assert(r.state().currentStroke.points.length > 20);
});

await test("writing movement begins under the fingertip and reduces both axes by 18 percent", () => {
  const gain = PinchOwner.createDrawingGain();
  const start = { x: .3, y: .4 };
  assert.deepEqual(gain.map(start), start);
  for (const point of [{ x: .5, y: .7 }, { x: .1, y: .2 }]) {
    const mapped = gain.map(point);
    assert(Math.abs(mapped.x - (start.x + (point.x - start.x) * .82)) < 1e-12);
    assert(Math.abs(mapped.y - (start.y + (point.y - start.y) * .82)) < 1e-12);
  }
});

await test("a stationary writing hand never catches up to the unreduced position", () => {
  const gain = PinchOwner.createDrawingGain();
  gain.map({ x: .2, y: .3 });
  const finger = { x: .8, y: .9 }, endpoint = gain.map(finger);
  for (let frame = 0; frame < 500; frame += 1) assert.deepEqual(gain.map(finger), endpoint);
  assert(endpoint.x < finger.x); assert(endpoint.y < finger.y);
});

await test("starting outside the activity area anchors at the edge and moves inward continuously", () => {
  const gain = PinchOwner.createDrawingGain();
  const outside = { x: -.2, y: 1.2 };
  assert.deepEqual(gain.map(outside), { x: 0, y: 1 });
  assert.deepEqual(gain.map(outside), { x: 0, y: 1 });
  const inside = gain.map({ x: -.1, y: 1.1 });
  assert(Math.abs(inside.x - .082) < 1e-12);
  assert(Math.abs(inside.y - .918) < 1e-12);
});

await test("ending a writing stroke resets its movement anchor for the next stroke", async () => {
  const r = await runtime();
  r.run("drawingGain.map({x:.1,y:.2});drawingGain.map({x:.5,y:.6});finishStroke();");
  const next = r.run("drawingGain.map({x:.7,y:.8})");
  assert.equal(next.x, .7); assert.equal(next.y, .8);
});

await test("reduced writing motion can still reach both canvas edges within one stroke", async () => {
  for (const [x, expected] of [[.195, 0], [-.135, 1]]) {
    const r = await runtime();
    const initial = r.sample(pen({ x: .03, y: .04 }), 100);
    assert(initial.drawingActive); const stroke = initial.currentStroke;
    for (let frame = 1; frame <= 24; frame += 1) {
      const state = r.sample(pen({ x, y: .04 }), 100 + frame * 16);
      assert(state.drawingActive); assert.equal(state.currentStroke, stroke);
    }
    assert(Math.abs(r.state().currentStroke.points.at(-1).x - expected) < 1e-8);
  }
});

await test("writing gain leaves hover, region selection, and 3D coordinates at full reach", async () => {
  const hover = await runtime();
  hover.run("drawingGain.map({x:.1,y:.1});drawingGain.map({x:.8,y:.8});");
  hover.sample(hand({ x: .05, y: .03 }), 100);
  let expected = hover.run("mapTipToCanvas(testImage[8],drawingCanvas)");
  assert(Math.abs(parseFloat(hover.ids.get("tipCursor").style.left) / 100 - expected.x) < 1e-8);
  assert(Math.abs(parseFloat(hover.ids.get("tipCursor").style.top) / 100 - expected.y) < 1e-8);

  const selection = await runtime();
  selection.run("drawingGain.map({x:.1,y:.1});drawingGain.map({x:.8,y:.8});");
  for (const timestamp of [100, 220, 340]) selection.sample(regionHand({ x: .05, y: .03 }), timestamp);
  expected = selection.run("mapCameraPoint(testImage[8],true)");
  const drag = selection.run("imageWorkflow.getState().drag");
  assert(drag); assert(Math.abs(drag.x - expected.x) < 1e-8); assert(Math.abs(drag.y - expected.y) < 1e-8);

  const model = await runtime(); await model.ids.get("modelWorkspaceBtn").click(); model.flushFrames();
  model.run("drawingGain.map({x:.1,y:.1});drawingGain.map({x:.8,y:.8});");
  model.sample(hand({ x: .05, y: .03 }), 100);
  expected = model.run("mapCameraPoint(testImage[8])");
  assert(Math.abs(parseFloat(model.ids.get("tipCursor").style.left) / 100 - expected.x) < 1e-8);
  assert(Math.abs(parseFloat(model.ids.get("tipCursor").style.top) / 100 - expected.y) < 1e-8);
});

await test("the writing cursor follows the reduced ink position throughout a stroke", async () => {
  const r = await runtime();
  for (let frame = 0; frame < 8; frame += 1) {
    const state = r.sample(pen({ x: -.06 + frame * .015, y: frame * .004 }), 100 + frame * 16);
    assert(state.drawingActive);
    const tip = state.currentStroke.points.at(-1);
    assert(Math.abs(parseFloat(r.ids.get("tipCursor").style.left) / 100 - tip.x) < 1e-8);
    assert(Math.abs(parseFloat(r.ids.get("tipCursor").style.top) / 100 - tip.y) < 1e-8);
  }
});

await test("an extended single index without thumb contact cannot draw", async () => {
  const r = await runtime();
  for (let frame = 0; frame < 8; frame += 1) {
    const state = r.sample(hand({ x: -.05 + frame * .01 }), 100 + frame * 16);
    assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
  }
  assert.equal(r.state().strokes.length, 0);
});

await test("pinch drawing does not depend on index extension or other finger flexion", async () => {
  for (const options of [{ index: 90 }, { index: 145, dip: 120 }, { middle: 179 }, { ring: 179, pinky: 179 }]) {
    const r = await runtime(); const state = r.sample(pen(options), 100);
    assert(state.drawingActive, JSON.stringify(options)); assert.equal(state.currentStroke.tool, "pen");
  }
});

await test("pinch start has a strict 0.25 boundary", async () => {
  for (const ratio of [.25, .30, .35, .5]) {
    const r = await runtime(); const fixture = exactPinch(ratio);
    assert.equal(r.run(`drawingPinchRatio(${JSON.stringify(fixture.image)},${JSON.stringify(fixture.world)})`), ratio);
    const state = r.sample(fixture, 100); assert(!state.drawingActive, `ratio ${ratio}`); assert.equal(state.currentStroke, null);
  }
  const r = await runtime(); assert(r.sample(exactPinch(.249), 100).drawingActive);
});

await test("pinch jitter below 0.35 retains the same stroke", async () => {
  const r = await runtime(); r.sample(pen(), 100); const stroke = r.state().currentStroke;
  for (const [frame, pinch] of [.20, .25, .30, .349, .27, .1].entries()) {
    const state = r.sample(pen({ pinch, x: frame * .02 }), 116 + frame * 16);
    assert(state.drawingActive, `ratio ${pinch}`); assert(state.drawingPinchActive); assert.equal(state.currentStroke, stroke); assert.equal(state.strokes.length, 0);
  }
});

await test("visible fingertip contact survives erroneous world and image depth", async () => {
  const r = await runtime(); const first = r.sample(pen(), 100);
  assert(first.drawingActive); const stroke = first.currentStroke;
  for (const [frame, depth] of [.035, .05, .065].entries()) {
    const fixture = pen({ x: frame * .02 });
    fixture.world[4].z = fixture.world[8].z + depth;
    fixture.image[4].z = fixture.image[8].z + 3 * depth;
    const state = r.sample(fixture, 116 + frame * 16);
    assert(state.drawingActive); assert.equal(state.currentStroke, stroke); assert.equal(state.strokes.length, 0);
    const measurement = r.run("drawingPinchMeasurement(testImage,testWorld)");
    assert(Math.abs(measurement.ratio - .1) < 1e-9);
    assert(measurement.spatialRatio > .5);
  }
});

await test("visible pinch release stops even if world landmarks still say contact", async () => {
  const r = await runtime(); r.sample(pen(), 100); const count = r.state().currentStroke.points.length;
  const released = pen({ x: .1 }); released.image = pen({ pinch: .5, x: .1 }).image;
  const state = r.sample(released, 116);
  assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
  assert.equal(state.strokes[0].points.length, count);
  assert.equal(r.run("drawingPinchMeasurement(testImage,testWorld).spatialRatio"), .1);
});

await test("foreshortened palm width is stabilized by visible palm length", async () => {
  const r = await runtime(); const fixture = pen({ pinch: .7 });
  fixture.image[5] = { x: .48, y: .7, z: 0 }; fixture.image[17] = { x: .52, y: .7, z: 0 };
  fixture.image[0] = { x: .5, y: .85, z: 0 }; fixture.image[9] = { x: .5, y: .5, z: 0 };
  fixture.image[8] = { x: .48, y: .4, z: 0 }; fixture.image[4] = { x: .5, y: .4, z: 0 };
  const state = r.sample(fixture, 100); assert(state.drawingActive);
  const expected = .02 / (.65 * .35 * 720 / 1280);
  assert(Math.abs(r.run("drawingPinchRatio(testImage,testWorld)") - expected) < 1e-8);
});

await test("opening pinch at 0.35 immediately stops without adding a release-frame point", async () => {
  const r = await runtime(); r.sample(exactPinch(.1), 100); r.sample(pen({ x: .02 }), 116);
  const previousPoints = r.state().currentStroke.points.map(point => ({ ...point }));
  const state = r.sample(exactPinch(.35), 132);
  assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 1);
  assert.equal(JSON.stringify(state.strokes[0].points), JSON.stringify(previousPoints));
});

await test("released pinch cannot restart in the hysteresis band", async () => {
  const r = await runtime(); r.sample(pen(), 100); r.sample(pen({ pinch: .4 }), 116);
  for (const [frame, pinch] of [.30, .349, .25].entries()) {
    const state = r.sample(exactPinch(pinch), 132 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  }
  const state = r.sample(pen({ x: .1 }), 180);
  assert(state.drawingActive); assert.equal(state.strokes.length, 1); assert.equal(state.currentStroke.points.length, 1);
});

await test("small gesture eraser requires a stable pose before erasing", async () => {
  const r = await runtime(); assert(!r.sample(small(), 100).drawingActive); assert(!r.sample(small(), 150).drawingActive);
  assert.equal(r.state().currentStroke, null); const state = r.sample(small(), 181);
  assert(state.drawingActive); assert(state.currentStroke.eraser); assert.equal(state.currentStroke.tool, "eraser-small");
});

await test("small gesture eraser keeps its fixed 36 pixel footprint across brush sizes", async () => {
  for (const width of [4, 32]) {
    const r = await runtime(); r.ids.get("brushSize").value = String(width); await r.ids.get("brushSize").dispatch("input");
    r.sample(small(), 100); const state = r.sample(small(), 181);
    assert.equal(state.currentStroke.tool, "eraser-small"); assert.equal(state.currentStroke.size, 36); assert.equal(state.currentStroke.eraser, true);
  }
});

await test("small eraser keeps relaxed entry for naturally extended fingers", async () => {
  const fixture = small({ index: 155, middle: 155, dip: 145 });
  const r = await runtime(); assert(!r.sample(fixture, 100).drawingActive);
  const state = r.sample(fixture, 181);
  assert(state.drawingActive); assert.equal(state.currentStroke.tool, "eraser-small");
});

await test("visible small eraser survives erroneous world finger depths", async () => {
  const r = await runtime(); const visible = distortedWorldWithAccuratePlane(small());
  assert(!r.sample(visible, 100).drawingActive);
  const state = r.sample(visible, 181);
  assert(state.drawingActive); assert.equal(state.currentStroke.tool, "eraser-small");
  assert.equal(r.run("classifyDrawingGesture(testImage,testWorld).geometrySource"), "平面");
});

await test("planar eraser fallback still rejects visibly spread V and palm", async () => {
  for (const fixture of [small, openPalm]) {
    const r = await runtime(); const visible = distortedWorldWithAccuratePlane(fixture({ spread: 5 }));
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(visible, 100 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
    }
  }
});

await test("planar fallback cannot turn genuinely curled fingers into small eraser entry", async () => {
  for (const angle of [100, 110, 120, 130, 140]) {
    const r = await runtime(); const fixture = visiblyFoldOtherFingers(small({ index: angle, middle: angle }));
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive, "PIP " + angle); assert.equal(state.currentStroke, null);
    }
  }
});

await test("planar fallback cannot keep small eraser active after fingers genuinely curl", async () => {
  for (const angle of [100, 110, 120, 130]) {
    const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181);
    const before = r.state().currentStroke.points.length;
    const fixture = visiblyFoldOtherFingers(small({ index: angle, middle: angle, x: .1 }));
    const state = r.sample(fixture, 197);
    assert(!state.drawingActive, "PIP " + angle); assert.equal(state.currentStroke, null);
    assert.equal(state.strokes[0].points.length, before);
  }
});

await test("small planar fallback respects genuine DIP flexion for entry and continuation", async () => {
  for (const angle of [100, 110, 120, 130]) {
    const fixture = visiblyFoldOtherFingers(small({ dip: { 5: angle, 9: angle } }));
    const r = await runtime();
    assert(!r.sample(fixture, 100).drawingActive, "entry DIP " + angle);
    assert(!r.sample(fixture, 181).drawingActive, "entry DIP " + angle);
    if (angle >= 125) continue;
    r.sample(small(), 197); assert(r.sample(small(), 278).drawingActive);
    const state = r.sample(fixture, 294); assert(!state.drawingActive, "continuation DIP " + angle); assert.equal(state.currentStroke, null);
  }
});

await test("open palm never becomes an eraser when its thumb curls toward the camera", async () => {
  for (const angle of [100, 110, 115, 120, 130, 165, 179]) {
    const r = await runtime(); const fixture = thumbCurlTowardCamera(angle);
    const projected = fixture.image.map(point => ({ ...point, z: 0 }));
    assert.equal(r.run("classifyDrawingGeometry(drawingHandGeometry(" + JSON.stringify(projected) + ",null),null).eraser"), null);
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive, "thumb IP " + angle); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    }
  }
});

await test("confirmed small eraser tolerates moderate angle noise without splitting", async () => {
  const r = await runtime(); r.sample(small(), 100); const first = r.sample(small(), 181);
  const state = r.sample(small({ index: 145, middle: 145, dip: 135, x: .02 }), 197);
  assert(state.drawingActive); assert.equal(state.currentStroke, first.currentStroke); assert.equal(state.strokes.length, 0);
});

await test("continuation-only small eraser pose cannot activate from idle", async () => {
  const r = await runtime(); const fixture = small({ index: 145, middle: 145, dip: 135 });
  for (let frame = 0; frame < 8; frame += 1) { const state = r.sample(fixture, 100 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null); }
});

await test("changing an active small eraser to an open palm stops immediately and cannot rearm erasing", async () => {
  for (const fixture of [
    openPalm({ x: .1 }),
    thumbAngles(openPalm({ index: 162, middle: 162, ring: 162, pinky: 162, dip: 157, x: .1 }), { mcp: 145, ip: 160 }),
    distortedWorldWithAccuratePlane(openPalm({ x: .1 }))
  ]) {
    const r = await runtime(); r.sample(small(), 100);
    assert.equal(r.sample(small(), 181).currentStroke.tool, "eraser-small");
    const before = r.state().currentStroke.points.length;
    for (let frame = 0; frame < 12; frame += 1) {
      const state = r.sample(fixture, 197 + frame * 16);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
      assert.equal(state.strokes.length, 1); assert.equal(state.strokes[0].points.length, before);
    }
  }
});

await test("straight and moderately curled open palms never enter gesture erasing", async () => {
  for (const fixture of [
    openPalm(), openPalm({ thumb: "folded" }),
    thumbAngles(openPalm({ index: 167, middle: 167, ring: 167, pinky: 167, dip: 162 }), { mcp: 150, ip: 165 }),
    thumbAngles(openPalm({ index: 155, middle: 155, ring: 155, pinky: 155, dip: 145 }), { mcp: 130, ip: 145 }),
    thumbAngles(openPalm({ index: 145, middle: 145, ring: 145, pinky: 145, dip: 135 }), { mcp: 115, ip: 130 })
  ]) {
    const r = await runtime();
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    }
    assert.equal(r.state().strokes.length, 0);
  }
});

await test("open palms remain non-erasing with slight PIP curl in any finger", async () => {
  for (const finger of ["index", "middle", "ring", "pinky"]) for (const angle of [164, 159]) {
    const r = await runtime(); const fixture = openPalm({ [finger]: angle });
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive, finger + " PIP " + angle); assert.equal(state.currentStroke, null);
    }
  }
});

await test("open palms remain non-erasing with slight DIP curl in any finger", async () => {
  for (const base of [5, 9, 13, 17]) for (const angle of [159, 154]) {
    const r = await runtime(); const fixture = openPalm({ dip: { [base]: angle } });
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive, "DIP " + base + " " + angle); assert.equal(state.currentStroke, null);
    }
  }
});

await test("open palms remain non-erasing across thumb joint angles", async () => {
  for (const angles of [{ mcp: 170, ip: 159 }, { mcp: 170, ip: 154 }, { mcp: 144, ip: 175 }, { mcp: 139, ip: 175 }]) {
    const r = await runtime(); const fixture = thumbAngles(openPalm(), angles);
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null);
    }
  }
});

await test("open palms remain non-erasing with palm knuckle flexion and straight PIP and DIP", async () => {
  for (const base of [5, 9, 13, 17]) for (const angle of [154, 149]) {
    const r = await runtime(); const fixture = bendFingerAtMcp(openPalm(), base, angle);
    const geometry = r.run("drawingHandGeometry(" + JSON.stringify(fixture.image) + "," + JSON.stringify(fixture.world) + ")");
    assert(geometry.pip.every(value => value > 178) && geometry.dip.every(value => value > 178));
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive, "MCP " + base + " " + angle); assert.equal(state.currentStroke, null);
    }
  }
});

await test("open palms cannot become erasers through erroneous world depth fallback", async () => {
  for (const options of [{}, { spread: 5 }, { thumb: "folded" }, { index: 162, middle: 162, ring: 162, pinky: 162 }]) {
    const r = await runtime(); const fixture = distortedWorldWithAccuratePlane(openPalm(options));
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(fixture, 100 + frame * 16);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    }
  }
});

await test("spread V and spread palm cannot activate gesture erasing", async () => {
  for (const fixture of [small, openPalm]) {
    const r = await runtime();
    for (let frame = 0; frame < 12; frame += 1) {
      const state = r.sample(fixture({ spread: 5 }), 100 + frame * 16); assert(!state.drawingActive); assert.equal(state.gestureEraser, null);
    }
    assert.equal(r.state().strokes.length, 0); assert.equal(r.state().currentStroke, null);
  }
});

await test("small eraser rejects an extended thumb", async () => {
  const r = await runtime();
  for (let frame = 0; frame < 8; frame += 1) { const state = r.sample(small({ thumb: "extended" }), 100 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null); }
});

await test("invalid pose stops erasing on its first sample", async () => {
  const r = await runtime(); r.sample(small(), 100); let state = r.sample(small(), 181); assert(state.drawingActive);
  const before = state.currentStroke.points.length; state = r.sample(small({ spread: 5, x: .1 }), 197);
  assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 1); assert.equal(state.strokes[0].points.length, before);
});

await test("brief pose rejection can resume confirmed erasing without bridging the gap", async () => {
  for (const fixture of [small]) {
    const r = await runtime(); r.sample(fixture({ x: -.08 }), 100); r.sample(fixture({ x: -.06 }), 181);
    const oldPoints = r.state().currentStroke.points.map(point => ({ ...point }));
    let state = r.sample(fixture({ spread: 5, x: .1 }), 197);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 1);
    assert.equal(JSON.stringify(state.strokes[0].points), JSON.stringify(oldPoints));
    state = r.sample(fixture({ x: .12 }), 213);
    assert(state.drawingActive); assert(state.currentStroke.eraser); assert.equal(state.currentStroke.points.length, 1);
    assert.equal(state.strokes.length, 1);
  }
});

await test("expired rejected eraser pose needs fresh confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181);
  r.sample(small({ spread: 5, x: .1 }), 197);
  let state = r.sample(small({ x: .12 }), 358);
  assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  state = r.sample(small({ x: .12 }), 439); assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1);
});

await test("pinch drawing cancels cached eraser confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181);
  let state = r.sample(pen({ x: .02 }), 197); assert(state.drawingActive); assert.equal(state.currentStroke.tool, "pen");
  state = r.sample(small({ x: .05 }), 213); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  state = r.sample(small({ x: .05 }), 294); assert(state.drawingActive); assert.equal(state.currentStroke.tool, "eraser-small");
});

await test("eraser transition to pen does not bridge across tools", async () => {
  const r = await runtime(); r.sample(pen({ x: -.08 }), 100); r.sample(pen({ x: -.06 }), 116);
  r.sample(small(), 132); let state = r.sample(small({ x: .04 }), 213);
  assert(state.drawingActive); assert.equal(state.strokes.length, 1); assert.equal(state.currentStroke.tool, "eraser-small");
  state = r.sample(pen({ x: .1 }), 229); assert(state.drawingActive); assert.equal(state.currentStroke.tool, "pen");
  assert.equal(state.currentStroke.points.length, 1); assert.equal(state.strokes.length, 2);
});

await test("open palm creates no stroke and small eraser still needs fresh confirmation", async () => {
  const r = await runtime(); r.sample(openPalm(), 100); r.sample(openPalm(), 181);
  assert.equal(r.state().currentStroke, null); assert.equal(r.state().strokes.length, 0);
  let state = r.sample(small({ x: .02 }), 197); assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 0);
  state = r.sample(small({ x: .1 }), 278); assert(state.drawingActive); assert.equal(state.currentStroke.tool, "eraser-small"); assert.equal(state.currentStroke.points.length, 1);
});

await test("undo removes the last erase operation while preserving ink", async () => {
  const r = await runtime(); r.sample(pen(), 100); r.sample(null, 116); r.sample(small(), 132); r.sample(small({ x: .05 }), 213); r.sample(null, 229);
  assert.equal(r.state().strokes.length, 2); assert(r.state().strokes[1].eraser);
  await r.ids.get("undoBtn").click(); const state = r.state(); assert.equal(state.strokes.length, 1); assert.equal(state.strokes[0].tool, "pen");
  assert(state.rendered.includes("destination-out"));
});

await test("missing hand clears eraser confirmation and returning starts anew", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181); r.sample(null, 197);
  let state = r.sample(small({ x: .1 }), 213); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  state = r.sample(small({ x: .1 }), 294); assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1); assert.equal(state.strokes.length, 1);
});

await test("long gap between samples discards eraser confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 150);
  assert(!r.sample(small(), 400).drawingActive); assert(r.sample(small(), 481).drawingActive);
});

await test("invalid intermediate pose discards eraser confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 150); r.sample(small({ spread: 5 }), 166);
  assert(!r.sample(small(), 182).drawingActive); assert(r.sample(small(), 263).drawingActive);
});

await test("clear and primary-hand changes discard gesture confirmation", async () => {
  for (const id of ["clearBtn", "primaryHandSelect"]) {
    const r = await runtime(); r.sample(small(), 100); r.sample(small(), 150);
    if (id === "clearBtn") await r.ids.get(id).click();
    else { r.ids.get(id).value = "Left"; await r.ids.get(id).dispatch("change"); }
    assert(!r.sample(small(), 181).drawingActive, id); assert.equal(r.state().currentStroke, null);
    assert(r.sample(small(), 262).drawingActive, id);
  }
});

await test("pause blocks all gestures and resume requires fresh confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181); await r.ids.get("drawToggleBtn").click();
  for (let frame = 0; frame < 8; frame += 1) { const state = r.sample(small(), 197 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null); }
  await r.ids.get("drawToggleBtn").click(); assert(!r.sample(small(), 400).drawingActive); assert(r.sample(small(), 481).drawingActive);
});

await test("3D workspace cannot erase and returning requires fresh confirmation", async () => {
  const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181); await r.ids.get("modelWorkspaceBtn").click(); r.flushFrames();
  for (let frame = 0; frame < 8; frame += 1) { const state = r.sample(small(), 197 + frame * 16); assert(!state.drawingActive); assert.equal(state.currentStroke, null); }
  await r.ids.get("drawWorkspaceBtn").click(); r.flushFrames(); assert(!r.sample(small(), 400).drawingActive); assert(r.sample(small(), 481).drawingActive);
});

await test("missing hand clears drawing pinch before a middle-band sample returns", async () => {
  const r = await runtime(); r.sample(pen(), 100); r.sample(null, 116);
  let state = r.sample(pen({ pinch: .3, x: .1 }), 132);
  assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
  state = r.sample(pen({ x: .1 }), 148); assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1); assert.equal(state.strokes.length, 1);
});

await test("nonfinite image coordinates never add drawing or erasing points", async () => {
  for (const fixture of [pen, small, openPalm]) {
    const r = await runtime(); r.sample(fixture(), 100); r.sample(fixture(), 181);
    const invalid = fixture({ x: .1 }); invalid.image[8].x = NaN;
    const state = r.sample(invalid, 197); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
    assert(state.strokes.every(stroke => stroke.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
  }
});

await test("small eraser geometry is invariant to rigid hand rotation", async () => {
  for (const rotation of [-.7, 0, .7]) {
    const r = await runtime(); r.sample(small({ rotation }), 100); const state = r.sample(small({ rotation }), 181);
    assert(state.drawingActive); assert(state.currentStroke.eraser); assert.equal(state.currentStroke.tool, "eraser-small");
  }
});

await test("rigid hand rotation cannot turn an open palm into an eraser", async () => {
  for (const rotation of [-.7, 0, .7]) {
    const r = await runtime();
    for (let frame = 0; frame < 8; frame += 1) {
      const state = r.sample(openPalm({ rotation }), 100 + frame * 16);
      assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
    }
  }
});

await test("primary mismatch and ambiguous hands cannot erase", async () => {
  for (const labels of [["Left"], ["Right", "Right"]]) {
    const r = await runtime(); r.sample(small(), 100); r.sample(small(), 181);
    const fixture = small();
    r.run(`stream={};video.readyState=2;video.currentTime=1;handLandmarker={detectForVideo(){return {landmarks:${JSON.stringify(labels.map(() => fixture.image))},worldLandmarks:${JSON.stringify(labels.map(() => fixture.world))},handednesses:${JSON.stringify(labels.map(categoryName => [{ categoryName }]))}};}};processFrame(197);`);
    let state = r.state(); assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes.length, 1);
    state = r.sample(small(), 213); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  }
});

await test("brush size change creates a clean stroke with the selected width", async () => {
  const r = await runtime(); r.sample(pen({ x: -.08 }), 100); r.sample(pen({ x: -.04 }), 116); r.sample(pen(), 132);
  assert(r.state().currentStroke.points.length > 20);
  r.ids.get("brushSize").value = "32"; await r.ids.get("brushSize").dispatch("input");
  const state = r.sample(pen({ x: .02 }), 148);
  assert(state.drawingActive); assert.equal(state.strokes.length, 1); assert.equal(state.currentStroke.size, 32);
  assert.equal(state.currentStroke.points.length, 1); assert(state.strokes[0].points.every(Boolean));
});

await test("changing brush width while holding a steady pinch does not add a delayed jump", async () => {
  const r = await runtime();
  r.sample(pen({ x: -.08, y: .04 }), 100);
  for (let frame = 1; frame <= 40; frame += 1) r.sample(pen({ x: .05, y: .04 }), 100 + frame * 16);
  r.ids.get("brushSize").value = "32"; await r.ids.get("brushSize").dispatch("input");
  let state = r.sample(pen({ x: .05, y: .04 }), 756);
  assert(state.drawingActive); assert.equal(state.currentStroke.size, 32); assert.equal(state.currentStroke.points.length, 1);
  const stroke = state.currentStroke, first = { ...stroke.points[0] };
  state = r.sample(pen({ x: .05, y: .04 }), 772);
  assert.equal(state.currentStroke, stroke); assert.equal(stroke.points.length, 1);
  assert.equal(stroke.points[0].x, first.x); assert.equal(stroke.points[0].y, first.y);
  assert(Math.abs(parseFloat(r.ids.get("tipCursor").style.left) / 100 - first.x) < .35 / 900);
  assert(Math.abs(parseFloat(r.ids.get("tipCursor").style.top) / 100 - first.y) < .35 / 550);
});

await test("pause, primary-hand changes, tools, and workspaces reset drawing pinch", async () => {
  for (const action of ["pause", "primary-hand", "eraser", "3d", "clear", "console-layout"]) {
    const r = await runtime(); r.sample(pen(), 100); r.sample(pen({ pinch: .3, x: .02 }), 116);
    assert(r.state().drawingPinchActive);
    if (action === "pause") { await r.ids.get("drawToggleBtn").click(); await r.ids.get("drawToggleBtn").click(); }
    if (action === "primary-hand") { r.ids.get("primaryHandSelect").value = "Left"; await r.ids.get("primaryHandSelect").dispatch("change"); }
    if (action === "eraser") await r.ids.get("eraserBtn").click();
    if (action === "3d") { await r.ids.get("modelWorkspaceBtn").click(); r.flushFrames(); await r.ids.get("drawWorkspaceBtn").click(); r.flushFrames(); }
    if (action === "clear") await r.ids.get("clearBtn").click();
    if (action === "console-layout") { await r.ids.get("consoleToggleBtn").click(); r.flushFrames(); }
    assert(!r.state().drawingPinchActive, action);
    const state = r.sample(pen({ pinch: .3, x: .1 }), 132);
    assert(!state.drawingActive, action); assert.equal(state.currentStroke, null, action);
  }
});

await test("unrelated invalid finger angles do not prevent a valid pinch", async () => {
  const r = await runtime(); const fixture = pen();
  for (const index of [6, 10, 14, 18]) fixture.world[index] = { ...fixture.world[index - 1] };
  fixture.image = project(fixture.world);
  const state = r.sample(fixture, 100);
  assert(state.drawingActive); assert.equal(state.currentStroke.tool, "pen");
  assert.equal(r.diagnose(), "正在绘画"); assert.equal(r.ids.get("cameraPenReason").dataset.state, "drawing");
  for (const id of ["cameraIndexCondition", "cameraMiddleCondition", "cameraRingCondition", "cameraPinkyCondition"]) assert.equal(r.ids.get(id).textContent, "不限");
});

await test("degenerate thumb cannot be accepted as a folded thumb for small eraser", async () => {
  const r = await runtime();
  for (let frame = 0; frame < 8; frame += 1) {
    const state = r.sample(degenerateThumb(small()), 100 + frame * 16);
    assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.gestureEraser, null);
  }
  assert.equal(r.run("classifyDrawingGesture(testImage,testWorld).thumbFolded"), false);
});

await test("world and image geometry both invalid cannot keep a pinch active", async () => {
  const r = await runtime(); r.sample(pen(), 100); const fixture = pen();
  for (const index of [0, 5, 9, 17]) fixture.world[index] = { x: 0, y: 0, z: 0 };
  fixture.image = project(fixture.world);
  const state = r.sample(fixture, 116);
  assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
  assert(r.diagnose().includes("无效")); assert.equal(r.ids.get("cameraPenReason").dataset.state, "paused");
});

await test("missing or nonfinite depth does not invalidate visible pinch contact", async () => {
  for (const depth of [undefined, NaN]) {
    const r = await runtime(); const fixture = pen();
    for (const index of [0, 4, 5, 8, 9, 17]) { fixture.image[index].z = depth; fixture.world[index].z = depth; }
    const state = r.sample(fixture, 100); assert(state.drawingActive); assert(state.drawingPinchActive);
    assert.equal(r.run("drawingPinchRatio(testImage,testWorld)"), .1);
  }
});

await test("gesture eraser overrides manual eraser and returns to pen", async () => {
  const r = await runtime(); await r.ids.get("eraserBtn").click();
  let state = r.sample(pen(), 100); assert.equal(state.currentStroke.tool, "manual-eraser");
  r.sample(small(), 116); state = r.sample(small(), 197); assert.equal(state.currentStroke.tool, "eraser-small");
  assert(!state.isEraser); state = r.sample(pen({ x: .1 }), 213);
  assert.equal(state.currentStroke.tool, "pen"); assert(!state.currentStroke.eraser); assert.equal(state.currentStroke.points.length, 1);
});

await test("world landmark availability does not change a visible pinch or split its stroke", async () => {
  const r = await runtime(); const fixture = pen({ index: 145, dip: 135 });
  const first = r.sample(fixture, 100); assert(first.drawingActive);
  const stroke = first.currentStroke;
  const fallback = r.sample({ image: fixture.image, world: null }, 116);
  assert(fallback.drawingActive); assert.equal(fallback.currentStroke, stroke); assert.equal(fallback.strokes.length, 0);
  const recovered = r.sample(fixture, 132);
  assert(recovered.drawingActive); assert.equal(recovered.currentStroke, stroke); assert.equal(recovered.strokes.length, 0);
});

await test("pinch ratio is invariant to rigid motion, scale, and image fallback", async () => {
  const r = await runtime();
  for (const rotation of [-.7, 0, .7]) for (const scale of [.5, 1, 2]) {
    const fixture = pen({ pinch: .21, rotation, x: .02, y: -.01 });
    fixture.world = fixture.world.map(point => ({ x: point.x * scale, y: point.y * scale, z: point.z * scale }));
    fixture.image = project(fixture.world);
    for (const world of [fixture.world, null]) {
      const ratio = r.run(`drawingPinchRatio(${JSON.stringify(fixture.image)},${JSON.stringify(world)})`);
      assert(Math.abs(ratio - .21) < 1e-10, `ratio ${ratio}, rotation ${rotation}, scale ${scale}, world ${!!world}`);
    }
  }
});

await test("invalid world pinch geometry falls back to complete image geometry", async () => {
  const r = await runtime(); const fixture = pen(); fixture.world[5] = { ...fixture.world[17] };
  const state = r.sample(fixture, 100); assert(state.drawingActive); assert(state.drawingPinchActive);
  assert(Math.abs(r.run("drawingPinchRatio(testImage,testWorld)") - .1) < 1e-10);
});

await test("manual eraser also uses pinch activation and immediate release", async () => {
  const r = await runtime(); await r.ids.get("eraserBtn").click();
  assert(!r.sample(hand(), 100).drawingActive);
  let state = r.sample(pen(), 116); assert(state.drawingActive); assert.equal(state.currentStroke.tool, "manual-eraser");
  const count = state.currentStroke.points.length;
  state = r.sample(pen({ pinch: .5, x: .1 }), 132);
  assert(!state.drawingActive); assert.equal(state.currentStroke, null); assert.equal(state.strokes[0].points.length, count);
});

await test("eraser candidates clear a live pinch before their confirmation", async () => {
  for (const fixture of [small]) {
    const r = await runtime(); r.sample(pen(), 100);
    let state = r.sample(fixture(), 116); assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
    state = r.sample(pen({ pinch: .3 }), 132); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
    state = r.sample(pen(), 148); assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1);
  }
});

await test("pinch diagnostic fields match both drawing and released states", async () => {
  const r = await runtime(); r.sample(pen(), 100); assert.equal(r.diagnose(), "正在绘画");
  assert.equal(r.ids.get("cameraPenReason").dataset.state, "drawing");
  assert(r.ids.get("cameraPinchRatio").textContent.includes("0.10"));
  assert(r.ids.get("cameraPinchCondition").textContent);
  r.sample(pen({ pinch: .4 }), 116); r.diagnose(116);
  assert.equal(r.ids.get("cameraPenReason").dataset.state, "paused");
  assert(r.ids.get("cameraPinchRatio").textContent.includes("0.40"));
});

await test("diagnostics expose depth disagreement without changing pinch state", async () => {
  const r = await runtime(); const fixture = pen();
  fixture.world[4].z = fixture.world[8].z + .04;
  r.sample(fixture, 100); assert.equal(r.diagnose(), "正在绘画");
  const detail = r.ids.get("cameraGestureDetail").textContent;
  assert(detail.includes("平面 0.100")); assert(detail.includes("空间")); assert(!detail.includes("空间 0.100"));
  assert.equal(r.ids.get("cameraPinchRatioRow").dataset.pass, "true");
});

await test("pinch draws at the index tip instead of the thumb or pinch midpoint", async () => {
  const r = await runtime(); const fixture = pen({ pinch: .1 });
  const first = r.sample(fixture, 100); const point = { ...first.currentStroke.points[0] };
  const expected = r.run("mapTipToCanvas(testImage[8],drawingCanvas)");
  assert(Math.abs(point.x - expected.x) < 1e-8); assert(Math.abs(point.y - expected.y) < 1e-8);
  const movedThumb = pen({ pinch: .2 }); const state = r.sample(movedThumb, 116);
  assert(state.drawingActive); assert.equal(state.currentStroke.points.length, 1);
  assert.equal(state.currentStroke.points[0].x, point.x); assert.equal(state.currentStroke.points[0].y, point.y);
});

await test("3D pinch latch cannot activate drawing in the middle band", async () => {
  const r = await runtime(); r.run("pinchActive=true;drawingPinchActive=false;");
  const state = r.sample(pen({ pinch: .3 }), 100);
  assert(!state.drawingActive); assert(!state.drawingPinchActive); assert.equal(state.currentStroke, null);
});

await test("primary mismatch and ambiguous hands reset a live drawing pinch", async () => {
  for (const labels of [["Left"], ["Right", "Right"]]) {
    const r = await runtime(); r.sample(pen(), 100);
    const fixture = pen({ pinch: .3 });
    r.run(`stream={};video.readyState=2;video.currentTime=1;handLandmarker={detectForVideo(){return {landmarks:${JSON.stringify(labels.map(() => fixture.image))},worldLandmarks:${JSON.stringify(labels.map(() => fixture.world))},handednesses:${JSON.stringify(labels.map(categoryName => [{ categoryName }]))}};}};processFrame(116);`);
    assert(!r.state().drawingPinchActive); assert(!r.state().drawingActive); assert.equal(r.state().currentStroke, null);
    const state = r.sample(fixture, 132); assert(!state.drawingActive); assert.equal(state.currentStroke, null);
  }
});

for (const report of reports) {
  console.log(`${report.pass ? "PASS" : "FAIL"} ${report.name}`);
  if (!report.pass) console.error(report.error);
}
const passed = reports.filter(report => report.pass).length;
console.log(`\n${passed}/${reports.length} synthetic drawing checks passed. Live camera and browser rendering are not covered.`);
if (passed !== reports.length) process.exitCode = 1;
