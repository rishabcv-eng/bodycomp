// Wires the camera, MediaPipe and the two model stages together.
// Everything runs in this tab. No video, photo or measurement leaves the device.

import { FilesetResolver, ImageSegmenter, PoseLandmarker } from "../vendor/vision_bundle.mjs";
import { buildMask, qualityCheck } from "./mask.js";
import { loadModels, analyse, analyseMany } from "./pipeline.js";
import { ScanController, STEPS, TOLERANCE, HOLD_MS, frameAssessment } from "./scan.js";
import { buildPlan } from "./plan.js";

const PERSON_CLASSES = [1, 2, 3, 4, 5]; // multiclass: 0 is background
const MAX_EDGE = 900;

const $ = id => document.getElementById(id);
const photos = { front: null, side: null };
let segmenter = null, previewSegmenter = null;
let poseImage = null, poseVideo = null, scan = null, ready = false;

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = "status" + (kind ? " " + kind : "");
}

async function init() {
  try {
    setStatus("Loading models (about 25 MB, cached after the first run)...", "working");
    const fileset = await FilesetResolver.forVisionTasks("vendor/wasm");
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "mp/selfie_multiclass.tflite" },
      runningMode: "IMAGE", outputCategoryMask: false, outputConfidenceMasks: true,
    });
    const poseOpts = mode => ({
      baseOptions: { modelAssetPath: "mp/pose_landmarker_lite.task" },
      runningMode: mode, numPoses: 1, minPoseDetectionConfidence: 0.5,
    });
    poseImage = await PoseLandmarker.createFromOptions(fileset, poseOpts("IMAGE"));
    poseVideo = await PoseLandmarker.createFromOptions(fileset, poseOpts("VIDEO"));
    // Small, fast model purely for the live outline. The 16 MB multiclass model
    // above stays reserved for the frames that actually get measured.
    try {
      previewSegmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "mp/selfie_segmenter.tflite" },
        runningMode: "VIDEO", outputCategoryMask: false, outputConfidenceMasks: true,
      });
    } catch (e) {
      console.warn("live outline unavailable:", e.message);   // scan still works
    }
    await loadModels("models");
    ready = true;
    setStatus("Ready. Fill in your details, then start the scan.", "ok");
    refreshUpload();
  } catch (err) {
    console.error(err);
    setStatus("Could not load the models: " + err.message, "bad");
  }
}

/* ---------------------------------------------------------------- shared --- */

function segmentCanvas(canvas) {
  const w = canvas.width, h = canvas.height;
  const res = segmenter.segment(canvas);
  const conf = new Float32Array(w * h);
  for (const cls of PERSON_CLASSES) {
    const m = res.confidenceMasks[cls];
    if (!m) continue;
    const arr = m.getAsFloat32Array();
    for (let i = 0; i < conf.length; i++) conf[i] += arr[i];
  }
  res.close();
  const mask = buildMask(conf, w, h);
  const landmarks = poseImage.detect(canvas).landmarks?.[0] ?? null;
  return { mask, width: w, height: h, qc: qualityCheck(mask, w, h, landmarks) };
}

function formValues() {
  return {
    heightCm: parseFloat($("height").value),
    weightKg: parseFloat($("weight").value),
    age: parseFloat($("age").value),
    sex: $("sex").value === "male" ? 1 : 0,
  };
}

const formComplete = () => {
  const v = formValues();
  return [v.heightCm, v.weightKg, v.age].every(n => Number.isFinite(n) && n > 0);
};

