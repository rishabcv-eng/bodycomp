// Live camera scan: guide the user into position, record a few seconds while
// they turn, then pick the best front and side frames automatically.
//
// Capture is a sequence of CONFIRMED positions rather than one blind sweep: the
// app states the position, waits until the pose actually matches, holds while it
// banks frames, then confirms before moving on. The user always knows what is in
// the bag.
//
// Why this beats two stills:
//   - people are bad at judging a 90 degree turn, so the app checks the turn
//     happened instead of trusting it
//   - bad frames are discarded during capture rather than rejected afterwards
//   - several good frames per position let segmentation noise average out
//
// It does not fix systematic bias. Averaging only removes the random component.

import { LM } from "./mask.js";
import { traceContour, smoothContour, sampleMesh, sampleChords, drawOverlay } from "./overlay.js";

export const KEEP_PER_VIEW = 3;   // best-N frames kept per captured position
export const HOLD_MS = 1200;      // wall-clock time in position before banking
export const HOLD_FRAMES = 18;    // retained for callers that report progress
export const CONFIRM_MS = 900;    // how long the captured confirmation stays up
const BAD_RESET_MS = 900;         // sustained time out of position before the hold restarts
const MAX_DT = 250;               // ignore gaps larger than this (tab was backgrounded)
const NO_POSE_GRACE = 6;          // dropped detections tolerated before giving up
const SMOOTH = 0.4;               // EMA weight on new landmark positions
const SIDE_DROP = 0.62;           // a side view sits below this fraction of the front span
const FRONT_SPAN_MIN = 0.13;      // shoulder span / body height, square to the camera
const SIDE_SPAN_MAX = 0.11;       // the same measure, in profile
const STUCK_MS = 14000;           // how long to struggle before offering a way out

/**
 * Gating tolerances, in one place because they decide whether the app ever
 * locks on. The first set was guessed against synthetic poses and proved too
 * strict on real people: a real capture jitters, and requiring every check to
 * pass simultaneously on a single frame meant it often passed on none.
 *
 * These are deliberately forgiving. Nothing here is the last line of defence -
 * the mask-coverage check at measurement time still rejects a bad capture, and
 * that one is based on geometry rather than landmark confidence.
 */
export const TOLERANCE = {
  visibility: 0.35,   // was 0.5 - MediaPipe lite reports low confidence often
  fill: 0.38,         // was 0.45 - body height as a fraction of the frame
  clearance: 0.45,    // was 0.55 - wrist distance from the hip, in shoulder widths
  tilt: 0.22,         // was 0.18 - shoulder level
  margin: 0.02,       // was 0.03 - how close to the frame edge is "clipped"
};
let previewGapMs = 110;           // adaptive: widens if segmentation is slow
const PREVIEW_MIN = 90, PREVIEW_MAX = 600;
const PREVIEW_W = 192;            // preview segmentation runs small and is upscaled

/**
 * Judge a single frame from pose landmarks alone. Pure, so it is unit-tested.
 * @returns {{usable, ratio, issues, metrics}}
 *   ratio = shoulder span / torso length, in pixels. High facing the camera,
 *   low in profile - this is what identifies the front and side frames.
 */
