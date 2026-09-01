// Verify the JS silhouette extractor matches the Python one feature-for-feature.
import { readFileSync } from "node:fs";
import { silhouetteFeatures } from "./public/js/silhouette.js";

const meta = JSON.parse(readFileSync("parity_masks.json", "utf8"));
const raw = new Uint8Array(readFileSync("parity_masks.bin"));
const man = JSON.parse(readFileSync("public/models/manifest.json", "utf8"));
const names = man.s1_features;

let worst = 0, worstFeat = "", n = 0;
for (const c of meta.cases) {
  const view = s => ({ mask: raw.subarray(s.off, s.off + s.len), width: s.w, height: s.h });
  const got = silhouetteFeatures(view(c.front), view(c.side),
                                 c.height_cm, c.weight_kg, c.sex, names).named;
  let caseWorst = 0, caseFeat = "";
  for (const [k, exp] of Object.entries(c.expected)) {
    if (!(k in got)) throw new Error(`JS is missing feature ${k}`);
    const diff = Math.abs(got[k] - exp);
    n++;
    if (diff > caseWorst) { caseWorst = diff; caseFeat = k; }
  }
  if (caseWorst > worst) { worst = caseWorst; worstFeat = caseFeat; }
  console.log(`  ${c.photo_id.slice(0, 10)}  max diff ${caseWorst.toExponential(2)}  (${caseFeat})`);
}
console.log(`\n${n} feature values compared across ${meta.cases.length} mask pairs`);
console.log(`worst disagreement: ${worst.toExponential(2)} (${worstFeat})`);
if (worst > 1e-9) { console.error("FAIL: silhouette features diverge"); process.exit(1); }
console.log("PASS - JS silhouette features match Python exactly");