function showIssues(list) {
  const ul = $("issues");
  ul.innerHTML = "";
  for (const { where, text } of list) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="where">${where}</span>${text}`;
    ul.appendChild(li);
  }
  $("blocked").hidden = false;
  $("results").hidden = true;
}

function renderResults(out, qcs, profile = formValues()) {
  $("blocked").hidden = true;
  $("sample-banner").hidden = true;
  const bf = out.composition.bodyfat_pct, alm = out.composition.alm_kg;

  $("bf-value").textContent = bf.estimate.toFixed(1);
  $("bf-range").textContent = `80% confidence: ${bf.low.toFixed(1)} to ${bf.high.toFixed(1)}%`;
  $("alm-value").textContent = alm.estimate.toFixed(1);
  $("alm-range").textContent = `80% confidence: ${alm.low.toFixed(1)} to ${alm.high.toFixed(1)} kg`;

  $("d-fat").textContent = out.derived.fatMassKg.toFixed(1) + " kg";
  $("d-lean").textContent = out.derived.fatFreeMassKg.toFixed(1) + " kg";
  $("d-almi").textContent = out.derived.almi.toFixed(2);
  $("d-musclepct").textContent = out.derived.musclePctOfWeight.toFixed(1) + "%";

  const multi = out.frameCount > 1;
  $("spread-head").hidden = !multi;
  const tbody = $("measure-body");
  tbody.innerHTML = "";
  const LABEL = { waist: "Waist", hip: "Hip", chest: "Chest", thigh: "Thigh", bicep: "Upper arm" };
  for (const key of ["waist", "hip", "chest", "thigh", "bicep"]) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${LABEL[key]}</td><td>${out.measurements[key].toFixed(1)} cm</td>` +
      (multi ? `<td>&plusmn;${(out.frameSpread[key] / 2).toFixed(1)}</td>` : "");
    tbody.appendChild(tr);
  }

  $("qc-note").textContent = multi
    ? `Combined from ${out.frameCount} frame pairs by median, so one bad frame cannot drag the ` +
      `result. Frame spread is how much the measurement varied across those frames.`
    : `Capture checks passed. Arm clearance ${qcs[0].armClearance} / ${qcs[1].armClearance}, ` +
      `shoulder tilt ${qcs[0].shoulderTilt} / ${qcs[1].shoulderTilt}.`;
  $("accuracy-note").textContent =
    `Body fat is estimated to about ${bf.mae} percentage points of a clinical DXA scan. ` +
    `The stated range covers roughly ${bf.coverage80}% of people.`;

  lastScan = {
    bodyFatPct: bf.estimate,
    fatFreeMassKg: out.derived.fatFreeMassKg,
    weightKg: profile.weightKg,
    heightCm: profile.heightCm,
    age: profile.age,
    sex: profile.sex,
  };
  $("p-diet").value = $("p-diet").value || "veg";
  renderPlan();

  $("results").hidden = false;
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ----------------------------------------------------------- camera check --- */

const median = xs => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : "  --";

/** Five seconds of real measurement, reported as plain numbers. */
async function runCameraCheck() {
  const out = $("camreport");
  const btn = $("camcheck");
  btn.disabled = true;
  out.hidden = false;
  out.textContent = "Opening camera...";

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false });
  } catch (err) {
    out.textContent = "Camera did not open: " + err.name + "\n" + cameraFailureMessage(err);
    btn.disabled = false;
    return;
  }

  const v = $("video");
  $("stage-wrap").hidden = false;
  v.srcObject = stream;
  await v.play();

  const DURATION = 5000;
  const t0 = performance.now();
  let frames = 0, seen = 0, lastTs = -1;
  const m = { fill: [], minVisibility: [], clearance: [], tilt: [], spanRatio: [] };
  const failCounts = {};

  await new Promise(resolve => {
    const loop = () => {
      const now = performance.now();
      if (now - t0 >= DURATION) return resolve();
      requestAnimationFrame(loop);
      if (v.readyState < 2) return;
      let ts = now;
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      frames++;
      let lm = null;
      try { lm = poseVideo.detectForVideo(v, ts).landmarks?.[0] ?? null; } catch { return; }
      if (!lm) return;
      seen++;
      const a = frameAssessment(lm, v.videoWidth, v.videoHeight, { assumeFacing: true });
      for (const k of Object.keys(m)) if (Number.isFinite(a.metrics[k])) m[k].push(a.metrics[k]);
      for (const issue of a.issues) failCounts[issue] = (failCounts[issue] || 0) + 1;
      out.textContent = `measuring... ${Math.round((now - t0) / 100) / 10}s`;
      // keep the overlay alive so the user sees something happening
      const ctx = $("overlay").getContext("2d");
      $("overlay").width = v.videoWidth; $("overlay").height = v.videoHeight;
      ctx.clearRect(0, 0, v.videoWidth, v.videoHeight);
    };
    requestAnimationFrame(loop);
  });

  for (const tr of stream.getTracks()) tr.stop();
  v.srcObject = null;
  $("stage-wrap").hidden = true;

  const secs = (performance.now() - t0) / 1000;
  const fps = frames / secs;
  const worst = Object.entries(failCounts).sort((x, y) => y[1] - x[1])[0];

  const row = (label, value, need, ok) =>
    `  ${label.padEnd(16)}${f2(value).padStart(6)}   ${need.padEnd(12)}${ok ? "ok" : "FAILING"}`;

  const med = k => median(m[k]);
  const lines = [
    `camera check  ${secs.toFixed(1)}s`,
    ``,
    `  resolution      ${v.videoWidth || "?"} x ${v.videoHeight || "?"}`,
    `  frame rate      ${fps.toFixed(1)} fps` + (fps < 8 ? "   (slow)" : ""),
    `  person seen     ${seen}/${frames}` + (frames ? `  (${Math.round(100 * seen / frames)}%)` : ""),
    ``,
    row("body in frame", med("fill"), `need >=${TOLERANCE.fill}`, med("fill") >= TOLERANCE.fill),
    row("tracking", med("minVisibility"), `need >=${TOLERANCE.visibility}`, med("minVisibility") >= TOLERANCE.visibility),
    row("arms out", med("clearance"), `need >=${TOLERANCE.clearance}`, med("clearance") >= TOLERANCE.clearance),
    row("shoulders level", med("tilt"), `need <=${TOLERANCE.tilt}`, med("tilt") <= TOLERANCE.tilt),
    row("facing camera", med("spanRatio"), `need >=0.13`, med("spanRatio") >= 0.13),
    ``,
  ];

  if (!seen) {
    lines.push(`  verdict: no person detected at all. Check the lighting, and that`);
    lines.push(`           you are actually in the camera's view.`);
  } else if (worst) {
    lines.push(`  most common blocker (${worst[1]} of ${seen} frames):`);
    lines.push(`    ${worst[0]}`);
  } else {
    lines.push(`  verdict: all checks passing - the scan should lock on.`);
  }
  if (fps < 8 && seen) {
    lines.push(``);
    lines.push(`  note: ${fps.toFixed(1)} fps is slow, but holding is timed in seconds`);
    lines.push(`        rather than frames, so this no longer blocks the scan.`);
  }

  out.textContent = lines.join("\n");
  btn.disabled = false;
}