export function frameAssessment(lm, W, H, { assumeFacing = false } = {}) {
  const issues = [];
  if (!lm || lm.length < 33) return { usable: false, ratio: 0, issues: ["No person detected."], metrics: {} };

  const vis = i => lm[i]?.visibility ?? 0;
  const px = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });

  // Visibility alone is unreliable on the lite model, so a landmark counts as
  // present if it is either confident OR sitting inside the frame.
  const inFrame = i => lm[i].y > 0.01 && lm[i].y < 0.995 && lm[i].x > 0.005 && lm[i].x < 0.995;
  // 0.28 is the low end of ambiguous: MediaPipe reports >0.9 for a clearly
  // visible joint and <0.1 for one it believes is out of frame. Below this,
  // an in-frame position is extrapolation rather than observation.
  const present = i => vis(i) >= TOLERANCE.visibility || (vis(i) >= 0.28 && inFrame(i));

  const feetVisible = present(LM.lAnkle) || present(LM.rAnkle);
  const headVisible = present(LM.nose);
  if (!headVisible) issues.push("Move the camera back - your head is out of frame.");
  if (!feetVisible) issues.push("Move the camera back - your feet must be in frame.");

  // in-frame margins: normalised coords outside [0,1] mean the body is clipped
  const xs = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].map(i => lm[i].x);
  if (Math.min(...xs) < TOLERANCE.margin || Math.max(...xs) > 1 - TOLERANCE.margin) {
    issues.push("Centre yourself in the frame.");
  }

  const lSh = px(LM.lShoulder), rSh = px(LM.rShoulder);
  const lHip = px(LM.lHip), rHip = px(LM.rHip);
  const shoulderPx = Math.hypot(lSh.x - rSh.x, lSh.y - rSh.y);
  const midShY = (lSh.y + rSh.y) / 2, midHipY = (lHip.y + rHip.y) / 2;
  const torsoPx = Math.abs(midHipY - midShY) || 1e-6;
  const ratio = shoulderPx / torsoPx;

  // vertical extent: too small in frame means too far away
  const bodyPx = Math.abs(px(LM.lAnkle).y - px(LM.nose).y);
  const fill = bodyPx / H;

  // Shoulder span as a fraction of body height. About 0.20-0.26 square to the
  // camera and 0.05-0.10 in profile - a wide, stable gap that does not depend
  // on build or camera pitch the way shoulder-over-torso did.
  const spanRatio = bodyPx > 1 ? shoulderPx / bodyPx : 0;
  if (fill < TOLERANCE.fill && feetVisible && headVisible) {
    issues.push("Step closer, or bring the camera nearer - you are small in the frame.");
  }

  const shoulderSpanX = Math.abs(lSh.x - rSh.x) || 1e-6;
  const tilt = Math.abs(lSh.y - rSh.y) / shoulderSpanX;
  const hipX = (lHip.x + rHip.x) / 2;
  const clearance = Math.min(Math.abs(px(LM.lWrist).x - hipX), Math.abs(px(LM.rWrist).x - hipX)) / shoulderSpanX;

  // Arm and tilt checks only apply facing the camera. In profile the shoulders
  // overlap, so both measures stop meaning anything.
  // Shoulder-span / torso-length runs about 0.75-0.9 square to the camera and
  // 0.1-0.3 in profile, so 0.5 sits in the gap rather than on either cluster.
  //
  // assumeFacing is set during alignment, where the user is square to the
  // camera by definition. Without it a low ratio - a narrow build, or arms held
  // in front - silently skips the arm check and the app reports "good position"
  // for a pose it should have rejected.
  const facing = assumeFacing || ratio > 0.5;
  if (facing && clearance < TOLERANCE.clearance) issues.push("Hold your arms out, about 30 degrees.");
  if (facing && tilt > TOLERANCE.tilt) issues.push("Level your shoulders and face the camera square on.");

  const metrics = {
    ratio: +ratio.toFixed(3), spanRatio: +spanRatio.toFixed(3), fill: +fill.toFixed(3),
    tilt: +tilt.toFixed(3), clearance: +clearance.toFixed(3),
    minVisibility: +Math.min(vis(LM.nose), vis(LM.lAnkle), vis(LM.rAnkle),
                             vis(LM.lShoulder), vis(LM.rShoulder)).toFixed(2),
  };
  return { usable: issues.length === 0, ratio, spanRatio, issues, metrics };
}

/** Score a frame as a front candidate (facing) or a side candidate (profile). */
export function viewScores(a) {
  if (!a.usable) return { front: -Infinity, side: -Infinity };
  // Front wants the widest shoulders, level and square. Side wants the narrowest.
  return {
    front: a.ratio - 2 * a.metrics.tilt,
    side: -a.ratio + 0.5 * a.metrics.minVisibility,
  };
}

