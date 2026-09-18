// Stage 1 + Stage 2 in the browser. Everything below runs on the device;
// no image, measurement or result is ever uploaded.

import { loadModel, predict } from "./trees.js";
import { silhouetteFeatures } from "./silhouette.js";

let bundle = null;

export async function loadModels(base = "models") {
  if (bundle) return bundle;
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  const get = async file => loadModel(await (await fetch(`${base}/${file}`)).arrayBuffer());

  // All eleven at once. Awaiting them one by one cost a round trip each - 4.4 s
  // of latency on a real connection for 0.9 MB that fits in a single wave.
  const files = [
    ...Object.entries(manifest.stage1).map(([name, file]) => ({ name, file })),
    ...Object.entries(manifest.stage2).flatMap(([target, info]) =>
      ["point", "lo", "hi"].map(part => ({ target, part, file: info[part] }))),
  ];
  const loaded = await Promise.all(files.map(f => get(f.file)));

  const stage1 = {}, stage2 = {};
  files.forEach((f, i) => {
    if (f.name !== undefined) { stage1[f.name] = loaded[i]; return; }
    const info = manifest.stage2[f.target];
    stage2[f.target] ??= { q: info.q, mae: info.mae, coverage80: info.coverage80 };
    stage2[f.target][f.part] = loaded[i];
  });

  bundle = { manifest, stage1, stage2 };
  return bundle;
}

/** Stage 2 features, rebuilt from measurements exactly as training did. */
function stage2Vector(names, { sex, age, heightCm, weightKg, waist, arm }) {
  const bmi = weightKg / ((heightCm / 100) ** 2);
  const v = {
    sex, age, height_cm: heightCm, weight_kg: weightKg, bmi,
    waist_cm: waist, arm_circ_cm: arm,
    waist_to_height: waist / heightCm,
    waist_to_weight: waist / weightKg,
    arm_to_height: arm / heightCm,
    waist_to_arm: waist / arm,
    ponderal_index: weightKg / ((heightCm / 100) ** 3),
  };
  return names.map(n => v[n]);
}

const r1 = x => Math.round(x * 10) / 10;

/** Stage 1 only: one front/side pair -> raw (unrounded) measurements. */
function measurePair(front, side, { heightCm, weightKg, sex }) {
  const { manifest, stage1 } = bundle;
  const feats = silhouetteFeatures(front, side, heightCm, weightKg, sex, manifest.s1_features);
  if (!feats) return null;
  const out = {};
  for (const [name, model] of Object.entries(stage1)) out[name] = predict(model, feats.vector);
  return out;
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Multi-frame analysis. Each pair is measured independently and the results are
 * combined with a median, so one bad segmentation cannot drag the answer -
 * which a mean would allow. Only the random component of the error shrinks;
 * systematic model bias is untouched by averaging.
 *
 * @param pairs [{front, side}]  one or more silhouette pairs
 */
export function analyseMany(pairs, profile) {
  const perPair = pairs.map(p => measurePair(p.front, p.side, profile)).filter(Boolean);
  if (!perPair.length) throw new Error("Could not read the silhouette - is the whole body in frame?");

  const names = Object.keys(perPair[0]);
  const combined = {};
  const spread = {};
  for (const n of names) {
    const vals = perPair.map(m => m[n]);
    combined[n] = median(vals);
    spread[n] = r1(Math.max(...vals) - Math.min(...vals));
  }
  const out = compose(combined, profile);
  out.frameCount = perPair.length;
  out.frameSpread = spread;
  return out;
}

/**
 * @param front {mask, width, height}  binary silhouette
 * @param side  {mask, width, height}
 */
export function analyse(front, side, profile) {
  const m = measurePair(front, side, profile);
  if (!m) throw new Error("Could not read the silhouette - is the whole body in frame?");
  const out = compose(m, profile);
  out.frameCount = 1;
  return out;
}

/** Shared tail: measurements -> body composition. */
function compose(raw, { heightCm, weightKg, age, sex }) {
  const { manifest, stage2 } = bundle;
  const measurements = {};
  for (const [k, v] of Object.entries(raw)) measurements[k] = r1(v);

  const x2 = stage2Vector(manifest.s2_features, {
    sex, age, heightCm, weightKg,
    waist: measurements.waist, arm: measurements.bicep,
  });

  const out = { measurements, composition: {} };
  for (const [target, m] of Object.entries(stage2)) {
    out.composition[target] = {
      estimate: r1(predict(m.point, x2)),
      low: r1(predict(m.lo, x2) - m.q),
      high: r1(predict(m.hi, x2) + m.q),
      mae: m.mae,
      coverage80: m.coverage80,
    };
  }

  const bf = out.composition.bodyfat_pct.estimate;
  const alm = out.composition.alm_kg.estimate;
  out.derived = {
    fatMassKg: r1(weightKg * bf / 100),
    fatFreeMassKg: r1(weightKg * (1 - bf / 100)),
    almi: Math.round((alm / ((heightCm / 100) ** 2)) * 100) / 100,
    musclePctOfWeight: r1(100 * alm / weightKg),
  };
  return out;
}