/* ------------------------------------------------------------------ plan --- */

let lastScan = null;   // the measurement the plan is built from

function renderPlan() {
  if (!lastScan) return;
  const plan = buildPlan(lastScan, {
    goal: $("p-goal").value,
    activity: $("p-activity").value,
    diet: $("p-diet").value,
  });

  $("p-kcal").textContent = plan.calories + " kcal";
  $("p-pro").textContent = plan.macros.proteinG + " g";
  $("p-carb").textContent = plan.macros.carbsG + " g";
  $("p-fat").textContent = plan.macros.fatG + " g";

  const sign = plan.bmrDelta >= 0 ? "+" : "";
  $("p-energy-note").textContent =
    `Resting metabolism ${plan.bmr} kcal, estimated from your ${lastScan.fatFreeMassKg} kg of lean `
    + `tissue. A weight-only formula would have said ${plan.bmrNaive} (${sign}${plan.bmrDelta}). `
    + `With ${plan.activity.toLowerCase()}, maintenance is about ${plan.tdee} kcal.`;

  const flags = $("p-flags");
  flags.innerHTML = "";
  for (const f of plan.flags) {
    const li = document.createElement("li");
    li.textContent = f;
    flags.appendChild(li);
  }
  flags.hidden = plan.flags.length === 0;

  const pr = plan.projection;
  $("p-now-bf").textContent = lastScan.bodyFatPct.toFixed(1) + "%";
  $("p-now-rest").textContent = `${lastScan.weightKg.toFixed(1)} kg, ${lastScan.fatFreeMassKg.toFixed(1)} kg lean`;
  $("p-then-bf").textContent = pr.bodyFatPct.toFixed(1) + "%";
  $("p-then-rest").textContent = `${pr.weightKg.toFixed(1)} kg, ${pr.fatFreeMassKg.toFixed(1)} kg lean`;
  $("p-proj-note").textContent =
    `Assumes you hit the calorie target most days: ${pr.fatChangeKg >= 0 ? "+" : ""}${pr.fatChangeKg} kg fat, `
    + `${pr.leanChangeKg >= 0 ? "+" : ""}${pr.leanChangeKg} kg lean over ${pr.weeks} weeks. `
    + `Real progress is rarely this straight, and lean-mass change in particular depends on training, `
    + `sleep and how long you have been lifting.`;

  const tb = $("p-train");
  tb.innerHTML = "";
  for (const d of plan.training.week) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.day}</td><td>${d.focus}</td><td>${d.detail}</td>`;
    tb.appendChild(tr);
  }
  $("p-train-note").textContent = plan.training.note;

  $("p-diet-label").textContent = plan.meals.label.toLowerCase();
  const mb = $("p-meals");
  mb.innerHTML = "";
  for (const m of plan.meals.meals) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${m.name}</td><td>${m.items}</td><td>${m.protein} g</td>`;
    mb.appendChild(tr);
  }
  const tot = document.createElement("tr");
  tot.innerHTML = `<td><b>Total</b></td><td>${plan.meals.tip}</td><td><b>${plan.meals.coveredProtein} g</b></td>`;
  mb.appendChild(tot);
  $("p-meal-note").textContent =
    plan.meals.gapAdvice + (plan.meals.b12 ? " " + plan.meals.b12 : "");
}

