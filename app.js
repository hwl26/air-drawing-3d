import { FilesetResolver, HandLandmarker } from "./vendor/mp/vision_bundle.mjs";
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const MODEL_ROOT = "partof_BP3D_4.0_obj_99/partof_BP3D_4.0_obj_99/";
const MODEL_CATALOG_URL = "model-catalog.json";
const HYPER3D_API_BASE = window.__AIR_DRAWING_API_BASE__ || "";

const MODEL_URL = "./vendor/mp/hand_landmarker.task";
const WASM_URL = "./vendor/mp/wasm";
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const STROKE_RESUME_WINDOW_MS = 420;
const GESTURE_HOLD_MS = 240;

const $ = (id) => document.getElementById(id);
const video = $("video");
const landmarkCanvas = $("landmarkCanvas");
const drawingCanvas = $("drawingCanvas");
const drawingWrap = $("drawingWrap");
const modelViewer = $("modelViewer");
const stageHandCanvas = $("stageHandCanvas");
const stageVideoCanvas = $("stageVideoCanvas");
const landmarkCtx = landmarkCanvas.getContext("2d");
const drawingCtx = drawingCanvas.getContext("2d");
const stageHandCtx = stageHandCanvas.getContext("2d");
const stageVideoCtx = stageVideoCanvas.getContext("2d");
let handLandmarker = null;
let modelPromise = null;
let stream = null;
let animationId = null;
let frameCallbackId = null;
let frameLoopMode = null;
let lastVideoTime = -1;
let fpsWindowStart = performance.now();
let fpsFrameCount = 0;
let smoothedTip = null;
let lastFilterTime = 0;
let filterX = null;
let filterY = null;
let handPresent = false;
let pinchActive = false;
let indexModeActive = false;
let drawingActive = false;
let drawEnabled = true;
let gestureMode = "index";
let primaryHand = "Right";
// MediaPipe's handedness can differ between browser/camera pipelines because
// some drivers mirror the selfie frame before inference. Keep a user-visible
// correction switch instead of silently guessing.
let swapHandLabels = false;
let singleScreen = false;
let isEraser = false;
let selectionMode = false;
let brushColor = "#54E6C0";
let brushSize = 8;
let strokes = [];
let currentStroke = null;
let selectedStroke = null;
let selectionDrag = null;
let missingSince = 0;
let pausedPoint = null;
let drawGestureHoldUntil = 0;
let lastDrawTimestamp = 0;
let depthFilter = null;
let depthFilterTime = 0;
let depthBaselineSpan = null;
let depthBaselineZ = null;
let depthCalibrationSamples = [];
let lastDepthMeasurement = null;
let resizeObserver;
let activeWorkspace = "draw";
let catalog = [];
let localCatalog = [];
let catalogFiltered = [];
let modelCatalogLoaded = false;
let modelScene = null;
let modelCamera = null;
let modelRenderer = null;
let modelOrbit = null;
let modelTransform = null;
let modelRaycaster = null;
let modelSelectionHelper = null;
let screenAxisHelper = null;
let screenAxisVisible = true;
let modelHoverPart = null;
let modelHoverSince = 0;
let modelSelectionCommitted = false;
let modelRoot = null;
let modelAnimationId = null;
let selectedModelObject = null;
let modelParts = [];
let transformMode = "translate";
let modelHandControl = false;
let lastModelHandTip = null;
let modelHandGesture = null;
let modelHandPose = "idle";
let modelPoseLostAt = 0;
let modelGestureStart = null;
let modelGestureCandidate = null;
let modelGestureCandidateSince = 0;
let modelGestureCandidateFrames = 0;
let modelTargetScope = "part";
let modelSensitivity = 0.65;
let modelSmoothing = 0.65;
let modelDeltaX = 0;
let modelDeltaY = 0;
let modelGestureTimestamp = 0;
let modelMoveAnchor = null;
let modelMoveTransition = null;
let modelScaleJustReleased = false;
let modelTwoHandMode = false;
let modelTwoHandActive = false;
let modelTwoHandCandidateSince = 0;
let modelTwoHandCandidateFrames = 0;
let modelTwoHandLastCenter = null;
let modelTwoHandLastDistance = null;
let modelTwoHandLastAngle = null;
let hyper3dTask = null;
let hyper3dPolling = false;
const MODEL_MODULES = [
  { id: "pancreas", label: "胰腺 · 入门部件（1）", description: "加载胰腺单个结构，最适合先练习选择、移动、旋转、缩放和拆分。", parts: ["FJ1895"] },
  { id: "kidneys", label: "双肾 · 左右对照（2）", description: "左右肾各一个独立部件，适合练习成对结构对照与逐件操作。", parts: ["FJ3145", "FJ3147"] },
  { id: "digestive", label: "消化系统精选 · 组合观察（6）", description: "胃、胰腺、胆囊与升/横/降结肠的目录部件组合；各部件可分别选中、隐藏和变换。", parts: ["FJ2564", "FJ1895", "FJ2817", "FJ2566", "FJ2567", "FJ2572"] },
  { id: "aorta", label: "主动脉 · 主干（5）", description: "主动脉弓、升主动脉与胸腹段目录部件，适合观察血管主干走向。", parts: ["FJ3411", "FJ3413", "FJ1931", "FJ1932", "FJ3427"] },
  { id: "femurs", label: "股骨 · 左右对照（2）", description: "左右股骨两个独立部件，适合熟悉配对结构和拆分观察。", parts: ["FJ3259", "FJ3365"] }
];
const objLoader = new OBJLoader();
const gltfLoader = new GLTFLoader();

class OneEuroFilter {
  constructor(minCutoff = 1.1, beta = 0.15, derivativeCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.derivativeCutoff = derivativeCutoff;
    this.value = null; this.raw = null; this.derivative = 0;
  }
  alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / Math.max(dt, 1 / 120)); }
  filter(raw, dt) {
    if (this.value === null) { this.value = raw; this.raw = raw; return raw; }
    const rawDerivative = (raw - this.raw) / Math.max(dt, 1 / 120);
    const derivativeAlpha = this.alpha(this.derivativeCutoff, dt);
    this.derivative += derivativeAlpha * (rawDerivative - this.derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.derivative);
    const valueAlpha = this.alpha(cutoff, dt);
    this.value += valueAlpha * (raw - this.value);
    this.raw = raw;
    return this.value;
  }
}

function setStatus(message, kind = "info") {
  $("statusMessage").textContent = message;
  $("statusBar").dataset.kind = kind;
  if (kind === "error") console.error(`[Air Drawing] ${message}`);
}

function formatModelLabel(part) {
  return `${part.name || part.file} · ${part.id || part.file.replace(/\.obj$/i, "")}`;
}

async function loadModelCatalog() {
  if (modelCatalogLoaded) return;
  const count = $("catalogCount");
  try {
    const response = await fetch(MODEL_CATALOG_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`模型目录 HTTP ${response.status}`);
    catalog = await response.json();
    modelCatalogLoaded = true;
    if (count) count.textContent = `${catalog.length} 个内置部件`;
    $("loadCatalogBtn").disabled = false;
    renderModelModules();
    renderCatalogResults();
  } catch (error) {
    console.error("[Air Drawing] Model catalog failed:", error);
    if (count) count.textContent = "目录不可用";
    const moduleSelect = $("modelModuleSelect");
    if (moduleSelect) { moduleSelect.replaceChildren(new Option("模块不可用，请导入模型目录", "")); moduleSelect.disabled = true; }
    $("addModelModuleBtn").disabled = true; $("replaceModelModuleBtn").disabled = true;
    setStatus("内置模型目录加载失败；仍可使用“导入 OBJ 文件”选择本地模型。", "error");
  }
}

function modulePartsFor(module) {
  return module.parts.map((id) => catalog.find((part) => part.id === id)).filter(Boolean);
}

function renderModelModules() {
  const select = $("modelModuleSelect");
  if (!select) return;
  const preferredModule = select.value || "pancreas";
  select.replaceChildren(new Option("选择推荐模块…", ""));
  MODEL_MODULES.forEach((module) => {
    const available = modulePartsFor(module);
    const option = new Option(`${module.label}${available.length !== module.parts.length ? " · 部分缺失" : ""}`, module.id);
    option.disabled = !available.length;
    select.append(option);
  });
  select.value = preferredModule;
  select.disabled = false;
  updateModelModuleSelection();
}

function updateModelModuleSelection() {
  const module = MODEL_MODULES.find((item) => item.id === $("modelModuleSelect")?.value);
  const description = $("modelModuleDescription");
  const parts = module ? modulePartsFor(module) : [];
  if (description) description.textContent = module ? `${module.description} 当前可用 ${parts.length}/${module.parts.length} 个部件。` : "模块使用模型库中真实存在的独立 OBJ 部件。建议先从胰腺入门，再尝试双肾或组合模块。";
  $("addModelModuleBtn").disabled = !parts.length;
  $("replaceModelModuleBtn").disabled = !parts.length;
}

function allCatalogParts() { return [...catalog, ...localCatalog]; }

function renderCatalogResults() {
  const select = $("catalogResults");
  if (!select) return;
  const query = ($("catalogSearch")?.value || "").trim().toLowerCase();
  const allParts = allCatalogParts();
  catalogFiltered = (query ? allParts.filter((part) => `${part.id} ${part.name} ${part.file}`.toLowerCase().includes(query)) : allParts).slice(0, 300);
  select.replaceChildren();
  catalogFiltered.forEach((part) => {
    const option = document.createElement("option");
    option.value = part.key || part.file;
    option.textContent = formatModelLabel(part);
    option.title = part.bounds ? `范围 ${part.bounds}` : part.file;
    select.append(option);
  });
}

function selectedCatalogParts() {
  const selected = new Set([...($("catalogResults")?.selectedOptions || [])].map((option) => option.value));
  return allCatalogParts().filter((part) => selected.has(part.key || part.file));
}

function createModelViewer() {
  const host = $("modelViewer");
  if (!host || modelRenderer) return;
  modelScene = new THREE.Scene();
  modelScene.background = new THREE.Color(0x050b14);
  modelScene.add(new THREE.HemisphereLight(0xc5f7ff, 0x101827, 2.2));
  const key = new THREE.DirectionalLight(0x9be9ff, 3.5); key.position.set(3, 4, 6); modelScene.add(key);
  const fill = new THREE.DirectionalLight(0xff9fca, 1.2); fill.position.set(-4, 2, -3); modelScene.add(fill);
  // BodyParts3D uses Y as its front-to-back axis. Rotate the imported root so
  // local Y becomes the world Z screen normal; the default camera can face the
  // model straight on while X/Z remain the visible screen-plane axes.
  modelRoot = new THREE.Group(); modelRoot.name = "AirDrawingModelRoot"; modelRoot.rotation.x = -Math.PI / 2; modelScene.add(modelRoot);
  modelCamera = new THREE.PerspectiveCamera(35, 1, .01, 100000); modelCamera.position.set(0, 0, 300);
  modelRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  modelRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); modelRenderer.outputColorSpace = THREE.SRGBColorSpace;
  modelRenderer.domElement.className = "model-renderer"; host.prepend(modelRenderer.domElement);
  modelRaycaster = new THREE.Raycaster();
  modelOrbit = new OrbitControls(modelCamera, modelRenderer.domElement); modelOrbit.enableDamping = true; modelOrbit.dampingFactor = .08; modelOrbit.screenSpacePanning = true;
  modelOrbit.addEventListener("start", () => { if (modelTransform) modelTransform.enabled = false; });
  modelOrbit.addEventListener("end", () => updateTransformAttachment());
  modelTransform = new TransformControls(modelCamera, modelRenderer.domElement); modelTransform.setMode(transformMode); modelTransform.setSpace("local"); modelTransform.addEventListener("mouseDown", () => { modelOrbit.enabled = false; }); modelTransform.addEventListener("mouseUp", () => { modelOrbit.enabled = true; }); modelTransform.addEventListener("objectChange", updateSelectedPartLabel); modelScene.add(modelTransform);
  screenAxisHelper = new THREE.Group(); screenAxisHelper.name = "ScreenSpaceAxisHelper";
  screenAxisHelper.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff6b91, .18, .10));
  screenAxisHelper.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x54e6c0, .18, .10));
  screenAxisHelper.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0x6ea8fe, .18, .10));
  const screenNormalMark = new THREE.Group();
  screenNormalMark.add(new THREE.Mesh(new THREE.RingGeometry(.12, .19, 32), new THREE.MeshBasicMaterial({ color: 0x6ea8fe, side: THREE.DoubleSide, depthTest: false })));
  screenNormalMark.add(new THREE.Mesh(new THREE.SphereGeometry(.055, 12, 8), new THREE.MeshBasicMaterial({ color: 0x6ea8fe, depthTest: false })));
  screenAxisHelper.add(screenNormalMark);
  modelScene.add(screenAxisHelper);
  resizeModelViewer();
  startModelRenderLoop();
  modelRenderer.domElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || modelHandControl) return;
    const rect = modelRenderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const target = raycastModelPart(pointer);
    if (target) selectModelObject(target);
  });
}

function startModelRenderLoop() {
  if (modelAnimationId !== null || !modelRenderer) return;
  const render = () => { if (activeWorkspace !== "model") { modelAnimationId = null; return; } modelOrbit?.update(); if (modelSelectionHelper?.visible) modelSelectionHelper.update(); updateScreenAxisHelper(); modelRenderer.render(modelScene, modelCamera); modelAnimationId = requestAnimationFrame(render); };
  modelAnimationId = requestAnimationFrame(render);
}

function updateScreenAxisHelper() {
  if (!screenAxisHelper || !modelCamera) return;
  const target = getModelGestureTarget() || selectedModelObject;
  if (!screenAxisVisible || !target) { screenAxisHelper.visible = false; return; }
  // Object3D.position is the imported object's local origin, which is not
  // guaranteed to be the visual center of an OBJ/GLB part.  Put the reference
  // axes at the world-space bounding-box center instead, so they stay attached
  // to the model's visible center after rotation, translation, or scaling.
  const bounds = new THREE.Box3().setFromObject(target);
  if (bounds.isEmpty()) { screenAxisHelper.visible = false; return; }
  bounds.getCenter(screenAxisHelper.position);
  const direction = new THREE.Vector3(); modelCamera.getWorldDirection(direction);
  const up = modelCamera.up.clone().projectOnPlane(direction).normalize();
  const right = direction.clone().cross(up).normalize();
  const size = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  const length = Math.max(.4, Math.min(size * .34, 30));
  [right, up, direction.clone().negate()].forEach((axis, index) => {
    const arrow = screenAxisHelper.children[index];
    arrow.position.set(0, 0, 0); arrow.setDirection(axis); arrow.setLength(length, length * .22, length * .13);
  });
  const normalMark = screenAxisHelper.children[3];
  normalMark.position.copy(direction).negate().multiplyScalar(length * .35);
  normalMark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().negate());
  normalMark.scale.setScalar(length);
  screenAxisHelper.visible = true;
}