/** Keeps the best-N frames for one position. */
class BestFrames {
  constructor(n) { this.n = n; this.items = []; }
  offer(score, makeCanvas, metrics) {
    if (this.items.length >= this.n && score <= this.items[this.items.length - 1].score) return;
    this.items.push({ score, canvas: makeCanvas(), metrics });
    this.items.sort((a, b) => b.score - a.score);
    this.items.length = Math.min(this.items.length, this.n);
  }
  get frames() { return this.items; }
}

/**
 * The positions the user is walked through.
 *
 * Only front and side silhouettes feed the models, so there is no back step:
 * shoulder span cannot tell front from back, and the models were never trained
 * on back silhouettes. The second side is optional and simply buys another
 * independent sample of a view the model does understand.
 */
export const STEPS = [
  {
    id: "front", label: "Face the camera",
    detail: "Stand square on, arms out about 30 degrees from your body.",
    assumeFacing: true,
    // Gated on shoulder span over body height, which separates front from
    // profile by a wide margin on every build. The old gate used shoulder over
    // torso length, whose absolute value varies enough between people and
    // camera angles that a genuinely square stance could fall under it.
    matches: a => a.spanRatio > FRONT_SPAN_MIN,
    wrong: "Turn to face the camera square on.",
    view: "front",
  },
  {
    id: "side", label: "Turn 90 degrees to your right",
    detail: "One shoulder to the camera, arms relaxed at your sides.",
    assumeFacing: false,
    // Relative to this person's own front ratio, so build and camera angle
    // cancel out. The fallback only applies if the front step was skipped.
    matches: (a, ctx) => a.spanRatio < (ctx.frontSpan ? ctx.frontSpan * SIDE_DROP : SIDE_SPAN_MAX),
    wrong: "Keep turning until one shoulder faces the camera.",
    view: "side",
  },
  {
    id: "side2", label: "Turn to your other side",
    detail: "The other shoulder to the camera. Optional, but it improves the estimate.",
    assumeFacing: false,
    matches: (a, ctx) => a.spanRatio < (ctx.frontSpan ? ctx.frontSpan * SIDE_DROP : SIDE_SPAN_MAX),
    wrong: "Keep turning until your other shoulder faces the camera.",
    view: "side",
    optional: true,
  },
];

export class ScanController {
  /**
   * @param pose     MediaPipe PoseLandmarker in VIDEO running mode
   * @param onState  (state, payload) => void
   */
  constructor({ video, overlay, pose, previewSegmenter = null, maxEdge = 900, onState = () => {} }) {
    this.video = video;
    this.overlay = overlay;
    this.pose = pose;
    this.previewSegmenter = previewSegmenter;   // optional: silhouette for the overlay
    this._contour = null;
    this._mesh = null;
    this._chords = null;
    this._previewAt = 0;
    this._previewSize = [0, 0];
    this._small = null;
    this.maxEdge = maxEdge;
    this.onState = onState;
    this.state = "idle";
    this.stream = null;
    this._raf = null;
    this._lastTs = -1;
    this.stepIndex = 0;
    this.captured = { front: [], side: [] };
    this._hold = 0;          // accumulated milliseconds in position
    this._bad = 0;           // accumulated milliseconds out of position
    this._noPose = 0;
    this._lastTick = 0;
    this._fps = 0;
    // injectable so tests can advance time without waiting for it
    this.clock = () => performance.now();
    this._lmEma = null;
    this.frontRatio = null;       // this person's own square-on reference
    this.frontSpan = null;
    this._stuckSince = 0;
    this._confirmUntil = 0;
    this._best = new BestFrames(KEEP_PER_VIEW);
  }