/* ------------------------------------------------------------------ mode --- */
function setMode(which) {
  const scanning = which === "scan";
  $("mode-scan").classList.toggle("on", scanning);
  $("mode-upload").classList.toggle("on", !scanning);
  $("mode-scan").setAttribute("aria-selected", String(scanning));
  $("mode-upload").setAttribute("aria-selected", String(!scanning));
  $("pane-scan").hidden = !scanning;
  $("pane-upload").hidden = scanning;
  if (!scanning && scan) { scan.stop(); resetScanButtons(); }
}

/* ------------------------------------------------------------------ scan --- */

function setGuide(text, kind = "", extraHtml = "") {
  const g = $("guide");
  g.hidden = !text;
  g.textContent = text || "";
  if (extraHtml) g.insertAdjacentHTML("beforeend", extraHtml);
  g.className = "guide" + (kind ? " " + kind : "");
}

/** Render the checklist of positions, marking what is banked. */
function renderSteps(activeIndex = -1, banked = { front: 0, side: 0 }) {
  const ol = $("steps");
  ol.innerHTML = "";
  STEPS.forEach((s, i) => {
    const li = document.createElement("li");
    const captured = i < activeIndex;
    li.className = i === activeIndex ? "active" : (captured ? "done" : "");
    li.innerHTML = `<span class="n">${captured ? "&check;" : i + 1}</span>` +
      `<span>${s.label}${s.optional ? " <em>(optional)</em>" : ""}</span>` +
      `<span class="tag">${captured ? "captured" : (i === activeIndex ? "now" : "")}</span>`;
    ol.appendChild(li);
  });
}

/**
 * Live numbers behind the guidance. Without this, "it does not see me" is
 * unactionable - for the user and for anyone debugging on a device they do not
 * have. Failing checks are marked.
 */
function renderDiag(m, held, fps) {
  const d = $("diag");
  if (!m || m.ratio === undefined) { d.hidden = true; return; }
  const cell = (label, value, ok) =>
    `${label} ${ok ? "" : "<b>"}${value}${ok ? "" : "</b>"}`;
  d.hidden = false;
  d.innerHTML = [
    cell("body-in-frame", m.fill, m.fill >= TOLERANCE.fill),
    cell("tracking", m.minVisibility, m.minVisibility >= TOLERANCE.visibility),
    cell("arms", m.clearance, m.clearance >= TOLERANCE.clearance),
    cell("shoulders-level", m.tilt, m.tilt <= TOLERANCE.tilt),
    `turn ${m.ratio}`,
    `hold ${Math.round((held / HOLD_MS) * 100)}%`,
    `${m.fps ?? "-"}fps`,
  ].join(" &nbsp;&middot;&nbsp; ");
}

function onScanState(state, payload) {
  if (state === "positioning" || state === "holding") {
    renderDiag({ ...payload.metrics, fps: payload.fps }, payload.held);
    renderSteps(payload.stepIndex, payload.banked);
    if (payload.stuck) showStuckHelp(payload.blocker);
    const holding = state === "holding";
    const bar = holding
      ? `<span class="holdbar"><span style="width:${Math.round(payload.progress * 100)}%"></span></span>`
      : "";
    setGuide(`${payload.step.label} - ${payload.message}`, holding ? "ok" : "warn", bar);
    $("scan-finish").hidden = !payload.canFinish;
  } else if (state === "confirmed") {
    $("diag").hidden = true;
    renderSteps(payload.stepIndex + 1, payload.banked);
    setGuide(payload.message + " \u2713", "ok");
    $("scan-finish").hidden = !payload.canFinish;
  } else if (state === "failed") {
    setGuide(payload.reason, "warn");
    resetScanButtons();
  } else if (state === "done") {
    renderSteps(STEPS.length, payload);
    setGuide("All positions captured - working out your measurements...", "ok");
    processScan(payload).catch(err => {
      console.error(err);
      setStatus("Something went wrong: " + err.message, "bad");
      resetScanButtons();
    });
  }
}

