// Mask post-processing and capture quality control.
// Ports src/segment.py. The conservative alpha cut and the decision to gate on
// pose rather than mask quality both come from reports/mask_robustness.csv:
// over-segmentation cost up to +0.70 cm of waist error while equivalent
// under-segmentation cost nothing, and mask IoU did not predict downstream error.

export const ALPHA_CUT = 0.62; // deliberately above 0.5: bias toward cutting in

// MediaPipe pose landmark indices
export const LM = {
  nose: 0, lShoulder: 11, rShoulder: 12, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lAnkle: 27, rAnkle: 28,
};

/** 3x3 morphological opening: erode then dilate, to drop speckle. */
export function open3(mask, w, h) {
  const er = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (!mask[(y + dy) * w + (x + dx)]) { all = 0; break; }
      er[y * w + x] = all;
    }
  }
  const di = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (er[(y + dy) * w + (x + dx)]) { any = 1; break; }
      di[y * w + x] = any;
    }
  }
  return di;
}

/** Keep only the biggest blob - drops mirrors, furniture, a second person. */
export function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = -1, bestSize = 0, current = 0;

  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    let sp = 0, size = 0;
    stack[sp++] = i;
    label[i] = current;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const px = p % w, py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && label[n] < 0) { label[n] = current; stack[sp++] = n; }
        }
      }
    }
    if (size > bestSize) { bestSize = size; best = current; }
    current++;
  }
  const out = new Uint8Array(w * h);
  if (best < 0) return out;
  for (let i = 0; i < w * h; i++) if (label[i] === best) out[i] = 1;
  return out;
}

/** Confidence mask -> clean binary silhouette. */
export function buildMask(confidence, w, h, cut = ALPHA_CUT) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = confidence[i] >= cut ? 1 : 0;
  return largestComponent(open3(bin, w, h), w, h);
}

export function maskBounds(mask, w, h) {
  let top = -1, bot = -1, left = w, right = -1, area = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[off + x]) continue;
      area++;
      if (top < 0) top = y;
      bot = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return { top, bot, left, right, area, empty: top < 0 };
}

/**
 * Capture quality control. Returns { usable, issues[], metrics }.
 * Refusing to return a number is the point: a silent failure hands the user a
 * confidently wrong body fat reading.
 */
export function qualityCheck(mask, w, h, landmarks) {
  const issues = [];
  const b = maskBounds(mask, w, h);
  const metrics = { coveragePct: +(100 * b.area / (w * h)).toFixed(1) };

  if (b.empty) {
    return { usable: false, issues: ["No person found in this photo."], metrics };
  }
  if (metrics.coveragePct < 4) issues.push("You are too small in the frame - move closer or crop tighter.");
  if (metrics.coveragePct > 60) issues.push("You fill the frame - step back so your whole body fits.");
  if (b.top <= 1 || b.bot >= h - 2) issues.push("Your body is cut off at the top or bottom of the photo.");
  if (b.left <= 1 || b.right >= w - 2) issues.push("Your body is cut off at the left or right edge.");

  if (!landmarks || landmarks.length === 0) {
    issues.push("Could not detect a person - check the lighting and that your whole body is visible.");
    metrics.poseDetected = false;
    return { usable: false, issues, metrics };
  }
  metrics.poseDetected = true;
  const lm = landmarks;
  const vis = i => (lm[i]?.visibility ?? 0);

  metrics.minVisibility = +Math.min(
    vis(LM.nose), vis(LM.lShoulder), vis(LM.rShoulder), vis(LM.lHip),
    vis(LM.rHip), vis(LM.lWrist), vis(LM.rWrist), vis(LM.lAnkle), vis(LM.rAnkle)
  ).toFixed(2);

  if (Math.min(vis(LM.lAnkle), vis(LM.rAnkle)) < 0.5)
    issues.push("Your feet are not visible - your whole body must be in frame so height can set the scale.");
  if (vis(LM.nose) < 0.5) issues.push("Your head is not clearly visible.");

  const shoulderW = Math.abs(lm[LM.lShoulder].x - lm[LM.rShoulder].x) || 1e-6;
  const hipX = (lm[LM.lHip].x + lm[LM.rHip].x) / 2;
  const clearance = Math.min(Math.abs(lm[LM.lWrist].x - hipX), Math.abs(lm[LM.rWrist].x - hipX)) / shoulderW;
  metrics.armClearance = +clearance.toFixed(2);
  if (clearance < 0.55) issues.push("Hold your arms out about 30 degrees from your body.");

  const tilt = Math.abs(lm[LM.lShoulder].y - lm[LM.rShoulder].y) / shoulderW;
  metrics.shoulderTilt = +tilt.toFixed(2);
  if (tilt > 0.18) issues.push("Stand square to the camera with level shoulders.");

  // Does the outline actually cover the body the pose model found?
  // Pose landmarks survive low contrast that segmentation does not, so when the
  // mask stops well above the ankles the silhouette has lost the legs - which
  // silently inflates every circumference. This check does not depend on
  // landmark confidence, so it holds regardless of which pose model ships.
  const poseTop = lm[LM.nose].y;
  const poseBottom = Math.max(lm[LM.lAnkle].y, lm[LM.rAnkle].y);
  const maskTopN = b.top / h, maskBottomN = b.bot / h;
  metrics.maskShortfallBottom = +(poseBottom - maskBottomN).toFixed(3);
  metrics.maskShortfallTop = +(maskTopN - poseTop).toFixed(3);

  if (poseBottom - maskBottomN > 0.05)
    issues.push("Your outline is missing your legs or feet - stand against a background that contrasts with your clothes.");
  if (maskTopN - poseTop > 0.05)
    issues.push("Your outline is missing your head - increase the contrast with the background.");

  return { usable: issues.length === 0, issues, metrics };
}