function rotateTargetAroundWorldAxis(target, worldAxis, angle) {
  if (!target?.parent || !Number.isFinite(angle) || Math.abs(angle) < 1e-7) return;
  target.parent.updateWorldMatrix(true, false);
  const parentLocalAxis = worldAxis.clone().transformDirection(target.parent.matrixWorld.clone().invert()).normalize();
  target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(parentLocalAxis, angle));
}

function projectModelCenter(target) {
  if (!target || !modelCamera) return null;
  const bounds = new THREE.Box3().setFromObject(target);
  if (bounds.isEmpty()) return null;
  const center = bounds.getCenter(new THREE.Vector3());
  const ndc = center.clone().project(modelCamera);
  // Keep the projected half-size so hand translation and later transforms can
  // keep the complete object inside the visible viewport, rather than only
  // keeping its origin/center on screen.
  const corners = [
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  ];
  const projectedCorners = corners.map((corner) => corner.project(modelCamera));
  const minX = Math.min(...projectedCorners.map((corner) => corner.x));
  const maxX = Math.max(...projectedCorners.map((corner) => corner.x));
  const minY = Math.min(...projectedCorners.map((corner) => corner.y));
  const maxY = Math.max(...projectedCorners.map((corner) => corner.y));
  return { world: center, ndc, halfX: (maxX - minX) * .5, halfY: (maxY - minY) * .5 };
}

function placeModelCenterAtNdc(target, desiredNdc, projected = projectModelCenter(target)) {
  if (!projected || !target?.parent || !modelCamera) return false;
  const safeMargin = .06;
  const maxCenterX = 1 - safeMargin - Math.max(0, projected.halfX || 0);
  const maxCenterY = 1 - safeMargin - Math.max(0, projected.halfY || 0);
  const clampedNdc = desiredNdc.clone();
  clampedNdc.x = maxCenterX > 0 ? Math.max(-maxCenterX, Math.min(maxCenterX, clampedNdc.x)) : 0;
  clampedNdc.y = maxCenterY > 0 ? Math.max(-maxCenterY, Math.min(maxCenterY, clampedNdc.y)) : 0;
  const desiredWorld = clampedNdc.setZ(projected.ndc.z).unproject(modelCamera);
  const worldDelta = desiredWorld.sub(projected.world);
  const parentInverse = target.parent.matrixWorld.clone().invert();
  const localCenter = projected.world.clone().applyMatrix4(parentInverse);
  const localDesired = projected.world.clone().add(worldDelta).applyMatrix4(parentInverse);
  target.position.add(localDesired.sub(localCenter));
  return true;
}

function constrainModelTargetToViewport(target) {
  let projected = projectModelCenter(target);
  if (!projected) return false;
  const maxHalf = .94;
  if (projected.halfX > maxHalf || projected.halfY > maxHalf) {
    const fitRatio = Math.min(maxHalf / Math.max(projected.halfX, .001), maxHalf / Math.max(projected.halfY, .001));
    if (fitRatio < 1 && fitRatio > .02) {
      target.scale.multiplyScalar(fitRatio);
      projected = projectModelCenter(target);
      if (!projected) return false;
    }
  }
  return placeModelCenterAtNdc(target, projected.ndc, projected);
}

function moveModelCenterWithFinger(target, tip, anchor = { x: 0, y: 0 }, timestamp = performance.now()) {
  if (!target?.parent || !modelCamera || !modelRenderer) return false;
  const projected = projectModelCenter(target);
  if (!projected) return false;
  const desiredNdc = new THREE.Vector3(tip.x * 2 - 1 + anchor.x, 1 - tip.y * 2 + anchor.y, projected.ndc.z);
  const screenDistance = Math.hypot(desiredNdc.x - projected.ndc.x, desiredNdc.y - projected.ndc.y);
  const MODEL_MOVE_DIRECT_LIMIT = .16; // high direct-follow threshold
  const MODEL_MOVE_MAX_MS = 460; // response remains within 0.5 seconds
  const MODEL_MOVE_MIN_MS = 120;

  if (modelMoveTransition && modelMoveTransition.target !== target) modelMoveTransition = null;
  if (!modelMoveTransition && screenDistance > MODEL_MOVE_DIRECT_LIMIT) {
    const start = projected.ndc.clone();
    const end = desiredNdc.clone();
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const perpendicular = new THREE.Vector2(-(end.y - start.y), end.x - start.x);
    if (perpendicular.lengthSq() > 1e-8) perpendicular.normalize();
    const arcHeight = Math.min(.16, Math.max(.035, distance * .18));
    const control = new THREE.Vector3((start.x + end.x) * .5 + perpendicular.x * arcHeight, (start.y + end.y) * .5 + perpendicular.y * arcHeight, start.z);
    modelMoveTransition = { target, start, end, control, startedAt: timestamp, duration: Math.min(MODEL_MOVE_MAX_MS, Math.max(MODEL_MOVE_MIN_MS, 180 + distance * 260)) };
  } else if (modelMoveTransition) {
    // Do not reject a fast hand movement: keep the current arc's start and
    // continuously move its endpoint toward the newest fingertip position.
    modelMoveTransition.end.copy(desiredNdc);
    const start = modelMoveTransition.start;
    const end = modelMoveTransition.end;
    const perpendicular = new THREE.Vector2(-(end.y - start.y), end.x - start.x);
    if (perpendicular.lengthSq() > 1e-8) perpendicular.normalize();
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const arcHeight = Math.min(.16, Math.max(.035, distance * .18));
    modelMoveTransition.control.set((start.x + end.x) * .5 + perpendicular.x * arcHeight, (start.y + end.y) * .5 + perpendicular.y * arcHeight, start.z);
  }

  if (modelMoveTransition) {
    const transition = modelMoveTransition;
    const progress = Math.min(1, Math.max(0, (timestamp - transition.startedAt) / transition.duration));
    const eased = 1 - Math.pow(1 - progress, 3);
    const oneMinus = 1 - eased;
    const point = new THREE.Vector3(
      oneMinus * oneMinus * transition.start.x + 2 * oneMinus * eased * transition.control.x + eased * eased * transition.end.x,
      oneMinus * oneMinus * transition.start.y + 2 * oneMinus * eased * transition.control.y + eased * eased * transition.end.y,
      transition.start.z
    );
    placeModelCenterAtNdc(target, point, projectModelCenter(target));
    if (progress >= 1) modelMoveTransition = null;
    return true;
  }
  return placeModelCenterAtNdc(target, desiredNdc, projected);
}

function stopModelRenderLoop() { if (modelAnimationId !== null) cancelAnimationFrame(modelAnimationId); modelAnimationId = null; }

function resizeModelViewer() {
  if (!modelRenderer || !modelCamera) return;
  const rect = $("modelViewer")?.getBoundingClientRect(); if (!rect?.width || !rect.height) return;
  modelCamera.aspect = rect.width / rect.height; modelCamera.updateProjectionMatrix(); modelRenderer.setSize(rect.width, rect.height, false);
}

function modelMaterial() { return new THREE.MeshStandardMaterial({ color: 0x72d9c1, roughness: .62, metalness: .08, side: THREE.DoubleSide }); }

function centerAndNormalize(object) {
  // BodyParts3D exports all parts in one shared millimetre coordinate system.
  // Keep each mesh's source coordinates so organs remain aligned as a set.
  object.userData.originalPosition = object.position.clone();
  return object;
}

function fitModelScene() {
  if (!modelRoot || !modelParts.length) return;
  modelRoot.updateMatrixWorld(true);
  frameModelObjects(modelParts.map((part) => part.object));
}

function resetModelAssemblyTransform() {
  if (!modelRoot) return;
  modelRoot.position.set(0, 0, 0); modelRoot.rotation.set(-Math.PI / 2, 0, 0); modelRoot.scale.setScalar(1); modelRoot.updateMatrixWorld(true);
}

function registerLoadedModelObject(object, part, fileName, { preserveMaterials = false } = {}) {
  object.traverse((child) => { if (child.isMesh) { if (!preserveMaterials) child.material = modelMaterial(); child.castShadow = true; child.userData.partFile = fileName; } });
  const bounds = new THREE.Box3().setFromObject(object); const center = bounds.getCenter(new THREE.Vector3());
  const partObject = new THREE.Group(); partObject.position.copy(center); object.position.sub(center); partObject.add(centerAndNormalize(object));
  partObject.userData.modelPart = true; partObject.userData.part = part || { file: fileName, name: fileName };
  modelRoot.add(partObject); const record = { object: partObject, originalPosition: partObject.position.clone(), originalRotation: partObject.rotation.clone(), originalScale: partObject.scale.clone(), originalVisible: partObject.visible, beforeExplodePosition: null, exploded: false, key: part?.key || fileName, file: fileName, name: part?.name || fileName, id: part?.id || fileName.replace(/\.(obj|glb)$/i, "") }; modelParts.push(record); fitModelScene(); selectModelObject(partObject); frameSelectedModel(); updateScenePartList(); $("modelViewerPlaceholder")?.classList.add("hidden");
  return record;
}

function addModelPart(part, source, fileName = part?.file) {
  return new Promise((resolve, reject) => {
    const finish = (object) => resolve(registerLoadedModelObject(object, part, fileName));
    if (source instanceof File) { const reader = new FileReader(); reader.onload = () => { try { finish(objLoader.parse(String(reader.result))); } catch (error) { reject(error); } }; reader.onerror = () => reject(reader.error || new Error("无法读取 OBJ 文件")); reader.readAsText(source); return; }
    objLoader.load(`${MODEL_ROOT}${fileName.split("/").map(encodeURIComponent).join("/")}`, finish, undefined, reject);
  });
}

function addGeneratedGLB(arrayBuffer, fileName = "Hyper3D-model.glb") {
  return new Promise((resolve, reject) => {
    gltfLoader.parse(arrayBuffer, "", (gltf) => {
      const object = gltf.scene || gltf.scenes?.[0];
      if (!object) { reject(new Error("GLB 中没有可显示的场景")); return; }
      resolve(registerLoadedModelObject(object, { key: `hyper3d:${fileName}:${crypto.randomUUID()}`, file: fileName, name: `Hyper3D · ${fileName}`, id: fileName.replace(/\.glb$/i, "") }, fileName, { preserveMaterials: true }));
    }, reject);
  });
}

function disposeModelPart(part) {
  part.object.traverse((child) => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  });
  modelRoot?.remove(part.object);
}

function updateScenePartList() {
  const host = $("scenePartList"); if (!host) return; host.replaceChildren();
  if (!modelParts.length) { host.innerHTML = '<div class="scene-empty">添加一个或多个部件后，可在此选择、隐藏或拆分观察。</div>'; }
  modelParts.forEach((part) => {
    const row = document.createElement("div"); row.className = `scene-part-row${part.object === selectedModelObject ? " selected" : ""}`;
    const select = document.createElement("button"); select.className = "scene-part-name"; select.type = "button"; select.textContent = part.name; select.title = `${part.id} · 点击选中`;
    select.addEventListener("click", () => selectModelObject(part.object));
    const visibility = document.createElement("button"); visibility.className = "scene-visibility"; visibility.type = "button"; visibility.textContent = part.object.visible ? "显" : "隐"; visibility.title = "显示/隐藏部件"; visibility.addEventListener("click", () => { part.object.visible = !part.object.visible; visibility.textContent = part.object.visible ? "显" : "隐"; });
    row.append(select, visibility); host.append(row);
  });
  $("scenePartCount").textContent = `${modelParts.length} 个`; $("removeAllPartsBtn").disabled = !modelParts.length; $("framePartBtn").disabled = !selectedModelObject;
  const selectedRecord = modelParts.find((item) => item.object === selectedModelObject);
  $("explodePartBtn").disabled = !selectedRecord;
  $("explodePartBtn").textContent = selectedRecord?.exploded ? "合并部件" : "拆分观察";
  $("explodePartBtn").title = selectedRecord?.exploded ? "将选中部件放回拆分前的位置" : "单次拆分动作，不会由捏合松开触发";
  $("resetModelTargetBtn").disabled = modelTargetScope === "whole" ? !modelParts.length : !selectedRecord;
  $("resetAllModelBtn").disabled = !modelParts.length;
  updateSavedPoseButtons();
}

function selectModelObject(object) {
  selectedModelObject = object; updateTransformAttachment();
  showModelSelectionHelper(object);
  updateSelectedPartLabel(); updateScenePartList(); updateModelGestureUI();
}

function showModelSelectionHelper(object) {
  if (!object) { if (modelSelectionHelper) modelSelectionHelper.visible = false; return; }
  if (!modelSelectionHelper) {
    modelSelectionHelper = new THREE.BoxHelper(object, 0x54e6c0);
    modelSelectionHelper.material.depthTest = false;
    modelSelectionHelper.material.transparent = true;
    modelSelectionHelper.material.opacity = .9;
    modelScene.add(modelSelectionHelper);
  } else modelSelectionHelper.setFromObject(object);
  modelSelectionHelper.visible = true;
}

function raycastModelPart(pointer) {
  if (!modelRaycaster || !modelCamera) return null;
  modelRaycaster.setFromCamera(pointer, modelCamera);
  const visibleParts = modelParts.filter((part) => part.object.visible).map((part) => part.object);
  const hits = modelRaycaster.intersectObjects(visibleParts, true);
  for (const hit of hits) {
    let target = hit.object;
    while (target && !target.userData.modelPart) target = target.parent;
    if (target) return target;
  }
  return null;
}

