// Port of src/extract_silhouette.py. Kept deliberately literal - including the
// truncation behaviour of numpy's astype(int) and median - so the browser
// reproduces the features the model was trained on exactly.

export const LEVELS = 48;

// Ramanujan's ellipse perimeter approximation, accurate to ~1e-5 for human aspect ratios.
export function ellipseCircumference(aSemi, bSemi) {
  const a = Math.max(aSemi, 1e-6), b = Math.max(bSemi, 1e-6);
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * @param {Uint8Array} mask  row-major, non-zero = person
 * @returns {{central: Float64Array, total: Float64Array}|null} widths in cm
 */
export function profile(mask, width, height, heightCm) {
  let top = -1, bot = -1;
  for (let y = 0; y < height; y++) {
    let any = false;
    const off = y * width;
    for (let x = 0; x < width; x++) if (mask[off + x]) { any = true; break; }
    if (any) { if (top < 0) top = y; bot = y; }
  }
  if (top < 0 || bot - top + 1 < 20) return null;

  // columns occupied anywhere between top and bot
  const colUsed = new Uint8Array(width);
  let nCols = 0;
  for (let y = top; y <= bot; y++) {
    const off = y * width;
    for (let x = 0; x < width; x++) if (mask[off + x] && !colUsed[x]) { colUsed[x] = 1; nCols++; }
  }
  if (nCols < 5) return null;

  const cols = new Int32Array(nCols);
  for (let x = 0, i = 0; x < width; x++) if (colUsed[x]) cols[i++] = x;
  // numpy: int(np.median(...)) - mean of the two middle values, then truncate
  const mid = nCols >> 1;
  const medianCol = nCols % 2 ? cols[mid] : (cols[mid - 1] + cols[mid]) / 2;
  const centre = Math.trunc(medianCol);

  const pxPerCm = (bot - top + 1) / heightCm;
  const central = new Float64Array(LEVELS), total = new Float64Array(LEVELS);

  for (let i = 0; i < LEVELS; i++) {
    // numpy linspace(top, bot, LEVELS).astype(int) - truncation, not rounding
    const yf = LEVELS === 1 ? top : top + (bot - top) * i / (LEVELS - 1);
    const y = Math.trunc(yf);
    const off = y * width;

    let count = 0;
    for (let x = 0; x < width; x++) if (mask[off + x]) count++;
    total[i] = count / pxPerCm;
    if (count === 0) { central[i] = 0; continue; }

    // walk contiguous runs, keep the one nearest the body centreline
    let bestScore = Infinity, bestStart = 0, bestEnd = 0;
    let x = 0;
    while (x < width) {
      if (!mask[off + x]) { x++; continue; }
      const start = x;
      while (x < width && mask[off + x]) x++;
      const end = x - 1;
      const score = (start <= centre && centre <= end)
        ? 0 : Math.min(Math.abs(start - centre), Math.abs(end - centre));
      if (score < bestScore) { bestScore = score; bestStart = start; bestEnd = end; }
    }
    central[i] = (bestEnd - bestStart + 1) / pxPerCm;
  }
  return { central, total };
}

/** Build the Stage 1 feature vector from a front/side mask pair. */
export function silhouetteFeatures(front, side, heightCm, weightKg, sex, featureNames) {
  const f = profile(front.mask, front.width, front.height, heightCm);
  const s = profile(side.mask, side.width, side.height, heightCm);
  if (!f || !s) return null;

  const circ = new Float64Array(LEVELS);
  for (let i = 0; i < LEVELS; i++) circ[i] = ellipseCircumference(f.central[i] / 2, s.central[i] / 2);

  const d = {};
  const pad = i => String(i).padStart(2, "0");
  for (let i = 0; i < LEVELS; i++) {
    d[`front_w${pad(i)}`] = f.central[i];
    d[`side_w${pad(i)}`] = s.central[i];
    d[`circ${pad(i)}`] = circ[i];
  }
  const sum = a => a.reduce((p, c) => p + c, 0);
  d.front_area = sum(Array.from(f.total));
  d.side_area = sum(Array.from(s.total));
  d.front_max_w = Math.max(...f.central);
  d.side_max_w = Math.max(...s.central);

  const lo = Math.trunc(LEVELS * 0.25), hi = Math.trunc(LEVELS * 0.60);
  const band = Array.from(circ).slice(lo, hi);
  d.torso_circ_min = Math.min(...band);
  d.torso_circ_max = Math.max(...band);
  d.torso_circ_mean = sum(band) / band.length;

  d.sex = sex;
  d.height_cm = heightCm;
  d.weight_kg = weightKg;
  d.bmi = weightKg / ((heightCm / 100) ** 2);

  return { vector: featureNames.map(n => d[n]), named: d };
}
