// The live camera overlay.
//
// A pose skeleton looks like a debug view. What the user should see is the
// thing the app actually measures: their own silhouette edge. It reads as a
// scanner rather than a stick figure, and it makes the clothing problem
// visible - a loose top shows up as a loose outline, before any number is
// produced.
//
// The contour is traced from a real segmentation mask, not drawn from
// landmarks, so it cannot flatter the capture.

const DIRS = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];

/**
 * Moore-neighbour boundary trace of the largest blob.
 * @returns {Array<[number, number]>} closed contour in mask pixel coordinates
 */
export function traceContour(mask, w, h) {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];

  const sx = start % w, sy = (start / w) | 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];

  const dirIndex = (dx, dy) => DIRS.findIndex(d => d[0] === dx && d[1] === dy);

  const pts = [[sx, sy]];
  let cx = sx, cy = sy;
  // The start pixel is the first in raster order, so its west neighbour is
  // background - a valid place to start backtracking from.
  let bx = sx - 1, by = sy;
  const maxSteps = 8 * (w + h) + 4000;

  for (let step = 0; step < maxSteps; step++) {
    const b = dirIndex(bx - cx, by - cy);
    if (b < 0) break;
    let found = false;
    // sweep the 8 neighbours clockwise, starting just past where we came from
    for (let k = 1; k <= 8; k++) {
      const d = (b + k) % 8;
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (at(nx, ny)) {
        // the last background cell examined becomes the next backtrack
        const prev = (d - 1 + 8) % 8;
        bx = cx + DIRS[prev][0];
        by = cy + DIRS[prev][1];
        cx = nx; cy = ny;
        pts.push([cx, cy]);
        found = true;
        break;
      }
    }
    if (!found) break;                       // isolated pixel
    if (cx === sx && cy === sy) break;       // closed the loop
  }
  return pts;
}

/** Thin then smooth, so the outline reads as a curve rather than a staircase. */
export function smoothContour(pts, keepEvery = 4, passes = 3) {
  if (pts.length < 12) return pts;
  let out = pts.filter((_, i) => i % keepEvery === 0);
  const n = out.length;
  for (let p = 0; p < passes; p++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = out[(i - 1 + n) % n], b = out[i], c = out[(i + 1) % n];
      next[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
    }
    out = next;
  }
  return out;
}

/**
 * Points scattered across the body, on a jittered grid clipped to the mask.
 * This is the part that reads as a scan rather than a drawing: the mesh sits on
 * the subject because it is sampled from the segmentation, so it deforms with
 * them and thins out where the mask is uncertain.
 *
 * Jitter is derived from the grid coordinates rather than random, so points do
 * not crawl between frames.
 */
export function sampleMesh(mask, w, h, spacing = 6) {
  const pts = [];
  for (let y = spacing; y < h - 1; y += spacing) {
    for (let x = spacing; x < w - 1; x += spacing) {
      const jx = x + ((x * 7919 + y * 104729) % 5) - 2;
      const jy = y + ((y * 7919 + x * 15485863) % 5) - 2;
      if (jx < 1 || jy < 1 || jx >= w - 1 || jy >= h - 1) continue;
      if (!mask[jy * w + jx]) continue;
      // interior points sit deeper than edge points; used for size and alpha
      const edge = (mask[jy * w + jx - 1] && mask[jy * w + jx + 1] &&
                    mask[(jy - 1) * w + jx] && mask[(jy + 1) * w + jx]) ? 0 : 1;
      pts.push([jx, jy, edge]);
    }
  }
  return pts;
}

/**
 * Horizontal chords across the body at evenly spaced heights.
 *
 * This is the overlay's main structure because it is what the measurement
 * actually is: Stage 1 reads the body's width at 48 heights and nothing else.
 * Drawing those chords shows the user the real quantity being taken off them,
 * rather than decorating the frame with a shape.
 *
 * The run nearest the body centreline is used, matching silhouette.js, so an
 * arm held away from the torso does not stretch the chord.
 */
export function sampleChords(mask, w, h, count = 16) {
  let top = -1, bot = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { if (top < 0) top = y; bot = y; break; }
    }
  }
  if (top < 0 || bot - top < 8) return [];

  const centre = Math.round((() => {
    let lo = w, hi = 0;
    for (let y = top; y <= bot; y++) {
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < lo) lo = x; if (x > hi) hi = x; }
    }
    return (lo + hi) / 2;
  })());

  const out = [];
  for (let i = 0; i < count; i++) {
    const y = Math.round(top + (bot - top) * (i + 0.5) / count);
    let best = null, x = 0;
    while (x < w) {
      if (!mask[y * w + x]) { x++; continue; }
      const s = x;
      while (x < w && mask[y * w + x]) x++;
      const e = x - 1;
      const d = (s <= centre && centre <= e) ? 0 : Math.min(Math.abs(s - centre), Math.abs(e - centre));
      if (!best || d < best.d) best = { d, x0: s, x1: e };
    }
    if (best && best.x1 > best.x0) out.push({ y, x0: best.x0, x1: best.x1 });
  }
  return out;
}