function setModelTargetScope(scope) {
  modelTargetScope = scope;
  document.querySelectorAll("[data-model-target]").forEach((button) => {
    const active = button.dataset.modelTarget === scope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateTransformAttachment();
  updateModelGestureUI();
}

function getModelGestureTarget() {
  return modelTargetScope === "whole" ? (modelParts.length ? modelRoot : null) : selectedModelObject;
}

function updateTransformAttachment() {
  if (!modelTransform) return;
  const target = getModelGestureTarget();
  if (target) modelTransform.attach(target); else modelTransform.detach();
  modelTransform.enabled = !modelHandControl && Boolean(target);
  // TransformControls is a mouse-only gizmo.  Leaving it visible while hand
  // control is active makes its handles look like a second object and can be
  // mistaken for the thing being moved.  The hand cursor and screen-axis
  // reference remain available in hand mode.
  modelTransform.visible = !modelHandControl && Boolean(target);
  modelTransform.setMode(transformMode);
}

function updateSelectedPartLabel() { const part = modelParts.find((item) => item.object === selectedModelObject); $("selectedPartName").textContent = part ? `${part.name} · ${part.id}` : "尚未加载模型"; }

function frameModelObjects(objects) {
  const visible = objects.filter((object) => object?.visible);
  if (!visible.length || !modelCamera || !modelOrbit) return;
  const box = new THREE.Box3(); visible.forEach((object) => box.expandByObject(object));
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z, 1) / Math.tan(THREE.MathUtils.degToRad(modelCamera.fov / 2)) * 1.45;
  modelOrbit.target.copy(center); modelCamera.position.copy(center).add(new THREE.Vector3(0, 0, distance)); modelCamera.up.set(0, 1, 0); modelOrbit.update();
}

function frameSelectedModel() {
  if (!selectedModelObject) return;
  frameModelObjects([selectedModelObject]);
}

function explodeSelectedModel() {
  if (!selectedModelObject) return;
  const part = modelParts.find((item) => item.object === selectedModelObject); if (!part) return;
  if (part.exploded) {
    part.object.position.copy(part.beforeExplodePosition || part.originalPosition);
    part.beforeExplodePosition = null; part.exploded = false;
    setStatus(`已将 ${part.name} 合并回拆分前的位置。`, "info");
  } else {
    part.beforeExplodePosition = part.object.position.clone();
    const direction = part.object.position.clone().normalize(); if (direction.lengthSq() < .01) direction.set(1, .3, .2);
    part.object.position.add(direction.normalize().multiplyScalar(28)); part.exploded = true;
    setStatus(`已将 ${part.name} 移出中心，便于观察；再次点击“合并部件”可放回原位。`, "info");
  }
  updateScenePartList();
}

async function loadCatalogParts(parts, { replace = false, label = "选中部件" } = {}) {
  if (!parts.length) { setStatus("没有找到可加载的模型部件。", "info"); return; }
  createModelViewer();
  $("loadCatalogBtn").disabled = true; $("addModelModuleBtn").disabled = true; $("replaceModelModuleBtn").disabled = true;
  if (replace && modelParts.length) {
    modelParts.forEach(disposeModelPart); modelParts = []; selectedModelObject = null; resetModelAssemblyTransform(); modelTransform?.detach();
  }
  setStatus(`正在加载${label} ${parts.length} 个 OBJ 部件…`, "info");
  try {
    let loaded = 0;
    for (const part of parts) {
      if (!modelParts.some((item) => item.key === (part.key || part.file))) { await addModelPart(part, part.localFile || null, part.file); loaded++; }
    }
    if (!modelParts.length) $("modelViewerPlaceholder")?.classList.remove("hidden");
    const loadedKeys = new Set(parts.map((part) => part.key || part.file));
    const moduleObjects = modelParts.filter((part) => loadedKeys.has(part.key)).map((part) => part.object);
    frameModelObjects(moduleObjects);
    updateScenePartList(); updateSelectedPartLabel();
    setStatus(`${replace ? "已清空旧场景并加载" : "已加入"} ${loaded} 个${label}。启用 3D 手势后可用 V 字选件、单指移动、握拳旋转、捏合缩放。`, "info");
  } catch (error) {
    console.error("[Air Drawing] OBJ load failed:", error);
    setStatus(`OBJ 加载失败：${error.message || "未知错误"}`, "error");
  } finally {
    $("loadCatalogBtn").disabled = false;
    updateModelModuleSelection();
  }
}

async function addSelectedCatalogParts() {
  const parts = selectedCatalogParts();
  if (!parts.length) { setStatus("请在模型库中选择至少一个部件。", "info"); return; }
  await loadCatalogParts(parts, { label: "选中部件" });
}

async function addSelectedModelModule(replace = false) {
  const module = MODEL_MODULES.find((item) => item.id === $("modelModuleSelect")?.value);
  const parts = module ? modulePartsFor(module) : [];
  if (!module || !parts.length) { setStatus("请先选择一个可用的快速模块。", "info"); return; }
  await loadCatalogParts(parts, { replace, label: module.label.split("·")[0].trim() });
}

async function indexLocalFolder(files) {
  const objFiles = [...files].filter((file) => file.name.toLowerCase().endsWith(".obj")); if (!objFiles.length) { setStatus("所选文件夹中没有 OBJ 文件。", "error"); return; }
  setStatus(`正在读取 ${objFiles.length} 个 OBJ 的名称和结构编号…`, "info");
  try {
    localCatalog = await Promise.all(objFiles.map(async (file) => {
      const header = await file.slice(0, 4096).text();
      const get = (pattern, fallback = "") => header.match(pattern)?.[1]?.trim() || fallback;
      const relative = file.webkitRelativePath || file.name;
      return { key: `local:${relative}`, file: relative, name: get(/^#[ \t]*English name[ \t]*:[ \t]*([^\r\n]*)/m, file.name), id: get(/^#[ \t]*File ID[ \t]*:[ \t]*([^\r\n]*)/m, file.name.replace(/\.obj$/i, "")), representation: get(/^#[ \t]*Representation ID[ \t]*:[ \t]*([^\r\n]*)/m), bounds: get(/^#[ \t]*Bounds\(mm\)[ \t]*:[ \t]*([^\r\n]*)/m), localFile: file };
    }));
    $("loadCatalogBtn").disabled = false;
    $("catalogCount").textContent = `${catalog.length} 内置 + ${localCatalog.length} 本地`;
    $("modelSourceNote").textContent = `本地文件夹已索引 ${localCatalog.length} 个 OBJ；搜索并选中部件，再点击“添加选中部件”按需载入。`;
    renderCatalogResults();
    setStatus(`本地目录已索引 ${localCatalog.length} 个部件。搜索后选择需要的部件，再逐个加入场景。`, "info");
  } catch (error) { console.error("[Air Drawing] Local OBJ folder indexing failed:", error); setStatus(`本地文件夹索引失败：${error.message || "未知错误"}`, "error"); }
}

async function addLocalFiles(files) {
  const selectedFiles = [...files].filter((file) => /\.(obj|glb)$/i.test(file.name));
  if (!selectedFiles.length) { setStatus("请选择 OBJ 或 GLB 文件。", "error"); return; }
  if (selectedFiles.length > 30) { await indexLocalFolder(selectedFiles.filter((file) => file.name.toLowerCase().endsWith(".obj"))); return; }
  createModelViewer(); setStatus(`正在解析 ${selectedFiles.length} 个本地 3D 文件…`, "info");
  try {
    for (const file of selectedFiles) {
      if (/\.glb$/i.test(file.name)) await addGeneratedGLB(await file.arrayBuffer(), file.name);
      else await addModelPart({ file: file.name, id: file.name.replace(/\.obj$/i, ""), name: file.name }, file, file.name);
    }
    setStatus(`已导入 ${selectedFiles.length} 个本地 OBJ / GLB 文件。`, "info");
  } catch (error) { console.error("[Air Drawing] Local model import failed:", error); setStatus(`本地模型导入失败：${error.message || "未知错误"}`, "error"); }
}

function setHyper3DTaskState(message, kind = "info") {
  const state = $("hyper3dTaskState"); if (!state) return;
  state.textContent = message; state.dataset.kind = kind;
}

async function refreshHyper3DConfig() {
  const state = $("hyper3dConnectionState"); const button = $("hyper3dGenerateBtn");
  if (!state || !button) return;
  try {
    const response = await fetch(`${HYPER3D_API_BASE}/api/hyper3d/config`, { cache: "no-store" });
    if (!response.ok) throw new Error("local api unavailable");
    const config = await response.json();
    state.textContent = config.available ? "本地代理已连接" : "需要配置 API Key";
    state.style.color = config.available ? "var(--mint)" : "var(--muted)";
    button.disabled = !config.available;
    setHyper3DTaskState(config.available ? "已连接 Hyper3D Rodin Gen‑2.5，可提交文字或参考图。" : "请在项目根目录 .env 设置 RODIN_API_KEY，然后重启 node server.mjs。", config.available ? "active" : "info");
  } catch (error) {
    state.textContent = "未检测到本地代理"; state.style.color = "var(--muted)"; button.disabled = true;
    setHyper3DTaskState("当前页面由静态服务器提供；使用 Hyper3D 需要改用 node server.mjs 启动。", "info");
  }
}

function updateHyper3DInputMode() {
  const imageMode = $("hyper3dInputMode")?.value === "image";
  $("hyper3dUploadRow")?.toggleAttribute("hidden", !imageMode);
  $("hyper3dPrompt")?.setAttribute("placeholder", imageMode ? "可选：补充方向、结构或材质提示" : "例如：真实比例的胰腺解剖模型，表面平滑，单一独立结构");
}

function updateHyper3DImageNames() {
  const files = [...($("hyper3dImages")?.files || [])];
  const label = $("hyper3dImageNames");
  if (label) label.textContent = files.length ? `${files.length} 张已选择${files.length > 5 ? "（最多使用前 5 张）" : ""}` : "PNG / JPG / WEBP，最多 5 张";
}

async function pollHyper3DTask() {
  if (!hyper3dTask?.subscriptionKey || hyper3dPolling) return;
  hyper3dPolling = true;
  let waitMs = 5000; const deadline = Date.now() + 30 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const response = await fetch(`${HYPER3D_API_BASE}/api/hyper3d/task-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription_key: hyper3dTask.subscriptionKey }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.message || payload.error || `状态查询失败（HTTP ${response.status}）`);
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      const done = jobs.length > 0 && jobs.every((job) => job.status === "Done");
      const failed = jobs.find((job) => job.status === "Failed");
      const generating = jobs.find((job) => job.status === "Generating");
      const waiting = jobs.find((job) => job.status === "Waiting");
      if (failed) throw new Error("Hyper3D 生成任务失败，请检查输入图或提示词。");
      if (done) {
        setHyper3DTaskState("模型已生成，正在获取可下载文件…", "active");
        const downloadResponse = await fetch(`${HYPER3D_API_BASE}/api/hyper3d/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_uuid: hyper3dTask.taskUuid }) });
        const downloadPayload = await downloadResponse.json().catch(() => ({}));
        if (!downloadResponse.ok || downloadPayload.error) throw new Error(downloadPayload.message || downloadPayload.error || "模型下载地址获取失败。");
        const list = Array.isArray(downloadPayload.list) ? downloadPayload.list : [];
        renderHyper3DResults(list);
        setHyper3DTaskState(`生成完成，共 ${list.length} 个输出文件。点击下方文件导入场景。`, "active");
        return;
      }
      setHyper3DTaskState(waiting ? `任务排队中${waiting.queue_length == null ? "" : ` · 前方约 ${waiting.queue_length} 个任务`}…` : generating ? "Hyper3D 正在生成几何与材质…" : "正在查询任务状态…", "active");
      waitMs = Math.min(30000, Math.round(waitMs * 1.35));
    }
    throw new Error("生成等待超过 30 分钟，任务仍未完成。");
  } catch (error) {
    console.error("[Air Drawing] Hyper3D task failed:", error);
    setHyper3DTaskState(error.message || "Hyper3D 任务失败。", "error");
  } finally {
    hyper3dPolling = false;
    $("hyper3dGenerateBtn").disabled = false;
  }
}

function renderHyper3DResults(list) {
  const host = $("hyper3dResults"); if (!host) return; host.replaceChildren();
  const glbItems = list.filter((item) => item?.url && item?.name && /\.glb$/i.test(item.name));
  glbItems.forEach((item) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "hyper3d-result-button"; button.textContent = `＋ 导入 ${item.name}`;
    button.addEventListener("click", () => importHyper3DResult(item, button)); host.append(button);
  });
  if (!glbItems.length) {
    const note = document.createElement("div"); note.className = "model-note"; note.textContent = "任务完成，但没有找到可直接导入的 GLB 输出。请在 Hyper3D Dashboard 下载其他格式后转换。"; host.append(note);
  }
}

