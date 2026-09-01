// Verify the JS tree walker reproduces LightGBM's C++ predictions exactly.
import { readFileSync } from "node:fs";
import { loadModel, predict } from "./public/js/trees.js";

const man = JSON.parse(readFileSync("public/models/manifest.json", "utf8"));
const cases = JSON.parse(readFileSync("parity_cases.json", "utf8"));
const load = f => loadModel(new Uint8Array(readFileSync(`public/models/${f}`)).buffer);

let worst = 0, worstName = "", checked = 0, failures = 0;

const check = (name, model, rows, expected) => {
  let maxDiff = 0;
  rows.forEach((row, i) => {
    const got = predict(model, row);
    const diff = Math.abs(got - expected[i]);
    if (diff > maxDiff) maxDiff = diff;
    checked++;
  });
  if (maxDiff > 1e-9) failures++;
  if (maxDiff > worst) { worst = maxDiff; worstName = name; }
  console.log(`  ${name.padEnd(24)} max |JS - Python| = ${maxDiff.toExponential(2)}`);
};

console.log("Stage 1");
for (const [t, file] of Object.entries(man.stage1)) {
  check(t, load(file), cases.stage1.rows, cases.stage1.expected[t]);
}
console.log("Stage 2");
for (const [tgt, info] of Object.entries(man.stage2)) {
  for (const k of ["point", "lo", "hi"]) {
    check(`${tgt}/${k}`, load(info[k]), cases.stage2.rows, cases.stage2.expected[`${tgt}_${k}`]);
  }
}
console.log(`\n${checked} predictions compared`);
console.log(`worst disagreement: ${worst.toExponential(2)} (${worstName})`);
if (failures) { console.error(`FAIL: ${failures} model(s) exceeded 1e-9`); process.exit(1); }
console.log("PASS - JS inference matches LightGBM exactly");