// Cool instrument palette. Warm tones are reserved for genuine errors, so an
// ordinary "keep adjusting" moment never reads as a fault.
const PALETTE = {
  adjust: { line: "#6FBECF", soft: "#4A8EA0", glow: "#3E8FA6" },
  ok:     { line: "#4FE3BE", soft: "#2FA98A", glow: "#3FE0B8" },
  done:   { line: "#DFFFF6", soft: "#7FE8CD", glow: "#8FFFE4" },
};

function pathFrom(ctx, pts, sx, sy) {
  if (pts.length < 3) return;
  ctx.beginPath();
  const P = i => { const p = pts[(i + pts.length) % pts.length]; return [p[0] * sx, p[1] * sy]; };
  const [x0, y0] = P(0);
  ctx.moveTo(x0, y0);
  for (let i = 1; i <= pts.length; i++) {
    const [x1, y1] = P(i), [x2, y2] = P(i + 1);
    ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  ctx.closePath();
}

/** Dim everything outside the body, so the subject separates from the room. */
function dimSurround(ctx, w, h, contour, sx, sy) {
  ctx.save();
  ctx.fillStyle = "rgba(3,10,12,0.5)";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "destination-out";
  pathFrom(ctx, contour, sx, sy);
  ctx.fill();
  ctx.restore();
}

/** Thin framing marks. Long and fine reads as an instrument; short and thick does not. */
function drawFrame(ctx, w, h, pal, alpha) {
  const mx = w * 0.055, my = h * 0.03;
  const len = Math.min(w, h) * 0.09;
  ctx.save();
  ctx.strokeStyle = pal.line;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(1, w / 400);
  for (const [cx, cy, dx, dy] of [
    [mx, my, 1, 1], [w - mx, my, -1, 1], [mx, h - my, 1, -1], [w - mx, h - my, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * len, cy);
    ctx.stroke();
  }
  ctx.restore();
}

/** The measurement itself: width chords, with a tick at each end. */
function drawChords(ctx, chords, sx, sy, pal, h, sweepY) {
  ctx.save();
  ctx.lineWidth = Math.max(1, sx * 0.28);
  const tick = Math.max(3, sx * 1.6);
  for (const c of chords) {
    const y = c.y * sy, x0 = c.x0 * sx, x1 = c.x1 * sx;
    let a = 0.30;
    if (sweepY !== null) {
      const d = Math.abs(y - sweepY) / (h * 0.10);
      if (d < 1) a += 0.55 * (1 - d);
    }
    ctx.globalAlpha = a;
    ctx.strokeStyle = pal.soft;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();

    ctx.globalAlpha = Math.min(1, a + 0.25);
    ctx.strokeStyle = pal.line;
    ctx.beginPath();
    ctx.moveTo(x0, y - tick / 2); ctx.lineTo(x0, y + tick / 2);
    ctx.moveTo(x1, y - tick / 2); ctx.lineTo(x1, y + tick / 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Progress as a hairline under the status banner, clear of the feet marker. */
function drawProgress(ctx, w, h, progress, pal) {
  const mx = w * 0.055, y = h * 0.052;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, w / 220);
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = pal.line;
  ctx.beginPath(); ctx.moveTo(mx, y); ctx.lineTo(w - mx, y); ctx.stroke();
  ctx.globalAlpha = 0.95;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = w / 50;
  ctx.beginPath();
  ctx.moveTo(mx, y);
  ctx.lineTo(mx + (w - 2 * mx) * Math.min(1, progress), y);
  ctx.stroke();
  ctx.restore();
}

/**
 * @param contour  points in mask space, or null when no silhouette is available
 * @param chords   horizontal width chords, or null
 * @param mesh     sparse interior points, or null
 * @param state    "ok" | "adjust"
 */
export function drawOverlay(ctx, {
  width, height, contour, chords, mesh, maskWidth, maskHeight,
  state = "adjust", holdProgress = 0, confirmed = false,
  headOk = false, feetOk = false,
}) {
  const pal = confirmed ? PALETTE.done : (state === "ok" ? PALETTE.ok : PALETTE.adjust);
  ctx.clearRect(0, 0, width, height);
  drawFrame(ctx, width, height, pal, state === "ok" || confirmed ? 0.55 : 0.3);
  drawGuides(ctx, width, height, { headOk, feetOk, state });

  if (!contour || contour.length < 6 || !maskWidth) return;
  const sx = width / maskWidth, sy = height / maskHeight;

  dimSurround(ctx, width, height, contour, sx, sy);

  const sweepY = (holdProgress > 0 && !confirmed)
    ? height * (0.04 + 0.92 * ((holdProgress * 1.3) % 1))
    : null;

  // faint interior texture, well under the chords
  if (mesh && mesh.length) {
    ctx.save();
    ctx.fillStyle = pal.soft;
    ctx.globalAlpha = 0.20;
    const r = Math.max(0.7, sx * 0.3);
    for (const [mx, my] of mesh) {
      ctx.beginPath(); ctx.arc(mx * sx, my * sy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  if (chords && chords.length) drawChords(ctx, chords, sx, sy, pal, height, sweepY);

  // edge: a soft glow, then a hairline on top
  ctx.save();
  pathFrom(ctx, contour, sx, sy);
  ctx.strokeStyle = pal.line;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = Math.max(6, width / 70);
  ctx.lineWidth = Math.max(1.4, width / 320);
  ctx.globalAlpha = state === "ok" || confirmed ? 0.95 : 0.65;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(0.8, width / 560);
  ctx.globalAlpha = 1;
  ctx.stroke();
  ctx.restore();

  if (holdProgress > 0 || confirmed) {
    drawProgress(ctx, width, height, confirmed ? 1 : holdProgress, pal);
  }
}

/**
 * Where the body is meant to sit in the frame. Head and feet get their own
 * markers, because "you are small in the frame" is not actionable and
 * "line your head up with this bar" is. It also encodes the hard requirement:
 * scale comes from body height, so head AND feet must both be visible.
 */
// headY sits below the status banner, feetY above the progress line, so
// neither label is ever occluded by chrome.
export const GUIDE = { headY: 0.115, feetY: 0.945, tol: 0.06 };

/**
 * Judge framing against the markers. Pure, so it is unit-tested.
 * @param headY normalised y of the top of the head
 * @param feetY normalised y of the lowest foot
 */
export function alignment(headY, feetY) {
  const headOk = Math.abs(headY - GUIDE.headY) <= GUIDE.tol;
  const feetOk = Math.abs(feetY - GUIDE.feetY) <= GUIDE.tol;
  const span = feetY - headY;
  const target = GUIDE.feetY - GUIDE.headY;

  let hint = null;
  if (span < target - 0.13) hint = "Step closer, or move the camera nearer.";
  else if (span > target + 0.05) hint = "Step back - you do not fit in the frame.";
  else if (!headOk) hint = "Line the top of your head up with the upper marker.";
  else if (!feetOk) hint = "Line your feet up with the lower marker.";

  return { headOk, feetOk, span, aligned: headOk && feetOk, hint };
}

/** One alignment marker: a bar with end ticks and a label. */
function drawMarker(ctx, w, h, y, label, ok, below, pal) {
  const x0 = w * 0.14, x1 = w * 0.86;
  const tick = Math.min(w, h) * 0.045;
  const colour = ok ? "#4FE3BE" : pal.line;

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, w / 170);
  ctx.lineCap = "square";
  ctx.globalAlpha = ok ? 0.95 : 0.55;
  if (ok) { ctx.shadowColor = colour; ctx.shadowBlur = w / 45; }

  const dir = below ? -1 : 1;          // ticks point into the body
  ctx.beginPath();
  ctx.moveTo(x0, y + dir * tick);
  ctx.lineTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.lineTo(x1, y + dir * tick);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const size = Math.max(9, w * 0.032);
  ctx.font = `600 ${size}px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = below ? "top" : "bottom";
  ctx.fillStyle = colour;
  ctx.globalAlpha = ok ? 0.95 : 0.7;
  ctx.letterSpacing = `${size * 0.08}px`;
  ctx.fillText(label, w / 2, y + (below ? size * 0.7 : -size * 0.7));
  ctx.restore();
}

/** Draw both markers. Exported so drawOverlay stays readable. */
export function drawGuides(ctx, w, h, { headOk = false, feetOk = false, state = "adjust" } = {}) {
  const pal = state === "ok" ? PALETTE.ok : PALETTE.adjust;
  drawMarker(ctx, w, h, h * GUIDE.headY, "ALIGN TO TOP OF HEAD", headOk, false, pal);
  drawMarker(ctx, w, h, h * GUIDE.feetY, "ALIGN TO BOTTOM OF FEET", feetOk, true, pal);
}