async function importHyper3DResult(item, button) {
  if (!item?.url) return;
  button.disabled = true; button.textContent = `正在下载 ${item.name}…`;
  try {
    const proxyUrl = `${HYPER3D_API_BASE}/api/hyper3d/file?url=${encodeURIComponent(item.url)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || `模型下载失败（HTTP ${response.status}）`); }
    const record = await addGeneratedGLB(await response.arrayBuffer(), item.name);
    setStatus(`已将 Hyper3D 模型 ${record.name} 导入场景。启用手势后可用 V 字选件或竖拇指切换整体。`, "info");
    button.textContent = `✓ 已导入 ${item.name}`;
  } catch (error) {
    console.error("[Air Drawing] Hyper3D import failed:", error); button.disabled = false; button.textContent = `重试导入 ${item.name}`; setHyper3DTaskState(error.message || "模型导入失败。", "error");
  }
}

async function generateHyper3D() {
  const mode = $("hyper3dInputMode")?.value || "text";
  const prompt = $("hyper3dPrompt")?.value.trim() || "";
  const files = [...($("hyper3dImages")?.files || [])].slice(0, 5);
  if (mode === "text" && !prompt) { setHyper3DTaskState("文字生成需要填写模型描述。", "error"); return; }
  if (mode === "image" && !files.length) { setHyper3DTaskState("图片生成至少需要选择一张参考图。", "error"); return; }
  const form = new FormData();
  if (prompt) form.append("prompt", prompt);
  files.forEach((file) => form.append("images", file, file.name));
  form.append("tier", "Gen-2.5-Medium"); form.append("mesh_mode", "Raw"); form.append("quality_override", "20000"); form.append("geometry_file_format", "glb"); form.append("material", "PBR");
  $("hyper3dGenerateBtn").disabled = true; $("hyper3dResults")?.replaceChildren(); setHyper3DTaskState("正在提交 Hyper3D 生成任务…", "active");
  try {
    const response = await fetch(`${HYPER3D_API_BASE}/api/hyper3d/generate`, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error || !payload.uuid || !payload.jobs?.subscription_key) throw new Error(payload.message || payload.error || "Hyper3D 没有接受该任务。");
    hyper3dTask = { taskUuid: payload.uuid, subscriptionKey: payload.jobs.subscription_key };
    setHyper3DTaskState("任务已提交；首次状态查询将在 5 秒后开始。", "active");
    pollHyper3DTask();
  } catch (error) {
    console.error("[Air Drawing] Hyper3D generation failed:", error); setHyper3DTaskState(error.message || "Hyper3D 提交失败。", "error"); $("hyper3dGenerateBtn").disabled = false;
  }
}

function setActiveWorkspace(workspace) {
  activeWorkspace = workspace; const model = workspace === "model"; document.body.classList.toggle("model-workspace-active", model); $("drawingPane").hidden = model; $("modelWorkspacePane").hidden = !model; $("drawWorkspaceBtn").classList.toggle("active", !model); $("modelWorkspaceBtn").classList.toggle("active", model); $("drawWorkspaceBtn").setAttribute("aria-selected", String(!model)); $("modelWorkspaceBtn").setAttribute("aria-selected", String(model)); updateSingleScreenOverlay(); lastModelHandTip = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0; updateModelGestureUI(); if (model) { createModelViewer(); loadModelCatalog(); requestAnimationFrame(() => { resizeModelViewer(); startModelRenderLoop(); }); } else { stopModelRenderLoop(); finishStroke(); } setStatus(model ? "3D 解剖工作台已启用。开启手势后可用姿势选择、移动、旋转和缩放模型。" : "隔空绘画工作台已启用。", "info"); }

function modelPoseLabel(pose = modelHandPose) {
  return ({ idle: "中立 / 停止", select: "V 字选部件", move: "单指移动", rotate: "握拳旋转", scale: "捏合缩放", whole: "整体模型", twoHand: "双手操控" })[pose] || "中立 / 停止";
}

function updateModelGestureUI() {
  const state = $("modelGestureState"); const strip = state?.closest(".model-gesture-strip");
  if (!state) return;
  const targetName = modelTargetScope === "whole" ? "整体模型" : "选中部件";
  state.textContent = !modelHandControl ? "鼠标 / 变换手柄" : (modelTwoHandActive ? "双手" : (primaryHand === "Right" ? "右手" : "左手")) + "主控 · " + targetName + " · " + (modelTwoHandActive ? modelPoseLabel("twoHand") : modelPoseLabel());
  strip?.classList.toggle("active", modelHandControl);
  document.body.classList.toggle("model-hand-control-active", modelHandControl && activeWorkspace === "model");
}

function classifyModelHandPose(landmarks, pinching) {
  const index = fingerExtensionAngle(landmarks, 5, 6, 8) > 138;
  const middle = fingerExtensionAngle(landmarks, 9, 10, 12) > 138;
  const ring = fingerExtensionAngle(landmarks, 13, 14, 16) > 138;
  const pinky = fingerExtensionAngle(landmarks, 17, 18, 20) > 138;
  // Thumb angle changes sharply with camera orientation. Its tip distance from
  // the index MCP is a more stable indication that the thumb points up/out.
  const palmScale = Math.hypot(landmarks[0].x - landmarks[9].x, landmarks[0].y - landmarks[9].y, (landmarks[0].z || 0) - (landmarks[9].z || 0));
  const thumbOpen = Math.hypot(landmarks[4].x - landmarks[5].x, landmarks[4].y - landmarks[5].y, (landmarks[4].z || 0) - (landmarks[5].z || 0)) > palmScale * .72;
  const thumbUp = landmarks[4].y < landmarks[3].y + .06;
  const foldedCount = [index, middle, ring, pinky].filter((extended) => !extended).length;
  const fistClosed = !index && !middle && !ring && !pinky;
  // Selection wins over pinch so a V pose is not stolen by a transient thumb
  // landmark error. A raised thumb is a one-shot target-scope command.
  if (index && middle && !ring && !pinky) return "select";
  // A thumb command must be unambiguous: the thumb is extended while all four
  // fingers are folded.  Using `>= 3` made an index+thumb pose look like a
  // whole-model switch for a few frames while the V gesture was settling.
  if (!pinching && thumbOpen && thumbUp && foldedCount === 4) return "whole";
  // A closed fist is the deliberate rotation clutch.  The thumb and index
  // tips can become close together naturally when the hand closes, so test
  // this before pinch.  Otherwise the pinch hysteresis would steal the fist
  // for a few frames and make the model keep scaling instead of rotating.
  if (fistClosed) return "rotate";
  if (pinching) return "scale";
  if (index && !middle && !ring && !pinky) return "move";
  return "idle";
}

function modelPoseConfirmMs(pose) {
  return ({ idle: 140, scale: 160, move: 170, rotate: 190, select: 220, whole: 220 })[pose] ?? 180;
}

function modelPoseConfirmFrames(pose) {
  return (pose === "select" || pose === "whole") ? 6 : 5;
}

function normalizedPalmPoint(landmarks) {
  const palm = landmarks[9] || landmarks[0];
  return { x: 1 - palm.x, y: palm.y };
}

function pinchRatioForLandmarks(landmarks) {
  const pinch = Math.hypot(landmarks[4].x - landmarks[8].x, landmarks[4].y - landmarks[8].y);
  const span = Math.hypot(landmarks[0].x - landmarks[9].x, landmarks[0].y - landmarks[9].y);
  return pinch / Math.max(.001, span);
}

function resetTwoHandControl() {
  modelTwoHandActive = false;
  modelTwoHandCandidateSince = 0;
  modelTwoHandCandidateFrames = 0;
  modelTwoHandLastCenter = null;
  modelTwoHandLastDistance = null;
  modelTwoHandLastAngle = null;
}

function applyTwoHandModelControl(primaryLandmarks, secondaryLandmarks, timestamp) {
  if (!modelTwoHandMode || !modelHandControl || !primaryLandmarks || !secondaryLandmarks) {
    resetTwoHandControl();
    return false;
  }
  const target = getModelGestureTarget();
  if (!target) {
    resetTwoHandControl();
    $("modelViewerHint").textContent = "双手模式已启用 · 请先用 V 字选中部件或竖起拇指切换整体";
    return true;
  }
  const first = normalizedPalmPoint(primaryLandmarks);
  const second = normalizedPalmPoint(secondaryLandmarks);
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const distance = Math.hypot(first.x - second.x, first.y - second.y);
  const angle = Math.atan2(second.y - first.y, second.x - first.x);
  const bothPinching = pinchRatioForLandmarks(primaryLandmarks) < .34 && pinchRatioForLandmarks(secondaryLandmarks) < .34;
  if (!bothPinching) {
    resetTwoHandControl();
    $("modelViewerHint").textContent = "双手模式 · 两手同时捏合后，中心移动平移、距离缩放、夹角滚转";
    updateModelGestureUI();
    return true;
  }
  if (!modelTwoHandActive) {
    if (!modelTwoHandCandidateSince) modelTwoHandCandidateSince = timestamp;
    modelTwoHandCandidateFrames += 1;
    if (modelTwoHandCandidateFrames < 5 || timestamp - modelTwoHandCandidateSince < 160) {
      $("modelViewerHint").textContent = "双手手势确认中…保持两手捏合片刻";
      return true;
    }
    modelTwoHandActive = true;
    modelTwoHandLastCenter = center;
    modelTwoHandLastDistance = distance;
    modelTwoHandLastAngle = angle;
    modelHandGesture = false;
    updateModelGestureUI();
    return true;
  }
  let angleDelta = angle - modelTwoHandLastAngle;
  while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
  while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
  const dx = center.x - modelTwoHandLastCenter.x;
  const dy = center.y - modelTwoHandLastCenter.y;
  const distanceDelta = distance - modelTwoHandLastDistance;
  modelTwoHandLastCenter = center;
  modelTwoHandLastDistance = distance;
  modelTwoHandLastAngle = angle;
  const gain = modelSensitivity * Math.max(.72, Math.min(1.2, 1 / (lastDepthMeasurement?.factor || 1)));
  const moveX = Math.max(-.08, Math.min(.08, dx));
  const moveY = Math.max(-.08, Math.min(.08, dy));
  if (Math.abs(moveX) > .001 || Math.abs(moveY) > .001) {
    target.position.x += moveX * 150 * gain;
    target.position.y -= moveY * 150 * gain;
  }
  if (Math.abs(distanceDelta) > .0015) {
    target.scale.multiplyScalar(Math.max(.94, Math.min(1.06, Math.exp(distanceDelta * 2.8 * gain))));
  }
  if (Math.abs(angleDelta) > .006) {
    const screenNormal = modelCamera.getWorldDirection(new THREE.Vector3()).negate();
    rotateTargetAroundWorldAxis(target, screenNormal, Math.max(-.08, Math.min(.08, angleDelta * .8 * gain)));
  }
  modelTwoHandActive = true;
  $("modelViewerHint").textContent = "正在双手操控 · 中心平移 · 距离缩放 · 两手夹角滚转 · 松开捏合停止";
  updateModelGestureUI();
  updateSelectedPartLabel();
  return true;
}

function applyModelHandControl(landmarks, timestamp, pose = "idle") {
  if (activeWorkspace !== "model" || !modelRenderer) return;
  // Releasing a pinch often briefly resembles the one-finger move pose. Require
  // a neutral/open pause before accepting another action to prevent accidental
  // drags, but allow a confirmed closed fist to take over immediately so the
  // user can switch from scaling to rotation without the old pinch state
  // swallowing the fist gesture.
  if (modelHandPose === "scale" && pose !== "scale" && pose !== "idle" && pose !== "rotate") pose = "idle";
  // Keep the model cursor more responsive than the drawing cursor: blend a
  // little raw fingertip into the filtered point so fast movement does not lag
  // behind, while the One Euro filter still removes visible jitter.
  const filteredTip = smoothedTip || landmarks && { x: landmarks[8].x, y: landmarks[8].y };
  const rawBlend = .42;
  const modelTipX = filteredTip ? filteredTip.x * (1 - rawBlend) + landmarks[8].x * rawBlend : landmarks?.[8]?.x;
  const modelTipY = filteredTip ? filteredTip.y * (1 - rawBlend) + landmarks[8].y * rawBlend : landmarks?.[8]?.y;
  const tip = landmarks ? { x: 1 - modelTipX, y: modelTipY } : null;
  // The index tip bends when pinching. Anchor zoom to the steadier palm center
  // so entering/repeating a pinch does not introduce a jump in the zoom delta.
  const zoomPoint = landmarks ? { x: 1 - landmarks[9].x, y: landmarks[9].y } : null;
  // A closed fist hides and bends the index tip, so use the palm center as the
  // rotation cursor. It is more stable while the hand is clenched.
  const rotatePoint = landmarks ? normalizedPalmPoint(landmarks) : null;
  const cursor = $("modelHandCursor");
  if (!tip || !modelHandControl) {
    cursor.classList.remove("visible"); cursor.removeAttribute("data-pose");
    lastModelHandTip = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0; modelMoveAnchor = null; modelMoveTransition = null;
    modelHoverPart = null; modelSelectionCommitted = false; modelPoseLostAt = timestamp;
    resetTwoHandControl();
    return;
  }
  cursor.style.left = (tip.x * 100) + "%"; cursor.style.top = (tip.y * 100) + "%"; cursor.classList.add("visible"); cursor.dataset.pose = pose;
  if (pose !== modelGestureCandidate) { modelGestureCandidate = pose; modelGestureCandidateSince = timestamp; modelGestureCandidateFrames = 1; }
  else modelGestureCandidateFrames += 1;
  // Require both elapsed time and several consecutive frames so a brief
  // landmark wobble cannot switch operation modes. Pending changes pause motion.
  if (pose !== modelHandPose && modelGestureCandidateFrames >= modelPoseConfirmFrames(pose) && timestamp - modelGestureCandidateSince >= modelPoseConfirmMs(pose)) {
    const previousPose = modelHandPose;
    modelHandPose = pose;
    if (pose === "idle" && previousPose === "scale") modelScaleJustReleased = true;
    if (pose === "scale") modelScaleJustReleased = false;
    modelGestureStart = { x: tip.x, y: tip.y, timestamp };
    modelMoveAnchor = null; modelMoveTransition = null;
    lastModelHandTip = pose === "scale" ? zoomPoint : pose === "rotate" ? rotatePoint : tip; modelHandGesture = false; modelDeltaX = 0; modelDeltaY = 0; modelGestureTimestamp = timestamp;
    modelHoverPart = null; modelHoverSince = timestamp; modelSelectionCommitted = false;
    modelPoseLostAt = pose === "idle" ? timestamp : 0;
    if (pose === "select") setModelTargetScope("part");
    if (pose === "whole") setModelTargetScope("whole");
    updateModelGestureUI();
  }
  if (modelHandPose !== pose) {
    modelHandGesture = false; lastModelHandTip = pose === "scale" ? zoomPoint : pose === "rotate" ? rotatePoint : tip; modelMoveTransition = null;
    $("modelViewerHint").textContent = "手势切换中…保持目标姿势片刻即可操作。";
    return;
  }
  if (pose === "select") {
    const pointer = new THREE.Vector2(tip.x * 2 - 1, 1 - tip.y * 2);
    const hovered = raycastModelPart(pointer);
    if (hovered !== modelHoverPart) {
      modelHoverPart = hovered; modelHoverSince = timestamp; modelSelectionCommitted = false;
      if (hovered) showModelSelectionHelper(hovered);
      else showModelSelectionHelper(selectedModelObject);
    }
    const progress = hovered ? Math.min(1, Math.max(0, (timestamp - modelHoverSince) / 550)) : 0;
    cursor.style.setProperty("--select-progress", (progress * 360) + "deg");
    if (hovered && progress >= 1 && !modelSelectionCommitted) {
      selectModelObject(hovered); modelSelectionCommitted = true;
      const record = modelParts.find((part) => part.object === hovered);
      setStatus("已选中 " + (record?.name || "模型部件") + "；单指移动、握拳旋转、捏合缩放。", "info");
    }
    $("modelViewerHint").textContent = hovered ? (modelSelectionCommitted ? "部件已选中 · 单指移动、握拳旋转、捏合缩放" : "指向部件并保持 · " + Math.round(progress * 100) + "%") : "V 字手势：将指尖移到要选的部件上并停留约 0.5 秒。";
    updateModelGestureUI();
    return;
  }
  cursor.style.removeProperty("--select-progress");
  if (pose === "whole") {
    modelHandGesture = false; lastModelHandTip = tip; modelMoveAnchor = null; modelMoveTransition = null;
    $("modelViewerHint").textContent = modelParts.length ? "✓ 整体模型已切换为操作目标 · 单指移动、握拳旋转、捏合缩放" : "整体目标已选 · 请先加载模型";
    updateModelGestureUI(); return;
  }
  if (pose === "idle") {
    modelHandGesture = false; lastModelHandTip = tip; modelDeltaX = 0; modelDeltaY = 0; modelMoveAnchor = null; modelMoveTransition = null;
    $("modelViewerHint").textContent = modelScaleJustReleased ? "缩放已暂停 · 放松手片刻，再次捏合并上下移动可继续调整" : modelTargetScope === "part" && !selectedModelObject ? "V 字手势选中部件，或用鼠标列表选择" : "当前目标：" + (modelTargetScope === "whole" ? "整体模型" : "选中部件") + " · 做出手势开始操作，放松手指停止";
    updateModelGestureUI(); return;
  }
  const target = getModelGestureTarget();
  if (!target) {
    modelHandGesture = false; lastModelHandTip = tip; modelMoveTransition = null;
    $("modelViewerHint").textContent = "请先用 V 字手势选中部件，或举起拇指切换到整体模型。";
    updateModelGestureUI(); return;
  }
  // Movement uses the index tip, scaling uses the palm anchor, and rotation
  // uses the clenched-hand palm center.
  const controlPoint = pose === "scale" ? zoomPoint : pose === "rotate" ? rotatePoint : tip;
  if (!modelHandGesture) {
    modelHandGesture = true; lastModelHandTip = controlPoint; modelDeltaX = 0; modelDeltaY = 0; modelGestureTimestamp = timestamp;
    if (pose === "move") {
      // Move mode intentionally snaps the model center to the index tip. This
      // makes the control point obvious and removes the lag from an initial
      // hand-to-object offset.
      modelMoveAnchor = { x: 0, y: 0 };
      moveModelCenterWithFinger(target, tip, modelMoveAnchor, timestamp);
    }
    return;
  }
  const rawX = Math.max(-.12, Math.min(.12, controlPoint.x - lastModelHandTip.x));
  const rawY = Math.max(-.12, Math.min(.12, controlPoint.y - lastModelHandTip.y));
  lastModelHandTip = controlPoint;
  const smoothing = pose === "scale" ? Math.min(.45, modelSmoothing * .55) : Math.max(0, Math.min(.9, modelSmoothing));
  modelDeltaX = modelDeltaX * smoothing + rawX * (1 - smoothing);
  modelDeltaY = modelDeltaY * smoothing + rawY * (1 - smoothing);
  const deadZone = pose === "rotate" ? .00035 : .0012;
  const dx = Math.abs(modelDeltaX) < deadZone ? 0 : Math.sign(modelDeltaX) * (Math.abs(modelDeltaX) - deadZone);
  const dy = Math.abs(modelDeltaY) < deadZone ? 0 : Math.sign(modelDeltaY) * (Math.abs(modelDeltaY) - deadZone);
  const magnitude = Math.hypot(dx, dy);
  const relativeDistance = depthBaselineSpan && lastDepthMeasurement ? lastDepthMeasurement.factor : 1;
  const depthGain = Math.max(.72, Math.min(1.25, 1 / relativeDistance));
  const speedGain = 1 + Math.min(.15, magnitude * 3);
  const gain = modelSensitivity * depthGain * speedGain;
  if (pose === "move") {
    // Keep the model center on the same screen-plane offset from the index
    // tip. This makes a fast hand movement translate one-for-one in pixels,
    // instead of accumulating a small world-space increment that lags behind.
    moveModelCenterWithFinger(target, tip, modelMoveAnchor || { x: 0, y: 0 }, timestamp);
  }
  if (pose === "rotate") {
    // Rotate in the camera-facing screen frame: horizontal hand travel turns
    // around screen-up, vertical travel around screen-right.
    const viewDirection = modelCamera.getWorldDirection(new THREE.Vector3());
    const screenUp = modelCamera.up.clone().projectOnPlane(viewDirection).normalize();
    const screenRight = viewDirection.clone().cross(screenUp).normalize();
    // The imported assembly is itself pre-rotated, so convert true camera/world
    // axes into the target parent's local frame before applying the delta.
    // Rotation is intentionally amplified: one hand sweep across the usable
    // camera area should cover roughly a full turn.  Deltas remain incremental
    // so the user can keep sweeping back and forth to rotate beyond 360°.
    rotateTargetAroundWorldAxis(target, screenUp, Math.max(-.30, Math.min(.30, -dx * 14.0 * gain)));
    rotateTargetAroundWorldAxis(target, screenRight, Math.max(-.27, Math.min(.27, dy * 12.5 * gain)));
  }
  if (pose === "scale") target.scale.multiplyScalar(Math.max(.8, Math.min(1.25, Math.exp(-dy * 3.2 * gain))));
  if (pose === "rotate" || pose === "scale") constrainModelTargetToViewport(target);
  $("modelViewerHint").textContent = pose === "scale"
    ? "正在捏合缩放 · 掌心上移放大、下移缩小；松开后可再次捏合继续调整"
    : pose === "rotate"
      ? "正在握拳旋转 · 左右绕屏幕 Y 轴、上下绕屏幕 X 轴；张掌或放松停止"
      : "正在" + modelPoseLabel(pose) + " · " + (modelTargetScope === "whole" ? "整体模型" : "选中部件") + " · 张掌或放松停止";
  updateSelectedPartLabel();
}

function modelSceneSignature() {
  const source = modelParts.map(stableModelPartKey).sort().join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}

function savedModelPoseKey() { return "air-drawing:model-pose:v1:" + modelSceneSignature(); }

function stableModelPartKey(part) {
  return part.key?.startsWith("hyper3d:") ? "hyper3d:" + part.file : (part.key || part.id);
}

function updateSavedPoseButtons() {
  const save = $("saveModelPoseBtn"); const restore = $("restoreModelPoseBtn");
  if (!save || !restore) return;
  save.disabled = !modelParts.length;
  let saved = false;
  if (modelParts.length) { try { saved = Boolean(localStorage.getItem(savedModelPoseKey())); } catch (error) { console.warn("[Air Drawing] 无法读取本地模型姿态保存：", error); } }
  restore.disabled = !saved;
  restore.title = saved ? "恢复当前部件组合上次保存的模型、部件和视角状态" : "当前部件组合还没有保存状态";
}

function snapshotTransform(object) {
  return { position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray() };
}

function applyTransformSnapshot(object, snapshot) {
  object.position.fromArray(snapshot.position); object.quaternion.fromArray(snapshot.quaternion); object.scale.fromArray(snapshot.scale); object.updateMatrixWorld(true);
}

function saveModelPose() {
  if (!modelParts.length) return;
  const state = {
    version: 1,
    targetScope: modelTargetScope,
    selectedPart: modelParts.find((part) => part.object === selectedModelObject) ? {
      key: stableModelPartKey(modelParts.find((part) => part.object === selectedModelObject)),
      id: modelParts.find((part) => part.object === selectedModelObject).id
    } : null,
    root: snapshotTransform(modelRoot),
    parts: modelParts.map((part) => ({ key: stableModelPartKey(part), id: part.id, transform: snapshotTransform(part.object), visible: part.object.visible, exploded: part.exploded, beforeExplodePosition: part.beforeExplodePosition?.toArray() || null })),
    camera: { position: modelCamera.position.toArray(), target: modelOrbit.target.toArray() }
  };
  try {
    localStorage.setItem(savedModelPoseKey(), JSON.stringify(state)); updateSavedPoseButtons();
    setStatus("已保存当前模型位置、旋转、缩放、部件显示状态和视角。", "info");
  } catch (error) {
    console.error("[Air Drawing] 保存模型姿态失败：", error);
    setStatus("保存失败：浏览器本地存储不可用或空间不足。", "error");
  }
}

function restoreSavedModelPose() {
  let state;
  try { state = JSON.parse(localStorage.getItem(savedModelPoseKey()) || "null"); }
  catch (error) { console.error("[Air Drawing] 读取模型姿态失败：", error); setStatus("保存状态无法读取，可能已损坏。", "error"); return; }
  if (!state || state.version !== 1 || !Array.isArray(state.parts)) { updateSavedPoseButtons(); return; }
  try {
    applyTransformSnapshot(modelRoot, state.root);
    const used = new Set();
    state.parts.forEach((saved, savedIndex) => {
      let index = stableModelPartKey(modelParts[savedIndex] || {}) === saved.key && !used.has(savedIndex) ? savedIndex : modelParts.findIndex((part, candidateIndex) => !used.has(candidateIndex) && stableModelPartKey(part) === saved.key && part.id === saved.id);
      if (index < 0) return;
      used.add(index); const part = modelParts[index];
      applyTransformSnapshot(part.object, saved.transform); part.object.visible = saved.visible; part.exploded = Boolean(saved.exploded);
      part.beforeExplodePosition = saved.beforeExplodePosition ? new THREE.Vector3().fromArray(saved.beforeExplodePosition) : null;
    });
    if (state.selectedPart) {
      const selected = modelParts.find((part) => stableModelPartKey(part) === state.selectedPart.key && part.id === state.selectedPart.id && part.object.visible);
      if (selected) selectModelObject(selected.object);
    }
    if (state.targetScope === "whole" || state.targetScope === "part") setModelTargetScope(state.targetScope);
    if (state.camera?.position && state.camera?.target) { modelCamera.position.fromArray(state.camera.position); modelOrbit.target.fromArray(state.camera.target); modelOrbit.update(); }
    if (selectedModelObject) showModelSelectionHelper(selectedModelObject);
    updateScenePartList(); updateSelectedPartLabel(); updateModelGestureUI();
    setStatus("已恢复此部件组合最近保存的模型姿态和视角。", "info");
  } catch (error) {
    console.error("[Air Drawing] 恢复模型姿态失败：", error);
    setStatus("恢复失败：保存状态与当前模型不兼容。", "error");
  }
}

function resetModelTarget() {
  if (modelTargetScope === "whole") { resetModelAssemblyTransform(); setStatus("已将整体模型复位到原始位置、方向和比例。", "info"); return; }
  const part = modelParts.find((item) => item.object === selectedModelObject);
  if (!part) return;
  part.object.position.copy(part.originalPosition); part.object.rotation.copy(part.originalRotation); part.object.scale.copy(part.originalScale); part.object.visible = part.originalVisible;
  part.beforeExplodePosition = null; part.exploded = false; part.object.updateMatrixWorld(true);
  showModelSelectionHelper(part.object);
  updateScenePartList(); setStatus("已将 " + part.name + " 复位到导入时的位置和比例。", "info");
}

function resetAllModelParts() {
  if (!modelParts.length) return;
  modelParts.forEach((part) => {
    part.object.position.copy(part.originalPosition); part.object.rotation.copy(part.originalRotation); part.object.scale.copy(part.originalScale); part.object.visible = part.originalVisible;
    part.beforeExplodePosition = null; part.exploded = false; part.object.updateMatrixWorld(true);
  });
  resetModelAssemblyTransform();
  if (selectedModelObject) showModelSelectionHelper(selectedModelObject);
  frameModelObjects(modelParts.map((part) => part.object)); updateScenePartList(); updateSelectedPartLabel();
  setStatus("已将全部部件和整体模型恢复到原始位置，并重新聚焦场景。", "info");
}

function setHeaderStatus(text, active = false) {
  $("headerStatusText").textContent = text;
  $("headerStatusDot").classList.toggle("active", active);
}

function resetDepthMeasurement(keepCalibration = false) {
  depthFilter = null;
  depthFilterTime = 0;
  lastDepthMeasurement = null;
  depthCalibrationSamples = [];
  if (!keepCalibration) {
    depthBaselineSpan = null;
    depthBaselineZ = null;
  }
  const value = $("depthValue");
  if (value) value.textContent = depthBaselineSpan ? "等待手部" : "未校准";
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function measureRelativeDepth(landmarks, timestamp) {
  const width = video.videoWidth || 1;
  const height = video.videoHeight || 1;
  // A 3D palm span combines image-space width and MediaPipe's relative z component,
  // reducing the apparent-width change when the palm rotates in depth.
  const dx = (landmarks[5].x - landmarks[17].x) * width;
  const dy = (landmarks[5].y - landmarks[17].y) * height;
  const dz = ((Number(landmarks[5].z) || 0) - (Number(landmarks[17].z) || 0)) * width;
  const palmSpan = Math.hypot(dx, dy, dz);
  const palmZ = median([5, 9, 13, 17].map((index) => Number(landmarks[index].z) || 0));
  if (!palmSpan) return null;
  if (depthBaselineSpan === null) {
    depthCalibrationSamples.push({ span: palmSpan, z: palmZ });
    if (depthCalibrationSamples.length >= 12) {
      depthBaselineSpan = median(depthCalibrationSamples.map((sample) => sample.span));
      depthBaselineZ = median(depthCalibrationSamples.map((sample) => sample.z));
      depthCalibrationSamples = [];
      depthFilter = null;
      depthFilterTime = 0;
    }
  }
  if (depthBaselineSpan === null) return null;
  // Relative camera distance is estimated from apparent hand scale. MediaPipe's
  // landmark z is wrist-relative, so it is used for 3D palm geometry rather than
  // treated as a camera-to-hand measurement in centimeters.
  const scaleFactor = depthBaselineSpan / Math.max(1, palmSpan);
  const rawFactor = Math.max(.45, Math.min(2.2, scaleFactor));
  const dt = depthFilterTime ? Math.min(.12, Math.max(1 / 120, (timestamp - depthFilterTime) / 1000)) : 1 / 30;
  if (!depthFilter) depthFilter = new OneEuroFilter(.8, .08);
  const factor = depthFilter.filter(rawFactor, dt);
  depthFilterTime = timestamp;
  const band = factor < .82 ? "近" : factor > 1.22 ? "远" : "中";
  lastDepthMeasurement = { factor, band, z: palmZ, zDelta: palmZ - depthBaselineZ, span: palmSpan };
  return lastDepthMeasurement;
}

function renderDepthMeasurement(measurement) {
  const value = $("depthValue");
  if (!value) return;
  if (!measurement) {
    value.textContent = depthBaselineSpan ? "等待手部" : (depthCalibrationSamples.length ? `校准 ${depthCalibrationSamples.length}/12` : "未校准");
    value.parentElement.dataset.band = "";
    return;
  }
  value.textContent = `${measurement.band} ${measurement.factor.toFixed(2)}x · z ${measurement.z.toFixed(3)}`;
  value.parentElement.dataset.band = measurement.band;
  value.title = `MediaPipe 相对 z ${measurement.z.toFixed(3)}（校准变化 ${measurement.zDelta.toFixed(3)}）/ 三维掌宽 ${Math.round(measurement.span)} px`;
}

function calibrateDepth() {
  if (lastDepthMeasurement) {
    depthBaselineSpan = lastDepthMeasurement.span;
    depthBaselineZ = lastDepthMeasurement.z;
    depthCalibrationSamples = [];
    depthFilter = null;
    depthFilterTime = 0;
    renderDepthMeasurement({ ...lastDepthMeasurement, factor: 1, band: "中", zDelta: 0 });
    setStatus("相对距离已重新校准为当前手部位置。", "info");
    return;
  }
  depthCalibrationSamples = [];
  depthBaselineSpan = null;
  depthBaselineZ = null;
  resetDepthMeasurement(false);
  setStatus("请将手放在希望的参考位置，保持稳定约半秒后自动校准。", "info");
}

function resizeCanvas(canvas, ctx, preserve = true) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let snapshot = null;
  if (preserve && canvas.width && canvas.height) snapshot = document.createElement("canvas");
  if (snapshot) { snapshot.width = canvas.width; snapshot.height = canvas.height; snapshot.getContext("2d").drawImage(canvas, 0, 0); }
  canvas.width = Math.round(rect.width * devicePixelRatio);
  canvas.height = Math.round(rect.height * devicePixelRatio);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  if (snapshot) ctx.drawImage(snapshot, 0, 0, rect.width, rect.height);
}

function resizeAll() {
  resizeCanvas(landmarkCanvas, landmarkCtx, false);
  resizeCanvas(drawingCanvas, drawingCtx, true);
  resizeCanvas(stageHandCanvas, stageHandCtx, false);
  resizeCanvas(stageVideoCanvas, stageVideoCtx, false);
  redrawAll();
}

function setTool(tool) {
  finishStroke();
  selectionMode = tool === "select";
  isEraser = tool === "eraser";
  if (!selectionMode) selectedStroke = null;
  $("penBtn").classList.toggle("active", tool === "pen"); $("penBtn").setAttribute("aria-pressed", String(tool === "pen"));
  $("eraserBtn").classList.toggle("active", isEraser); $("eraserBtn").setAttribute("aria-pressed", String(isEraser));
  $("selectStrokeBtn").classList.toggle("active", selectionMode); $("selectStrokeBtn").setAttribute("aria-pressed", String(selectionMode));
  $("drawingWrap").classList.toggle("selection-active", selectionMode);
  selectionDrag = null;
  redrawAll();
  setStatus(selectionMode
    ? "选择/移动已启用：点击一笔后拖动，可整体移动；隔空落笔已暂停。"
    : isEraser ? "橡皮擦已启用，按当前手指模式可擦除线条。" : "画笔已启用，按当前手指模式可开始绘画。");
}

function updateGestureModeUI() {
  document.querySelectorAll("[data-gesture-mode]").forEach((item) => {
    const active = item.dataset.gestureMode === gestureMode;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  const isPinch = gestureMode === "pinch";
  $("gestureHintTitle").textContent = isPinch ? "捏合落笔，松开停笔" : "伸出食指落笔，弯曲停笔";
  $("gestureHintText").textContent = isPinch
    ? "短暂漏检或快速移动会自动补线；松开即可抬笔，移动后再次捏合继续画。"
    : "短暂漏检或快速移动会自动补线；弯曲食指抬笔，移动后再伸出继续画。";
  $("drawEmptyTitle").textContent = isPinch ? "捏合手指开始创作" : "伸出食指开始创作";
  updateDrawingUI();
}

function redrawAll() {
  const rect = drawingCanvas.getBoundingClientRect();
  drawingCtx.clearRect(0, 0, rect.width, rect.height);
  for (const stroke of strokes) drawStroke(stroke);
  if (currentStroke) drawStroke(currentStroke);
  if (selectionMode && selectedStroke && strokes.includes(selectedStroke)) drawSelectionOutline(selectedStroke);
  updateDrawingUI();
}

function updateDrawingUI() {
  $("drawEmpty").classList.toggle("hidden", strokes.length > 0 || !!currentStroke);
  if (!strokes.length && !currentStroke) {
    $("drawEmptyTitle").textContent = selectionMode ? "还没有可移动的笔画" : gestureMode === "pinch" ? "捏合手指开始创作" : "伸出食指开始创作";
    $("drawEmpty").querySelector("span").textContent = selectionMode ? "切回画笔画出一笔，再选择并拖动" : "线条会出现在这里";
  }
  $("strokeCount").textContent = `${strokes.length + (currentStroke ? 1 : 0)} 笔`;
}

function strokeBounds(stroke) {
  const rect = drawingCanvas.getBoundingClientRect();
  const radiusX = (stroke.size / 2 + 7) / Math.max(1, rect.width);
  const radiusY = (stroke.size / 2 + 7) / Math.max(1, rect.height);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of stroke.points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
  return {
    minX: Math.max(0, minX - radiusX), maxX: Math.min(1, maxX + radiusX),
    minY: Math.max(0, minY - radiusY), maxY: Math.min(1, maxY + radiusY)
  };
}

function drawSelectionOutline(stroke) {
  const rect = drawingCanvas.getBoundingClientRect(), bounds = strokeBounds(stroke);
  const x = bounds.minX * rect.width, y = bounds.minY * rect.height;
  const width = (bounds.maxX - bounds.minX) * rect.width, height = (bounds.maxY - bounds.minY) * rect.height;
  drawingCtx.save();
  drawingCtx.globalCompositeOperation = "source-over";
  drawingCtx.shadowBlur = 0;
  drawingCtx.strokeStyle = "rgba(84,230,192,.95)";
  drawingCtx.lineWidth = 1.5;
  drawingCtx.setLineDash([5, 4]);
  drawingCtx.strokeRect(x, y, Math.max(8, width), Math.max(8, height));
  drawingCtx.setLineDash([]);
  drawingCtx.fillStyle = "#54E6C0";
  drawingCtx.fillRect(x - 3, y - 3, 6, 6);
  drawingCtx.fillRect(x + width - 3, y + height - 3, 6, 6);
  drawingCtx.restore();
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function findStrokeAt(point) {
  const rect = drawingCanvas.getBoundingClientRect();
  const pixelPoint = { x: point.x * rect.width, y: point.y * rect.height };
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (stroke.eraser || !stroke.points.length) continue;
    const tolerance = 12 + stroke.size / 2;
    if (stroke.points.length === 1) {
      const only = stroke.points[0];
      if (Math.hypot(pixelPoint.x - only.x * rect.width, pixelPoint.y - only.y * rect.height) <= tolerance) return stroke;
      continue;
    }
    for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
      const previous = stroke.points[pointIndex - 1], current = stroke.points[pointIndex];
      const start = { x: previous.x * rect.width, y: previous.y * rect.height };
      const end = { x: current.x * rect.width, y: current.y * rect.height };
      if (distanceToSegment(pixelPoint, start, end) <= tolerance) return stroke;
    }
  }
  return null;
}

function normalizedCanvasPoint(event) {
  const rect = drawingCanvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
}

function beginStrokeSelection(event) {
  if (!selectionMode || event.button !== 0) return;
  event.preventDefault();
  finishStroke();
  const point = normalizedCanvasPoint(event);
  selectedStroke = findStrokeAt(point);
  if (selectedStroke) {
    const rect = drawingCanvas.getBoundingClientRect();
    drawingCanvas.setPointerCapture(event.pointerId);
    selectionDrag = { pointerId: event.pointerId, start: point, points: selectedStroke.points.map((item) => ({ ...item })) };
    setStatus("已选择一笔；拖动可移动，点击空白处可取消选择。", "info");
  } else {
    selectionDrag = null;
    setStatus("未选中笔画；请点在线条附近，或切回画笔继续绘制。", "info");
  }
  redrawAll();
}

function moveSelectedStroke(event) {
  if (!selectionMode || !selectionDrag || selectionDrag.pointerId !== event.pointerId || !selectedStroke) return;
  event.preventDefault();
  const point = normalizedCanvasPoint(event);
  const dx = point.x - selectionDrag.start.x, dy = point.y - selectionDrag.start.y;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const item of selectionDrag.points) { minX = Math.min(minX, item.x); maxX = Math.max(maxX, item.x); minY = Math.min(minY, item.y); maxY = Math.max(maxY, item.y); }
  const limitedX = Math.max(-minX, Math.min(1 - maxX, dx));
  const limitedY = Math.max(-minY, Math.min(1 - maxY, dy));
  selectedStroke.points = selectionDrag.points.map((item) => ({ x: item.x + limitedX, y: item.y + limitedY }));
  redrawAll();
}

function endStrokeSelection(event) {
  if (!selectionDrag || selectionDrag.pointerId !== event.pointerId) return;
  selectionDrag = null;
  if (drawingCanvas.hasPointerCapture(event.pointerId)) drawingCanvas.releasePointerCapture(event.pointerId);
  redrawAll();
}

function drawStroke(stroke) {
  if (!stroke?.points?.length) return;
  const rect = drawingCanvas.getBoundingClientRect();
  drawingCtx.save();
  applyStrokeStyle(drawingCtx, stroke);
  drawingCtx.beginPath();
  const [first, ...rest] = stroke.points;
  drawingCtx.moveTo(first.x * rect.width, first.y * rect.height);
  if (stroke.points.length === 1) drawingCtx.lineTo(first.x * rect.width + .01, first.y * rect.height + .01);
  else {
    for (let i = 0; i < rest.length; i += 1) {
      const current = rest[i], next = rest[i + 1];
      const x = current.x * rect.width, y = current.y * rect.height;
      if (next) drawingCtx.quadraticCurveTo(x, y, (x + next.x * rect.width) / 2, (y + next.y * rect.height) / 2);
      else drawingCtx.lineTo(x, y);
    }
  }
  drawingCtx.stroke(); drawingCtx.restore();
}

function applyStrokeStyle(ctx, stroke) {
  ctx.globalCompositeOperation = stroke.eraser ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (!stroke.eraser) {
    ctx.shadowColor = stroke.color;
    ctx.shadowBlur = Math.min(14, stroke.size * 1.15);
  }
}

function drawSegments(stroke, points) {
  const rect = drawingCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height || points.length < 2) return;
  drawingCtx.save();
  applyStrokeStyle(drawingCtx, stroke);
  drawingCtx.beginPath();
  drawingCtx.moveTo(points[0].x * rect.width, points[0].y * rect.height);
  for (let i = 1; i < points.length; i += 1) drawingCtx.lineTo(points[i].x * rect.width, points[i].y * rect.height);
  drawingCtx.stroke();
  drawingCtx.restore();
}

function finishStroke(redraw = true) {
  if (currentStroke?.points?.length) strokes.push(currentStroke);
  currentStroke = null;
  drawingActive = false;
  lastDrawTimestamp = 0;
  if (redraw) updateDrawingUI();
}

function addPoint(point, timestamp = performance.now()) {
  if (!drawEnabled) return;
  if (!currentStroke) {
    currentStroke = { color: brushColor, size: brushSize, eraser: isEraser, points: [] };
    drawingActive = true;
    updateDrawingUI();
  }
  const previous = currentStroke.points.at(-1);
  const rect = drawingCanvas.getBoundingClientRect();
  // The tracking point is already normalized to the drawing surface.
  const clamped = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
  if (!previous) {
    currentStroke.points.push(clamped);
    drawSegments(currentStroke, [clamped, { x: clamped.x + 0.001, y: clamped.y + 0.001 }]);
  } else {
    const distance = Math.hypot((clamped.x - previous.x) * rect.width, (clamped.y - previous.y) * rect.height);
    if (distance > 1.2) {
      // Fill dropped samples so fast hand motion remains one continuous stroke.
      const steps = Math.min(80, Math.max(1, Math.ceil(distance / 5)));
      const segmentPoints = [previous];
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        const next = { x: previous.x + (clamped.x - previous.x) * ratio, y: previous.y + (clamped.y - previous.y) * ratio };
        currentStroke.points.push(next);
        segmentPoints.push(next);
      }
      drawSegments(currentStroke, segmentPoints);
    }
  }
  lastDrawTimestamp = timestamp;
  pausedPoint = null;
}

function renderLandmarks(ctx, canvas, landmarks, { color = "#26DDF5", active = false, label = null } = {}) {
  const width = canvas.getBoundingClientRect().width;
  const height = canvas.getBoundingClientRect().height;
  if (!landmarks) return;
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale, renderedHeight = video.videoHeight * scale;
  const cropX = (renderedWidth - width) / 2, cropY = (renderedHeight - height) / 2;
  const point = (index) => ({ x: renderedWidth * (1 - landmarks[index].x) - cropX, y: renderedHeight * landmarks[index].y - cropY });
  ctx.lineWidth = active ? 2 : 1.5; ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = active ? 7 : 3;
  for (const [from, to] of CONNECTIONS) { const a = point(from), b = point(to); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  landmarks.forEach((_, index) => { const p = point(index); ctx.beginPath(); ctx.arc(p.x, p.y, index === 8 ? (active ? 5.5 : 4.5) : 2.8, 0, Math.PI * 2); ctx.fillStyle = index === 8 && active ? "#FFCC66" : color; ctx.fill(); });
  const tip = point(8); ctx.beginPath(); ctx.arc(tip.x, tip.y, active ? 11 : 8, 0, Math.PI * 2); ctx.strokeStyle = active ? "rgba(255,204,102,.85)" : color; ctx.stroke();
  const effectActive = active && (gestureMode === "pinch" ? pinchActive : indexModeActive);
  if (effectActive) {
    ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.74)"; ctx.lineWidth = 1;
    for (let i = 0; i < 12; i += 1) { const angle = (i / 12) * Math.PI * 2; const inner = 15 + (i % 3) * 3; const outer = inner + 7 + (i % 2) * 4; ctx.beginPath(); ctx.moveTo(tip.x + Math.cos(angle) * inner, tip.y + Math.sin(angle) * inner); ctx.lineTo(tip.x + Math.cos(angle) * outer, tip.y + Math.sin(angle) * outer); ctx.stroke(); }
    ctx.restore();
  }
  const wrist = point(0);
  ctx.save(); ctx.shadowBlur = 0; ctx.font = "600 11px system-ui, sans-serif"; ctx.textBaseline = "middle";
  const handText = `${label === "Right" ? "右手" : label === "Left" ? "左手" : "手部"}${active ? " · 主控" : ""}`;
  const labelWidth = ctx.measureText(handText).width + 12;
  ctx.fillStyle = "rgba(5,11,20,.78)"; ctx.fillRect(wrist.x + 9, wrist.y + 8, labelWidth, 21);
  ctx.fillStyle = color; ctx.fillText(handText, wrist.x + 15, wrist.y + 18);
  ctx.restore();
  ctx.shadowBlur = 0;
}

function drawLandmarks(hands) {
  for (const [ctx, canvas] of [[landmarkCtx, landmarkCanvas], ...(singleScreen ? [[stageHandCtx, stageHandCanvas]] : [])]) {
    ctx.clearRect(0, 0, canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height);
    hands.forEach((hand) => renderLandmarks(ctx, canvas, hand.landmarks, { color: hand.label === "Right" ? "#26DDF5" : "#FF6B91", active: hand.interactive, label: hand.label }));
  }
  if (!singleScreen) stageHandCtx.clearRect(0, 0, stageHandCanvas.getBoundingClientRect().width, stageHandCanvas.getBoundingClientRect().height);
}

function updateSingleScreenOverlay() {
  const modelOverlay = singleScreen && activeWorkspace === "model";
  const destination = modelOverlay ? modelViewer : drawingWrap;
  if (stageHandCanvas.parentElement !== destination) destination.appendChild(stageHandCanvas);
  $("stage").classList.toggle("single-model-mode", modelOverlay);
  $("singleModeBtn").setAttribute("aria-pressed", String(singleScreen));
  $("singleModeBtn").textContent = singleScreen ? "▣ 双屏工作区" : "▣ 单屏工作台";
  requestAnimationFrame(() => { resizeCanvas(stageHandCanvas, stageHandCtx, false); resizeCanvas(stageVideoCanvas, stageVideoCtx, false); resizeModelViewer(); });
}

function handLabelFromResult(handedness) {
  const category = handedness?.[0];
  const label = category?.categoryName || category?.displayName;
  if (label !== "Left" && label !== "Right") return null;
  return swapHandLabels ? (label === "Left" ? "Right" : "Left") : label;
}

function assignHandRoles(result) {
  const landmarks = result.landmarks || [];
  const hands = landmarks.map((points, index) => ({ landmarks: points, label: handLabelFromResult(result.handednesses?.[index]) }));
  if (hands.length === 1) {
    // A single hand with a temporarily missing handedness category is still a
    // safe interaction target. With two hands we require stable labels below to
    // avoid accidentally assigning the secondary hand as the controller.
    hands[0].interactive = !hands[0].label || hands[0].label === primaryHand;
    return { hands, active: hands[0].interactive ? hands[0] : null, secondary: null, ambiguous: false };
  }
  if (hands.length > 1) {
    const primary = hands.find((hand) => hand.label === primaryHand);
    const secondary = hands.find((hand) => hand.label && hand.label !== primaryHand);
    if (primary && secondary) {
      const wristDistance = Math.hypot(primary.landmarks[0].x - secondary.landmarks[0].x, primary.landmarks[0].y - secondary.landmarks[0].y);
      if (wristDistance < .16) return { hands, active: null, secondary: null, ambiguous: true };
      primary.interactive = true;
      secondary.interactive = false;
      return { hands, active: primary, secondary, ambiguous: false };
    }
    return { hands, active: null, secondary: null, ambiguous: true };
  }
  return { hands, active: null, secondary: null, ambiguous: false };
}

function drawStageVideo() {
  const rect = stageVideoCanvas.getBoundingClientRect();
  if (!singleScreen || !stream || video.readyState < 2 || !rect.width || !rect.height) {
    stageVideoCtx.clearRect(0, 0, rect.width, rect.height);
    return;
  }
  const videoWidth = video.videoWidth || 1;
  const videoHeight = video.videoHeight || 1;
  const canvasRatio = rect.width / rect.height;
  const videoRatio = videoWidth / videoHeight;
  let sourceX = 0, sourceY = 0, sourceWidth = videoWidth, sourceHeight = videoHeight;
  if (videoRatio > canvasRatio) {
    sourceWidth = videoHeight * canvasRatio;
    sourceX = (videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = videoWidth / canvasRatio;
    sourceY = (videoHeight - sourceHeight) / 2;
  }
  stageVideoCtx.save();
  stageVideoCtx.clearRect(0, 0, rect.width, rect.height);
  stageVideoCtx.translate(rect.width, 0);
  stageVideoCtx.scale(-1, 1);
  stageVideoCtx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, rect.width, rect.height);
  stageVideoCtx.restore();
}

function mapTipToCanvas(point, canvas) {
  const rect = canvas.getBoundingClientRect();
  const videoWidth = video.videoWidth || 1;
  const videoHeight = video.videoHeight || 1;
  const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const cropX = (renderedWidth - rect.width) / 2;
  const cropY = (renderedHeight - rect.height) / 2;
  return { x: (renderedWidth * (1 - point.x) - cropX) / rect.width, y: (renderedHeight * point.y - cropY) / rect.height };
}

function fingerExtensionAngle(landmarks, mcp, pip, tip) {
  const a = { x: landmarks[mcp].x - landmarks[pip].x, y: landmarks[mcp].y - landmarks[pip].y, z: (landmarks[mcp].z || 0) - (landmarks[pip].z || 0) };
  const b = { x: landmarks[tip].x - landmarks[pip].x, y: landmarks[tip].y - landmarks[pip].y, z: (landmarks[tip].z || 0) - (landmarks[pip].z || 0) };
  const lengths = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
  if (!lengths) return 0;
  const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / lengths));
  return Math.acos(cosine) * 180 / Math.PI;
}

function updateTracking(landmarks, timestamp, secondaryLandmarks = null) {
  if (!landmarks) {
    if (handPresent) {
      missingSince = timestamp;
      pausedPoint = currentStroke?.points?.at(-1) || null;
      if (currentStroke) drawGestureHoldUntil = timestamp + STROKE_RESUME_WINDOW_MS;
    }
    if (currentStroke && missingSince && timestamp - missingSince > STROKE_RESUME_WINDOW_MS) finishStroke();
    handPresent = false; smoothedTip = null; pinchActive = false; indexModeActive = false; filterX = null; filterY = null; lastFilterTime = 0;
    lastDepthMeasurement = null;
    $("handValue").textContent = "0 / 2"; $("trackingChipText").textContent = "等待手部"; $("trackingChip").querySelector(".chip-dot").classList.remove("active");
    $("coordinateValue").textContent = "X --- / Y ---"; $("gestureValue").textContent = "等待输入";
    renderDepthMeasurement(null);
    resetTwoHandControl();
    applyModelHandControl(null, timestamp);
    updateModelGestureUI();
    $("tipCursor").classList.remove("visible", "drawing");
    $("modeBadge").textContent = selectionMode ? "SELECT" : "READY"; $("modeBadge").classList.remove("drawing"); $("drawingStateText").textContent = selectionMode ? selectedStroke ? "已选中 · 可拖动" : "选择/移动模式" : drawEnabled ? "等待手部" : "绘画已暂停";
    return;
  }
  handPresent = true;
  renderDepthMeasurement(measureRelativeDepth(landmarks, timestamp));
  const gap = missingSince ? timestamp - missingSince : 0;
  missingSince = 0;
  const rawTip = { x: landmarks[8].x, y: landmarks[8].y };
  const dt = lastFilterTime ? Math.min(.08, Math.max(1 / 120, (timestamp - lastFilterTime) / 1000)) : 1 / 30;
  if (!filterX) { filterX = new OneEuroFilter(); filterY = new OneEuroFilter(); }
  smoothedTip = { x: filterX.filter(rawTip.x, dt), y: filterY.filter(rawTip.y, dt) };
  lastFilterTime = timestamp;
  const width = video.videoWidth || 1, height = video.videoHeight || 1;
  const pinchDistance = Math.hypot((landmarks[4].x - landmarks[8].x) * width, (landmarks[4].y - landmarks[8].y) * height);
  const palmSpan = Math.hypot((landmarks[0].x - landmarks[9].x) * width, (landmarks[0].y - landmarks[9].y) * height);
  const pinchRatio = pinchDistance / Math.max(1, palmSpan);
  pinchActive = pinchActive ? pinchRatio < .42 : pinchRatio < .30;
  const pinching = pinchActive;
  const indexAngle = fingerExtensionAngle(landmarks, 5, 6, 8);
  const foldedFingerAngles = [fingerExtensionAngle(landmarks, 9, 10, 12), fingerExtensionAngle(landmarks, 13, 14, 16), fingerExtensionAngle(landmarks, 17, 18, 20)];
  const modelPose = classifyModelHandPose(landmarks, pinching);
  const twoHandGesture = activeWorkspace === "model" && modelTwoHandMode && secondaryLandmarks && !["select", "whole", "idle"].includes(modelPose);
  if (twoHandGesture) applyTwoHandModelControl(landmarks, secondaryLandmarks, timestamp);
  else {
    resetTwoHandControl();
    applyModelHandControl(landmarks, timestamp, modelPose);
  }
  const foldedCount = foldedFingerAngles.filter((angle) => angle < 168).length;
  // Use hysteresis so a small landmark wobble does not repeatedly lift the pen.
  const indexPose = indexModeActive
    ? indexAngle > 124 && foldedCount >= 1
    : indexAngle > 136 && foldedCount >= 2;
  indexModeActive = indexPose;
  const poseDrawing = gestureMode === "pinch" ? pinching : indexPose;
  if (poseDrawing) drawGestureHoldUntil = timestamp + GESTURE_HOLD_MS;
  const drawingGesture = poseDrawing || timestamp < drawGestureHoldUntil;
  const drawPoint = mapTipToCanvas(smoothedTip, drawingCanvas);
  // A small edge tolerance prevents the crop/landmark jitter at the bottom edge
  // from lifting the pen for a single frame. Points are clamped before drawing.
  const edgeTolerance = 0.045;
  const inCanvas = drawPoint.x >= -edgeTolerance && drawPoint.x <= 1 + edgeTolerance && drawPoint.y >= -edgeTolerance && drawPoint.y <= 1 + edgeTolerance;
  const canvasPoint = { x: Math.max(0, Math.min(1, drawPoint.x)), y: Math.max(0, Math.min(1, drawPoint.y)) };
  $("handValue").textContent = "已检测";
  const modelGestureActive = activeWorkspace === "model" && modelHandControl && (modelTwoHandActive || ["move", "rotate", "scale"].includes(modelHandPose)) && Boolean(getModelGestureTarget());
  $("trackingChipText").textContent = activeWorkspace === "model" ? (modelTwoHandActive ? "3D 双手操控" : modelGestureActive ? "3D " + modelPoseLabel(modelHandPose) : modelHandControl ? "3D " + modelPoseLabel(modelHandPose) : "3D 跟踪中") : selectionMode ? "选择/拖动" : drawingGesture ? (gestureMode === "pinch" ? "捏合中" : "食指绘画") : "跟踪中";
  $("trackingChip").querySelector(".chip-dot").classList.add("active");
  $("coordinateValue").textContent = `X ${Math.round((1 - smoothedTip.x) * 1000)} / Y ${Math.round(smoothedTip.y * 1000)}`;
  $("gestureValue").textContent = activeWorkspace === "model" ? (modelHandControl ? (modelTwoHandActive ? "双手操控中" : modelHandPose === "idle" ? (modelParts.length ? "V 字选部件 / 拇指切整体" : "请先加载模型") : modelPoseLabel(modelHandPose) + (modelGestureActive ? "中" : "")) : "3D 手势已关闭") : selectionMode ? "选择并拖动一笔" : drawingGesture ? (gestureMode === "pinch" ? "捏合绘画" : "食指绘画") : (gestureMode === "pinch" ? "手指抬起" : "食指未伸出");
  $("tipCursor").style.left = `${drawPoint.x * 100}%`; $("tipCursor").style.top = `${drawPoint.y * 100}%`; $("tipCursor").classList.toggle("visible", handPresent); $("tipCursor").classList.toggle("drawing", !selectionMode && drawingGesture && drawEnabled);
  if (activeWorkspace === "draw" && !selectionMode && drawingGesture && drawEnabled && inCanvas) {
    // Short detector gaps are recoverable: addPoint() bridges the gap with
    // interpolated samples. A long gap or a very large jump starts a new stroke.
    const referencePoint = pausedPoint || currentStroke?.points?.at(-1);
    const distance = referencePoint && Math.hypot((canvasPoint.x - referencePoint.x) * drawingCanvas.clientWidth, (canvasPoint.y - referencePoint.y) * drawingCanvas.clientHeight);
    const canvasSize = Math.max(drawingCanvas.clientWidth, drawingCanvas.clientHeight);
    const sampleGap = lastDrawTimestamp ? Math.max(0, timestamp - lastDrawTimestamp) : 33;
    // Allow a speed-proportional gap for rapid motion, but keep reacquisition
    // after a longer hand loss conservative to avoid drawing across the canvas.
    const speedBasedLimit = Math.min(canvasSize * 1.35, 180 + sampleGap * 5.5);
    const lostHandSpeed = gap > 0 ? distance / Math.max(.016, sampleGap / 1000) : 0;
    const hardJump = distance > Math.max(320, speedBasedLimit) || (gap > 0 && lostHandSpeed > 4200);
    const expiredGap = gap > STROKE_RESUME_WINDOW_MS;
    if ((expiredGap || hardJump) && currentStroke) finishStroke();
    addPoint(canvasPoint, timestamp);
  } else if (drawingActive) finishStroke();
  if (activeWorkspace === "draw" && !selectionMode && drawingGesture && drawEnabled && inCanvas) { $("modeBadge").textContent = isEraser ? "ERASING" : "DRAWING"; $("modeBadge").classList.add("drawing"); $("drawingStateText").textContent = isEraser ? "正在擦除" : "正在绘画"; } else { $("modeBadge").textContent = selectionMode ? "SELECT" : "READY"; $("modeBadge").classList.remove("drawing"); $("drawingStateText").textContent = activeWorkspace === "model" ? "3D 模型工作区" : selectionMode ? selectedStroke ? "已选中 · 可拖动" : "选择/移动模式" : drawEnabled ? (drawingGesture ? "移出画布范围" : "画布待命") : "绘画已暂停"; }
}

async function loadModel() {
  if (handLandmarker) return;
  if (modelPromise) return modelPromise;
  setStatus("正在加载 MediaPipe 手部模型，请稍候…");
  modelPromise = (async () => {
    let timeoutId;
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("模型加载超时，请检查网络连接后重试。")), 60000); });
    const load = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      const options = { baseOptions: { modelAssetPath: MODEL_URL }, runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: .60, minHandPresenceConfidence: .55, minTrackingConfidence: .55 };
      try { return await HandLandmarker.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } }); }
      catch (gpuError) { console.warn("[Air Drawing] GPU delegate unavailable; retrying with CPU.", gpuError); return HandLandmarker.createFromOptions(vision, options); }
    })();
    try { handLandmarker = await Promise.race([load, timeout]); } finally { clearTimeout(timeoutId); }
  })();
  try { await modelPromise; } catch (error) { modelPromise = null; handLandmarker = null; throw error; }
}

async function startCamera() {
  if (stream) return;
  try {
    $("startCameraBtn").disabled = true;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境不支持摄像头访问，请通过 localhost 或 HTTPS 打开页面。");
    await loadModel();
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 }, facingMode: "user" }, audio: false });
    video.srcObject = stream; await video.play();
    $("cameraPlaceholder").classList.add("hidden"); $("stopCameraBtn").disabled = false; $("liveBadge").textContent = "LIVE"; $("liveBadge").classList.add("on"); setHeaderStatus("摄像头运行中", true);
    setStatus(gestureMode === "pinch" ? "摄像头已连接。捏合拇指与食指落笔，松开后可移动到新位置。" : "摄像头已连接。伸出食指落笔，弯曲食指后可移动到新位置。");
    lastVideoTime = -1; scheduleNextFrame();
  } catch (error) {
    console.error("[Air Drawing] Camera/model startup failed:", error);
    const detail = error?.name === "NotAllowedError" ? "摄像头权限被拒绝，请在浏览器地址栏允许访问后重试。" : `无法启动摄像头：${error?.message || "未知错误"}`;
    setStatus(detail, "error"); setHeaderStatus("连接失败"); $("startCameraBtn").disabled = false;
  }
}

function stopCamera() {
  if (frameLoopMode === "video" && frameCallbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallbackId);
  if (frameLoopMode === "raf" && animationId !== null) cancelAnimationFrame(animationId);
  animationId = null; frameCallbackId = null; frameLoopMode = null;
  if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null; video.srcObject = null;
  finishStroke(); landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height); stageVideoCtx.clearRect(0, 0, stageVideoCanvas.getBoundingClientRect().width, stageVideoCanvas.getBoundingClientRect().height); resetDepthMeasurement(false); updateTracking(null);
  $("cameraPlaceholder").classList.remove("hidden"); $("startCameraBtn").disabled = false; $("stopCameraBtn").disabled = true; $("liveBadge").textContent = "OFFLINE"; $("liveBadge").classList.remove("on"); setHeaderStatus("摄像头未连接"); setStatus("摄像头已停止。点击启动摄像头重新开始。");
}

function processFrame(now) {
  if (!stream || !handLandmarker) return;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    try {
      const result = handLandmarker.detectForVideo(video, now);
      const roles = assignHandRoles(result);
      if (roles.ambiguous || (roles.hands.length && !roles.active)) {
        finishStroke(); pausedPoint = null; drawGestureHoldUntil = 0;
        lastModelHandTip = null; modelHandGesture = null; resetTwoHandControl();
      }
      drawStageVideo(); drawLandmarks(roles.hands); updateTracking(roles.active?.landmarks || null, now, roles.secondary?.landmarks || null);
      const count = roles.hands.length;
      $("handValue").textContent = `${count} / 2`;
      if (roles.ambiguous) {
        $("trackingChipText").textContent = "手部交叉 / 标签不稳，已暂停";
        $("trackingChip").querySelector(".chip-dot").classList.remove("active");
        $("gestureValue").textContent = "交叉时暂停，分开后继续";
      } else if (count && !roles.active) {
        $("trackingChipText").textContent = `${primaryHand === "Right" ? "右" : "左"}手主控；等待该手`;
        $("trackingChip").querySelector(".chip-dot").classList.remove("active");
        $("gestureValue").textContent = "仅主控手可操作";
      } else if (roles.active && count > 1) {
        $("trackingChipText").textContent = `${primaryHand === "Right" ? "右" : "左"}手主控 · 双手已分离`;
      }
      lastVideoTime = video.currentTime; fpsFrameCount++;
    } catch (error) { console.error("[Air Drawing] Frame detection failed:", error); }
  }
  const elapsed = now - fpsWindowStart; if (elapsed >= 1000) { $("fpsValue").textContent = Math.round(fpsFrameCount * 1000 / elapsed); fpsFrameCount = 0; fpsWindowStart = now; }
  scheduleNextFrame();
}

function scheduleNextFrame() {
  if (!stream) return;
  if (typeof video.requestVideoFrameCallback === "function") {
    frameLoopMode = "video";
    frameCallbackId = video.requestVideoFrameCallback((now) => processFrame(now));
  } else {
    frameLoopMode = "raf";
    animationId = requestAnimationFrame(processFrame);
  }
}

$("startCameraBtn").addEventListener("click", startCamera); $("stopCameraBtn").addEventListener("click", stopCamera);
$("penBtn").addEventListener("click", () => setTool("pen")); $("eraserBtn").addEventListener("click", () => setTool("eraser"));
$("selectStrokeBtn").addEventListener("click", () => setTool("select"));
drawingCanvas.addEventListener("pointerdown", beginStrokeSelection);
drawingCanvas.addEventListener("pointermove", moveSelectedStroke);
drawingCanvas.addEventListener("pointerup", endStrokeSelection);
drawingCanvas.addEventListener("pointercancel", endStrokeSelection);
document.querySelectorAll("[data-gesture-mode]").forEach((button) => button.addEventListener("click", () => {
  gestureMode = button.dataset.gestureMode;
  finishStroke();
  indexModeActive = false; pinchActive = false; drawGestureHoldUntil = 0;
  updateGestureModeUI();
  setStatus(gestureMode === "pinch" ? "已切换为捏合绘画模式。" : "已切换为食指绘画模式，效果与视频一致。", "info");
}));
$("singleModeBtn").addEventListener("click", () => {
  singleScreen = !singleScreen;
  $("stage").classList.toggle("single-mode", singleScreen);
  updateSingleScreenOverlay();
  setStatus(singleScreen ? (activeWorkspace === "model" ? "3D 单屏工作台已启用：识别到的手部骨架叠加在模型画面上。" : "单屏工作台已启用：手部骨架与笔迹叠加在摄像头画面上。") : "已恢复双屏工作区。", "info");
  requestAnimationFrame(resizeAll);
});
$("drawWorkspaceBtn").addEventListener("click", () => setActiveWorkspace("draw"));
$("modelWorkspaceBtn").addEventListener("click", () => setActiveWorkspace("model"));
$("catalogSearch").addEventListener("input", renderCatalogResults);
$("modelModuleSelect").addEventListener("change", updateModelModuleSelection);
$("addModelModuleBtn").addEventListener("click", () => addSelectedModelModule(false));
$("replaceModelModuleBtn").addEventListener("click", () => addSelectedModelModule(true));
$("hyper3dInputMode").addEventListener("change", updateHyper3DInputMode);
$("hyper3dImages").addEventListener("change", updateHyper3DImageNames);
$("hyper3dGenerateBtn").addEventListener("click", generateHyper3D);
$("loadCatalogBtn").addEventListener("click", addSelectedCatalogParts);
$("importObjBtn").addEventListener("click", () => $("objFileInput").click());
$("importFolderBtn").addEventListener("click", () => $("objFolderInput").click());
$("objFileInput").addEventListener("change", (event) => addLocalFiles(event.target.files));
$("objFolderInput").addEventListener("change", (event) => indexLocalFolder(event.target.files));
document.querySelectorAll("[data-transform-mode]").forEach((button) => button.addEventListener("click", () => {
  transformMode = button.dataset.transformMode; document.querySelectorAll("[data-transform-mode]").forEach((item) => item.classList.toggle("active", item === button));
  if (modelTransform) modelTransform.setMode(transformMode); updateModelGestureUI(); setStatus("鼠标变换手柄模式：" + (transformMode === "translate" ? "移动" : transformMode === "rotate" ? "旋转" : "缩放") + "。启用手势后由手势自动决定操作类型。", "info");
}));
document.querySelectorAll("[data-model-target]").forEach((button) => button.addEventListener("click", () => {
  setModelTargetScope(button.dataset.modelTarget);
    lastModelHandTip = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0; resetTwoHandControl();
  setStatus(modelTargetScope === "whole" ? "操作目标已切换为整体模型；单指移动、握拳旋转、捏合缩放。" : "操作目标已切换为选中部件；可用 V 字手势在模型上选中部件。", "info");
}));
$("modelSensitivity").addEventListener("input", (event) => { modelSensitivity = Number(event.target.value); $("modelSensitivityValue").textContent = `${modelSensitivity.toFixed(2)}×`; });
$("screenAxisToggle").addEventListener("click", (event) => {
  screenAxisVisible = !screenAxisVisible;
  event.currentTarget.classList.toggle("active", screenAxisVisible);
  event.currentTarget.setAttribute("aria-pressed", String(screenAxisVisible));
  if (!screenAxisVisible && screenAxisHelper) screenAxisHelper.visible = false;
  setStatus(screenAxisVisible ? "屏幕坐标轴已显示：蓝色 Z 轴垂直屏幕并朝向你。" : "屏幕坐标轴参考已隐藏。", "info");
});
$("modelSmoothing").addEventListener("input", (event) => { modelSmoothing = Number(event.target.value) / 100; $("modelSmoothingValue").textContent = `${event.target.value}%`; });
$("modelTwoHandMode").addEventListener("change", (event) => {
  modelTwoHandMode = event.target.checked;
  resetTwoHandControl();
  setStatus(modelTwoHandMode ? "双手高级模式已启用：两手同时捏合后可平移、缩放和滚转。" : "双手高级模式已关闭，使用单手 V 字选择、单指移动、握拳旋转和捏合缩放。", "info");
  updateModelGestureUI();
});
$("resetViewBtn").addEventListener("click", () => { fitModelScene(); setStatus("已重置模型视角与整体比例。", "info"); });
$("resetModelTargetBtn").addEventListener("click", resetModelTarget);
$("resetAllModelBtn").addEventListener("click", resetAllModelParts);
$("saveModelPoseBtn").addEventListener("click", saveModelPose);
$("restoreModelPoseBtn").addEventListener("click", restoreSavedModelPose);
$("framePartBtn").addEventListener("click", frameSelectedModel);
$("explodePartBtn").addEventListener("click", explodeSelectedModel);
$("removeAllPartsBtn").addEventListener("click", () => { modelParts.forEach(disposeModelPart); modelParts = []; selectedModelObject = null; showModelSelectionHelper(null); resetModelAssemblyTransform(); modelTransform?.detach(); $("modelViewerPlaceholder")?.classList.remove("hidden"); updateScenePartList(); updateSelectedPartLabel(); updateModelGestureUI(); setStatus("已移除场景中的全部部件。", "info"); });
$("modelHandControlBtn").addEventListener("click", () => { modelHandControl = !modelHandControl; lastModelHandTip = null; modelMoveAnchor = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0; modelSelectionCommitted = false; resetTwoHandControl(); $("modelHandControlBtn").setAttribute("aria-pressed", String(modelHandControl)); $("modelHandControlBtn").textContent = modelHandControl ? "✋ 关闭 3D 手势" : "✋ 启用 3D 手势"; $("modelHandCursor").classList.remove("visible"); updateTransformAttachment(); if (modelHandControl) { modelOrbit.enabled = false; setStatus("3D 手势已启用：" + (primaryHand === "Right" ? "右" : "左") + "手 V 字选件、单指移动、握拳旋转、捏合缩放、竖拇指切整体；张掌或放松停止。" + (modelTwoHandMode ? " 双手高级模式已开启。" : ""), "info"); } else { modelOrbit.enabled = true; setStatus("3D 手势已关闭，可使用鼠标和变换手柄操作。", "info"); } updateModelGestureUI(); });
$("drawToggleBtn").addEventListener("click", () => { drawEnabled = !drawEnabled; if (!drawEnabled) finishStroke(); $("drawToggleBtn").setAttribute("aria-pressed", String(drawEnabled)); $("drawToggleLabel").textContent = drawEnabled ? "绘画已启用" : "绘画已暂停"; setStatus(drawEnabled ? "绘画模式已启用。" : "绘画模式已暂停。", "info"); });
$("undoBtn").addEventListener("click", () => { finishStroke(); strokes.pop(); selectedStroke = null; redrawAll(); setStatus(strokes.length ? "已撤销上一笔。" : "没有可撤销的笔画。"); });
$("clearBtn").addEventListener("click", () => { finishStroke(); strokes = []; selectedStroke = null; redrawAll(); setStatus("画布已清空。", "info"); });
$("depthCalibrateBtn").addEventListener("click", calibrateDepth);
$("primaryHandSelect").addEventListener("change", (event) => {
  primaryHand = event.target.value;
  finishStroke();
  lastModelHandTip = null; modelMoveAnchor = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0;
  updateModelGestureUI();
  setStatus(`交互主手已切换为${primaryHand === "Right" ? "右手" : "左手"}；另一只手只显示骨架，不会绘画或控制模型。`, "info");
});
$("handLabelToggle").addEventListener("click", (event) => {
  swapHandLabels = !swapHandLabels;
  event.currentTarget.setAttribute("aria-pressed", String(swapHandLabels));
  event.currentTarget.textContent = `左右手标签：${swapHandLabels ? "已反转" : "正常"}`;
  finishStroke();
  lastModelHandTip = null; modelHandGesture = false; modelHandPose = "idle"; modelGestureCandidate = null; modelGestureCandidateFrames = 0; resetTwoHandControl();
  setStatus(swapHandLabels ? "左右手标签已反转，请按画面标签重新选择主手。" : "左右手标签已恢复正常。", "info");
});
$("brushSize").addEventListener("input", (event) => { brushSize = Number(event.target.value); $("sizeValue").textContent = `${brushSize} px`; });
document.querySelectorAll(".swatch").forEach((button) => button.addEventListener("click", () => { brushColor = button.dataset.color; $("colorPicker").value = brushColor; $("colorValue").textContent = brushColor; document.querySelectorAll(".swatch").forEach((item) => item.classList.toggle("active", item === button)); }));
$("colorPicker").addEventListener("input", (event) => { brushColor = event.target.value.toUpperCase(); $("colorValue").textContent = brushColor; document.querySelectorAll(".swatch").forEach((item) => item.classList.remove("active")); });
resizeObserver = new ResizeObserver(() => { resizeAll(); resizeModelViewer(); }); resizeObserver.observe($("videoWrap")); resizeObserver.observe($("drawingCanvas")); resizeObserver.observe($("stageHandCanvas")); resizeObserver.observe($("modelViewer")); window.addEventListener("resize", () => { resizeAll(); resizeModelViewer(); }); resizeAll();
updateSingleScreenOverlay();
updateGestureModeUI();
updateHyper3DInputMode();
refreshHyper3DConfig();
window.addEventListener("beforeunload", stopCamera);
