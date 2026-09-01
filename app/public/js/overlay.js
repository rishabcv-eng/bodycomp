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

// No amber anywhere. Cool instrument colours: alive while adjusting, bright on
// lock, near-white on capture. Warm tones are reserved for genuine errors.
const PALETTE = {
  adjust: { line: "#5FB3C6", dot: "#8FD4E0", glow: "#3E8FA6", wash: "#2E6C7E" },
  ok:     { line: "#3FE0B8", dot: "#9BFFE6", glow: "#3FE0B8", wash: "#1FA98A" },
  done:   { line: "#CFFFF2", dot: "#FFFFFF", glow: "#8FFFE4", wash: "#3FE0B8" },
};

function pathFrom(ctx, pts, scaleX, scaleY) {
  if (pts.length < 3) return;
  ctx.beginPath();
  const P = i => {
    const p = pts[(i + pts.length) % pts.length];
    return [p[0] * scaleX, p[1] * scaleY];
  };
  const [x0, y0] = P(0);
  ctx.moveTo(x0, y0);
  for (let i = 1; i <= pts.length; i++) {
    const [x1, y1] = P(i);
    const [x2, y2] = P(i + 1);
    ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
  }
  ctx.closePath();
}

/** Framing brackets: where the body is expected to sit. */
function drawBrackets(ctx, w, h, colour, alpha) {
  const mx = w * 0.09, my = h * 0.045;
  const len = Math.min(w, h) * 0.075;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(2.5, w / 200);
  ctx.lineCap = "round";
  for (const [cx, cy, dx, dy] of [
    [mx, my, 1, 1], [w - mx, my, -1, 1],
    [mx, h - my, 1, -1], [w - mx, h - my, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * len, cy);
    ctx.stroke();
  }
  ctx.restore();
}

/** The mesh, brightened in a band that travels down the body while holding. */
function drawMesh(ctx, mesh, sx, sy, pal, h, sweepY) {
  const base = Math.max(1.1, sx * 0.55);
  ctx.save();
  ctx.fillStyle = pal.dot;
  for (const [mx, my, edge] of mesh) {
    const x = mx * sx, y = my * sy;
    let a = edge ? 0.85 : 0.45;
    let r = edge ? base * 1.15 : base;
    if (sweepY !== null) {
      const d = Math.abs(y - sweepY) / (h * 0.09);
      if (d < 1) { const k = 1 - d; a = Math.min(1, a + 0.5 * k); r *= 1 + 0.5 * k; }
    }
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Ring that fills as the hold completes. */
function drawHoldRing(ctx, w, h, progress, pal) {
  const r = Math.min(w, h) * 0.05;
  const cx = w - r - w * 0.085, cy = h - r - h * 0.075;
  ctx.save();
  ctx.lineWidth = Math.max(3, w / 150);
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = pal.line;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.dot;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = w / 40;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
  ctx.stroke();
  ctx.restore();
}

/**
 * @param contour  points in mask space, or null when no silhouette is available
 * @param mesh     points in mask space, or null
 * @param state    "ok" | "adjust"
 */
export function drawOverlay(ctx, {
  width, height, contour, mesh, maskWidth, maskHeight,
  state = "adjust", holdProgress = 0, confirmed = false,
}) {
  const pal = confirmed ? PALETTE.done : (state === "ok" ? PALETTE.ok : PALETTE.adjust);
  ctx.clearRect(0, 0, width, height);
  drawBrackets(ctx, width, height, pal.line, state === "ok" || confirmed ? 0.8 : 0.45);

  if (!contour || contour.length < 6 || !maskWidth) return;
  const sx = width / maskWidth, sy = height / maskHeight;

  // interior wash, so the body separates from the background
  ctx.save();
  pathFrom(ctx, contour, sx, sy);
  ctx.globalAlpha = confirmed ? 0.22 : (state === "ok" ? 0.16 : 0.10);
  ctx.fillStyle = pal.wash;
  ctx.fill();
  ctx.restore();

  // the mesh, with a sweep band while a position is being held
  const sweepY = (holdProgress > 0 && !confirmed)
    ? height * (0.06 + 0.88 * ((holdProgress * 1.35) % 1))
    : null;
  if (mesh && mesh.length) drawMesh(ctx, mesh, sx, sy, pal, height, sweepY);

  // edge: a soft glow, then a fine line on top
  ctx.save();
  pathFrom(ctx, contour, sx, sy);
  ctx.strokeStyle = pal.line;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = Math.max(8, width / 55);
  ctx.lineWidth = Math.max(1.8, width / 260);
  ctx.globalAlpha = state === "ok" || confirmed ? 0.9 : 0.6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.lineWidth = Math.max(1, width / 420);
  ctx.stroke();
  ctx.restore();

  if (holdProgress > 0 || confirmed) {
    drawHoldRing(ctx, width, height, confirmed ? 1 : holdProgress, pal);
  }
}