function resetScanButtons() {
  $("stuck").hidden = true;
  $("diag").hidden = true;
  $("camctl").hidden = true;
  $("camera-start").hidden = false;
  $("scan-finish").hidden = true;
  $("camera-stop").hidden = true;
  $("stage-wrap").hidden = true;
  $("steps").innerHTML = "";
}

/** Turn a getUserMedia failure into something the user can act on. */
function cameraFailureMessage(err) {
  const embedded = window.self !== window.top;
  switch (err.name) {
    case "NotAllowedError":
      return embedded
        ? "Camera access is blocked in this embedded preview. Open http://localhost:8742 "
          + "directly in Chrome, Edge or Safari to use the scan."
        : "Camera permission was denied. Allow camera access for this site in your browser's "
          + "address-bar icon, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is already in use by another app. Close it and try again.";
    case "NotSupportedError":
      return "This browser cannot open a camera here. Camera access needs HTTPS, or localhost.";
    default:
      return "Could not open the camera (" + err.name + ").";
  }
}

async function startCamera(streamFactory) {
  if (!ready) return;

  // Check up front rather than showing a dead video box and waiting for a
  // rejection the user cannot interpret.
  if (!streamFactory) {
    if (!window.isSecureContext) {
      failToUpload("Cameras only work over HTTPS or on localhost. This page is on "
        + location.origin + ", so use Upload photos instead.");
      return;
    }
    try {
      const st = await navigator.permissions.query({ name: "camera" });
      if (st.state === "denied") {
        failToUpload(cameraFailureMessage({ name: "NotAllowedError" }));
        return;
      }
    } catch { /* Firefox and Safari do not expose this - fall through and just try */ }
  }

  $("blocked").hidden = true;
  $("results").hidden = true;
  $("stage-wrap").hidden = false;
  $("camera-start").hidden = true;
  $("camera-stop").hidden = false;
  setGuide("Starting camera...", "");

  scan = new ScanController({
    video: $("video"), overlay: $("overlay"), pose: poseVideo,
    previewSegmenter, maxEdge: MAX_EDGE, onState: onScanState,
  });
  try {
    await scan.start(streamFactory);
    await setupCameraControls();
  } catch (err) {
    console.error(err);
    failToUpload(cameraFailureMessage(err));
  }
}

/**
 * Expose whatever framing control the hardware actually has. Zoom narrows the
 * view, so the lens picker matters more: on a phone the ultra-wide is a separate
 * device, and that is what lets someone stand close instead of across the room.
 */
async function setupCameraControls() {
  const range = scan.zoomRange;
  const zoomRow = $("zoomrow"), lensRow = $("lensrow");

  if (range) {
    const z = $("zoom");
    z.min = range.min; z.max = range.max; z.step = range.step; z.value = range.value;
    $("zoomval").textContent = Number(range.value).toFixed(1) + "\u00d7";
    zoomRow.hidden = false;
  } else {
    zoomRow.hidden = true;
  }

  const cams = await scan.cameras();
  if (cams.length > 1) {
    const sel = $("lens");
    sel.innerHTML = "";
    for (const c of cams) {
      const o = document.createElement("option");
      o.value = c.deviceId;
      o.textContent = c.label;
      sel.appendChild(o);
    }
    const activeId = scan.track?.getSettings?.().deviceId;
    if (activeId) sel.value = activeId;
    lensRow.hidden = false;
  } else {
    lensRow.hidden = true;
  }

  $("camctl").hidden = zoomRow.hidden && lensRow.hidden;
  $("camctl-hint").hidden = lensRow.hidden;
}

/**
 * If someone has been fighting the same check for a while, stop repeating the
 * instruction and offer the route that works. A laptop webcam on a desk often
 * cannot see feet at all, and no amount of guidance fixes that.
 */