  /**
   * Exponential smoothing of landmark positions. Raw pose output jitters frame
   * to frame, and every downstream measure - the shoulder ratio, the tilt, the
   * arm clearance - inherits that jitter. Smoothing here fixes all of them at
   * once, and steadies the overlay too.
   */
  _smooth(lm) {
    if (!lm) return null;
    if (!this._lmEma || this._lmEma.length !== lm.length) {
      this._lmEma = lm.map(p => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility }));
      return this._lmEma;
    }
    for (let i = 0; i < lm.length; i++) {
      const e = this._lmEma[i], n = lm[i];
      e.x += SMOOTH * (n.x - e.x);
      e.y += SMOOTH * (n.y - e.y);
      e.z += SMOOTH * ((n.z ?? 0) - e.z);
      e.visibility += SMOOTH * ((n.visibility ?? 0) - e.visibility);
    }
    return this._lmEma;
  }

  /** streamFactory is injectable so tests can drive this without a camera. */
  async start(streamFactory) {
    const getStream = streamFactory || (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error("no camera API"), { name: "NotSupportedError" });
      }
      // Prefer the rear camera on a phone; a laptop only has a front one, so
      // fall back rather than failing on a constraint the device cannot meet.
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1920 } },
          audio: false,
        });
      } catch (err) {
        if (err.name === "NotAllowedError" || err.name === "NotReadableError") throw err;
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    });
    this.stream = await getStream();
    await this._attach(this.stream);
    this.stepIndex = 0;
    this.captured = { front: [], side: [] };
    this._best = new BestFrames(KEEP_PER_VIEW);
    this._hold = 0;
    this._bad = 0;
    this._lastTick = 0;
    this.frontRatio = null;
    this.frontSpan = null;
    this._stuckSince = this.clock();
    this._emit("positioning", this.step.detail);
    this._loop();
  }

  async _attach(stream) {
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.video.srcObject = stream;
    await this.video.play();
  }

  /**
   * Zoom range the hardware actually reports, or null if it exposes none.
   *
   * Note the direction: zooming IN narrows the field of view, so it does not
   * help you stand closer. Standing closer needs a WIDER lens, which is why
   * `cameras()` exists - on a phone the ultra-wide is a separate device, not a
   * zoom value. Some devices do report a minimum below 1, and that does widen.
   *
   * Zoom cannot corrupt a measurement: scale comes from the silhouette's pixel
   * height against the stated body height, recomputed every frame, so any
   * magnification cancels out.
   */
  get zoomRange() {
    const c = this.track?.getCapabilities?.();
    if (!c || !c.zoom) return null;
    const { min = 1, max = 1, step = 0.1 } = c.zoom;
    if (!(max > min)) return null;
    return { min, max, step: step || 0.1, value: this.track.getSettings?.().zoom ?? min };
  }

  async setZoom(value) {
    if (!this.track?.applyConstraints) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: value }] });
      return true;
    } catch {
      return false;
    }
  }

  /** Video inputs, so a phone's ultra-wide lens can be chosen explicitly. */
  async cameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === "videoinput")
                .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      return [];
    }
  }

  /** Swap lens without losing progress: banked positions are kept. */
  async useCamera(deviceId) {
    const next = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 1920 } },
      audio: false,
    });
    if (this.stream) for (const tr of this.stream.getTracks()) tr.stop();
    await this._attach(next);
    this._hold = 0;
    this._contour = null;
  }

  get step() { return STEPS[this.stepIndex]; }
  get canFinish() { return this.captured.front.length > 0 && this.captured.side.length > 0; }

  /** Skip the optional last position and finish with what has been banked. */
  finishEarly() {
    if (this.canFinish) this._done();
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.state !== "done") this._setState("idle");
  }

  _setState(state, payload = {}) {
    this.state = state;
    this.onState(state, payload);
  }

  _emit(state, message, extra = {}) {
    this._setState(state, {
      step: this.step, stepIndex: this.stepIndex, total: STEPS.length,
      optional: !!this.step.optional, canFinish: this.canFinish,
      message, held: Math.round(this._hold), needed: HOLD_MS,
      progress: Math.min(1, this._hold / HOLD_MS),
      fps: Math.round(this._fps),
      banked: { front: this.captured.front.length, side: this.captured.side.length },
      ...extra,
    });
  }

  _snapshot() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const scale = Math.min(1, this.maxEdge / Math.max(vw, vh));
    const c = document.createElement("canvas");
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    c.getContext("2d", { willReadFrequently: true }).drawImage(this.video, 0, 0, c.width, c.height);
    return c;
  }

  /**
   * Refresh the traced silhouette. Throttled and run at low resolution: this is
   * decoration, and it must never compete with the pose checks for frame time.
   * Uses the small general segmenter, not the multiclass model used for the
   * actual measurement - preview fidelity does not need to match.
   */
  _updateContour() {
    if (!this.previewSegmenter) return;
    const now = this.clock();
    if (now - this._previewAt < previewGapMs) return;
    this._previewAt = now;
    const started = now;

    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const w = PREVIEW_W, h = Math.max(1, Math.round(vh * (PREVIEW_W / vw)));
    if (!this._small || this._small.width !== w || this._small.height !== h) {
      this._small = document.createElement("canvas");
      this._small.width = w; this._small.height = h;
    }
    this._small.getContext("2d", { willReadFrequently: true })
        .drawImage(this.video, 0, 0, w, h);

    let res;
    try {
      res = this.previewSegmenter.segmentForVideo(this._small, this._previewAt);
    } catch {
      this.previewSegmenter = null;      // one failure is enough; fall back to no contour
      return;
    }
    const conf = res.confidenceMasks?.[0];
    if (!conf) { res.close?.(); return; }
    const arr = conf.getAsFloat32Array();
    // the general segmenter returns background confidence in channel 0
    const mask = new Uint8Array(w * h);
    let fg = 0;
    for (let i = 0; i < mask.length; i++) { mask[i] = arr[i] < 0.5 ? 1 : 0; fg += mask[i]; }
    res.close?.();
    if (fg < 40 || fg > mask.length * 0.92) {
      this._contour = this._mesh = this._chords = null;
      return;
    }

    this._contour = smoothContour(traceContour(mask, w, h));
    this._mesh = sampleMesh(mask, w, h, 10);      // sparse: texture, not structure
    this._chords = sampleChords(mask, w, h, 16);
    this._previewSize = [w, h];

    // The overlay is decoration; the pose checks are the product. If a preview
    // pass is expensive, run it less often rather than starving detection.
    const cost = this.clock() - started;
    if (cost > 45) previewGapMs = Math.min(PREVIEW_MAX, previewGapMs * 1.5);
    else if (cost < 20) previewGapMs = Math.max(PREVIEW_MIN, previewGapMs * 0.9);
  }

  _drawOverlay(ok, holdProgress, confirmed) {
    const c = this.overlay;
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    drawOverlay(c.getContext("2d"), {
      width: w, height: h,
      contour: this._contour, mesh: this._mesh, chords: this._chords,
      maskWidth: this._previewSize[0], maskHeight: this._previewSize[1],
      state: ok ? "ok" : "adjust",
      holdProgress, confirmed,
    });
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    this.tick();
  }

  /**
   * Process exactly one frame. The rAF loop just calls this; keeping it separate
   * means the controller can be driven step by step from a test harness, where
   * requestAnimationFrame is throttled or paused (hidden tab, background window).
   */
  tick() {
    if (this.state === "done" || this.state === "idle" || this.state === "failed") return;
    if (this.video.readyState < 2) return;

    const nowMs = this.clock();
    const dt = this._lastTick ? Math.min(MAX_DT, nowMs - this._lastTick) : 0;
    this._lastTick = nowMs;
    if (dt > 0) this._fps = this._fps ? this._fps * 0.85 + (1000 / dt) * 0.15 : 1000 / dt;

    // hold the confirmation on screen long enough to read before advancing
    if (this.state === "confirmed") {
      this._drawOverlay(true, 1, true);
      if (this.clock() >= this._confirmUntil) this._advance();
      return;
    }

    let ts = nowMs;
    if (ts <= this._lastTs) ts = this._lastTs + 1;   // detectForVideo needs it strictly increasing
    this._lastTs = ts;

    let result;
    try {
      result = this.pose.detectForVideo(this.video, ts);
    } catch {
      return;
    }
    const raw = result.landmarks?.[0] ?? null;
    if (!raw) {
      // MediaPipe drops a detection now and then. Losing one frame should not
      // undo a second of correct positioning.
      this._noPose++;
      if (this._noPose <= NO_POSE_GRACE) return;
    } else {
      this._noPose = 0;
    }
    const lm = this._smooth(raw);
    const step = this.step;
    const a = frameAssessment(lm, this.video.videoWidth, this.video.videoHeight,
                              { assumeFacing: step.assumeFacing });
    const orientationOk = a.usable && step.matches(a, this);
    this._updateContour();
    this._drawOverlay(orientationOk, Math.min(1, this._hold / HOLD_MS), false);

    if (!orientationOk) {
      // Decay rather than reset: a person holding still still produces the odd
      // bad frame, and zeroing on each one means the hold never completes.
      this._bad += dt;
      // decay at the same rate it accrues: you must be in position more than out
      this._hold = this._bad > BAD_RESET_MS ? 0 : Math.max(0, this._hold - dt);
      this._emit("positioning",
                 a.usable ? step.wrong : (a.issues[0] || "Finding you..."),
                 {
                   metrics: a.metrics, issues: a.issues,
                   stuck: this.clock() - this._stuckSince > STUCK_MS,
                   blocker: a.issues[0] || step.wrong,
                 });
      return;
    }

    this._bad = 0;
    this._hold += dt;
    // prefer the squarest, most confidently tracked frames of this hold
    this._best.offer(a.metrics.minVisibility - Math.abs(a.metrics.tilt),
                     () => this._snapshot(), a.metrics);

    if (this._hold < HOLD_MS) {
      this._emit("holding", "Hold still...", { metrics: a.metrics, issues: [] });
      return;
    }

    const banked = this._best.frames;
    if (step.view === "front" && banked.length) {
      // median of the banked frames, so one odd frame cannot set the reference
      const rs = banked.map(f => f.metrics.ratio).sort((x, y) => x - y);
      this.frontRatio = rs[rs.length >> 1];
      const ss = banked.map(f => f.metrics.spanRatio).sort((x, y) => x - y);
      this.frontSpan = ss[ss.length >> 1];
    }
    this.captured[step.view].push(...banked);
    this._best = new BestFrames(KEEP_PER_VIEW);
    this._hold = 0;
    this._bad = 0;
    this._confirmUntil = this.clock() + CONFIRM_MS;
    this._emit("confirmed", step.label + " captured");
  }

  _advance() {
    if (this.stepIndex >= STEPS.length - 1) { this._done(); return; }
    this.stepIndex++;
    this._hold = 0;
    this._bad = 0;
    this._lastTick = 0;
    this._stuckSince = this.clock();
    this._lmEma = null;          // the body is about to turn; do not smooth across it
    this._emit("positioning", this.step.detail);
  }

  _done() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    const { front, side } = this.captured;
    if (!front.length || !side.length) {
      this._setState("failed", { reason: "The scan ended before both positions were captured." });
      return;
    }
    // front and side must be genuinely different views, or the turn never
    // happened. Expressed as a fraction of this person's own front ratio.
    const fr = this.frontSpan || front[0].metrics.spanRatio;
    const spread = (fr - side[0].metrics.spanRatio) / (fr || 1);
    if (spread < 0.30) {
      this._setState("failed", {
        reason: "Front and side look like the same view - make sure you turn a full quarter circle.",
        spread,
      });
      return;
    }
    this._setState("done", { front, side, spread });
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }
}