function showStuckHelp(blocker) {
  const box = $("stuck");
  if (!box.hidden) return;
  box.hidden = false;
  box.innerHTML =
    `<b>Still stuck?</b> The check holding you up is: <span class="mono">${blocker}</span>. ` +
    `A laptop webcam usually cannot fit a whole body from desk distance &mdash; prop a phone ` +
    `further back, or <button class="linkish" id="stuck-upload">use Upload photos</button> ` +
    `instead. You can also <button class="linkish" id="stuck-sample">run the sample body</button> ` +
    `to see the full result and plan.`;
  $("stuck-upload").addEventListener("click", () => { scan?.stop(); resetScanButtons(); setMode("upload"); });
  $("stuck-sample").addEventListener("click", () => { scan?.stop(); resetScanButtons(); runSample(); });
}

/** Explain why the camera is unavailable and move the user to the path that works. */
function failToUpload(message) {
  resetScanButtons();
  setGuide(message + " Switched you to Upload photos.", "warn");
  setStatus("Camera unavailable - use Upload photos, or try the sample.", "bad");
  setMode("upload");
  $("upload-note").hidden = false;
  $("upload-note").textContent = message;
}

/** Segment the chosen frames, gate on quality, then combine by median. */
async function processScan({ front, side }) {
  setStatus("Reading your outline...", "working");
  await new Promise(r => setTimeout(r, 30));

  const n = Math.min(front.length, side.length);   // pair them off
  const pairs = [];
  const rejected = [];
  for (let i = 0; i < n; i++) {
    const f = segmentCanvas(front[i].canvas);
    const s = segmentCanvas(side[i].canvas);
    // Side views legitimately fail the arm and shoulder checks, so for the side
    // frame only the segmentation-coverage failures matter.
    const sideBlocking = s.qc.issues.filter(t => t.includes("outline is missing"));
    if (f.qc.usable && sideBlocking.length === 0) pairs.push({ front: f, side: s });
    else rejected.push(...f.qc.issues, ...sideBlocking);
  }

  if (!pairs.length) {
    const seen = [...new Set(rejected)];
    showIssues(seen.map(text => ({ where: "scan", text })));
    setStatus("That scan is not usable yet - see below.", "bad");
    resetScanButtons();
    return;
  }

  const out = analyseMany(pairs, formValues());
  renderResults(out, [pairs[0].front.qc.metrics, pairs[0].side.qc.metrics]);
  setStatus(`Done, from ${out.frameCount} frame pairs. Nothing left this device.`, "ok");
  resetScanButtons();
}

/* ---------------------------------------------------------------- upload --- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not read that image"));
    img.src = URL.createObjectURL(file);
  });
}

function toCanvas(img) {
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function drawPreview(slot, canvas, mask) {
  const t = $(`preview-${slot}`);
  t.width = canvas.width; t.height = canvas.height;
  const ctx = t.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  if (mask) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (!mask[i]) continue;
      d[p] = d[p] * .35 + 255 * .65;
      d[p + 1] = d[p + 1] * .35 + 154 * .65;
      d[p + 2] = d[p + 2] * .35 + 68 * .65;
    }
    ctx.putImageData(img, 0, 0);
  }
  t.classList.add("shown");
}

async function handleFile(slot, file) {
  if (!file) return;
  photos[slot] = toCanvas(await loadImage(file));
  $(`drop-${slot}`).classList.add("filled");
  $(`label-${slot}`).textContent = file.name.length > 24 ? file.name.slice(0, 22) + "..." : file.name;
  drawPreview(slot, photos[slot], null);
  $("results").hidden = true;
  refreshUpload();
}

const refreshUpload = () => {
  $("run").disabled = !(ready && photos.front && photos.side && formComplete());
};

async function runUpload() {
  $("run").disabled = true;
  setStatus("Finding your outline...", "working");
  try {
    await new Promise(r => setTimeout(r, 30));
    const front = segmentCanvas(photos.front);
    drawPreview("front", photos.front, front.mask);
    const side = segmentCanvas(photos.side);
    drawPreview("side", photos.side, side.mask);

    if (!front.qc.usable || !side.qc.usable) {
      showIssues([
        ...front.qc.issues.map(text => ({ where: "front", text })),
        ...side.qc.issues.map(text => ({ where: "side", text })),
      ]);
      setStatus("Those photos are not usable yet - see below.", "bad");
      return;
    }
    renderResults(analyse(front, side, formValues()), [front.qc.metrics, side.qc.metrics]);
    setStatus("Done. Nothing left this device.", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong: " + err.message, "bad");
  } finally {
    refreshUpload();
  }
}

/* ---------------------------------------------------------------- sample --- */

/**
 * Run a real BodyM subject through the pipeline. Uses the dataset's own
 * ground-truth silhouettes, so it demonstrates the full result flow and can
 * show the answer next to the true tape measurements - no camera required.
 */
async function runSample() {
  $("sample").disabled = true;
  setStatus("Running the sample body...", "working");
  try {
    const meta = await (await fetch("test/expected.json")).json();
    const maskOf = async url => {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const mask = new Uint8Array(c.width * c.height);
      for (let i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = d[p] > 127 ? 1 : 0;
      return { mask, width: c.width, height: c.height };
    };
    const front = await maskOf("test/front.png");
    const side = await maskOf("test/side.png");

    // show the sample's own profile in the form, so the numbers line up
    $("height").value = meta.height_cm;
    $("weight").value = meta.weight_kg;
    $("age").value = meta.age;
    $("sex").value = meta.sex === 1 ? "male" : "female";

    const out = analyse(front, side, {
      heightCm: meta.height_cm, weightKg: meta.weight_kg, age: meta.age, sex: meta.sex,
    });
    $("blocked").hidden = true;
    renderResults(out, [{}, {}]);

    const truth = meta.ground_truth;
    const errs = Object.entries(truth)
      .map(([k, v]) => `${k} ${(out.measurements[k] - v >= 0 ? "+" : "")}${(out.measurements[k] - v).toFixed(1)}`)
      .join(", ");
    $("sample-banner").hidden = false;
    $("sample-banner").innerHTML =
      `<b>Sample body, not you.</b> A real subject from the BodyM dataset &mdash; ` +
      `${meta.height_cm} cm, ${meta.weight_kg} kg. Their true tape measurements are known, so ` +
      `the error is measurable here: <span class="mono">${errs}</span> cm.`;
    $("qc-note").textContent =
      "Capture checks are skipped for the sample - these are the dataset's own silhouettes, " +
      "not a camera capture.";
    setStatus("Sample complete. Turn on the camera to measure yourself.", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Could not run the sample: " + err.message, "bad");
  } finally {
    $("sample").disabled = false;
  }
}

/* ------------------------------------------------------------------ wire --- */

$("mode-scan").addEventListener("click", () => setMode("scan"));
$("mode-upload").addEventListener("click", () => setMode("upload"));
$("camera-start").addEventListener("click", () => startCamera());
$("camera-stop").addEventListener("click", () => { scan?.stop(); resetScanButtons(); setGuide(""); });
$("scan-finish").addEventListener("click", () => scan?.finishEarly());
$("zoom").addEventListener("input", async e => {
  const v = Number(e.target.value);
  $("zoomval").textContent = v.toFixed(1) + "\u00d7";
  if (!(await scan?.setZoom(v))) $("zoomval").textContent = "n/a";
});
$("lens").addEventListener("change", async e => {
  try {
    await scan.useCamera(e.target.value);
    await setupCameraControls();
  } catch (err) {
    setGuide("Could not switch camera: " + err.message, "warn");
  }
});
$("again").addEventListener("click", () => {
  $("results").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
});
for (const slot of ["front", "side"]) {
  $(`file-${slot}`).addEventListener("change", e => handleFile(slot, e.target.files[0]));
}
for (const id of ["height", "weight", "age", "sex"]) {
  $(id).addEventListener("input", refreshUpload);
}
for (const id of ["p-goal", "p-activity", "p-diet"]) {
  $(id).addEventListener("change", renderPlan);
}
$("run").addEventListener("click", runUpload);
$("sample").addEventListener("click", runSample);
$("camcheck").addEventListener("click", () => runCameraCheck().catch(err => {
  $("camreport").hidden = false;
  $("camreport").textContent = "Camera check failed: " + err.message;
  $("camcheck").disabled = false;
}));

// exposed so the browser test harness can drive a scan from a synthetic stream
window.__bodycomp = {
  startCamera, formValues, segmentCanvas, STEPS,
  get scan() { return scan; },
  get ready() { return ready; },
};

init();
