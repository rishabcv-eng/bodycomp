// The overlay traces a real segmentation mask, so a wrong trace would draw a
// confident outline around the wrong shape. These check the geometry directly.
import { traceContour, smoothContour, sampleMesh, sampleChords, alignment, GUIDE } from "./public/js/overlay.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

const W = 60, H = 90;
const rect = (x0, y0, x1, y1) => {
  const m = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
};

console.log("traceContour");
check("an empty mask yields no contour", traceContour(new Uint8Array(W * H), W, H).length === 0);

const box = traceContour(rect(10, 20, 40, 70), W, H);
check("a rectangle produces a closed contour", box.length > 20, `${box.length} points`);
const xs = box.map(p => p[0]), ys = box.map(p => p[1]);
check("contour hugs the left edge", Math.min(...xs) === 10, `min x=${Math.min(...xs)}`);
check("contour hugs the right edge", Math.max(...xs) === 39, `max x=${Math.max(...xs)}`);
check("contour hugs the top edge", Math.min(...ys) === 20, `min y=${Math.min(...ys)}`);
check("contour hugs the bottom edge", Math.max(...ys) === 69, `max y=${Math.max(...ys)}`);
// perimeter of a 30x50 rectangle is 2*(30+50) = 160 boundary steps
check("contour length is about the perimeter", Math.abs(box.length - 160) < 12, `${box.length} vs ~160`);

// a body-like shape: wide torso, narrow legs
const body = rect(18, 10, 42, 50);
for (let y = 50; y < 85; y++) for (let x = 22; x < 28; x++) body[y * W + x] = 1;
for (let y = 50; y < 85; y++) for (let x = 32; x < 38; x++) body[y * W + x] = 1;
const bc = traceContour(body, W, H);
check("a body-like shape traces without hanging", bc.length > 40, `${bc.length} points`);
check("the trace reaches the feet", Math.max(...bc.map(p => p[1])) >= 80,
      `max y=${Math.max(...bc.map(p => p[1]))}`);

console.log("\nsmoothContour");
const sm = smoothContour(bc);
check("smoothing thins the point list", sm.length < bc.length, `${bc.length} -> ${sm.length}`);
check("smoothing keeps the shape in place",
      Math.abs(Math.min(...sm.map(p => p[0])) - Math.min(...bc.map(p => p[0]))) < 3);
check("short contours are passed through untouched",
      smoothContour([[0,0],[1,1],[2,2]]).length === 3);

// a single stray pixel must not spin forever
const dot = new Uint8Array(W * H); dot[30 * W + 30] = 1;
const t0 = Date.now();
const d = traceContour(dot, W, H);
check("an isolated pixel terminates immediately", Date.now() - t0 < 200 && d.length <= 2,
      `${d.length} points in ${Date.now() - t0}ms`);

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - contour tracing matches the mask it is given");

console.log("\nsampleMesh");
const mesh = sampleMesh(body, W, H, 6);
check("mesh has points", mesh.length > 20, `${mesh.length} points`);
check("every mesh point lies inside the mask",
      mesh.every(([x, y]) => body[y * W + x] === 1));
check("no mesh point escapes the bounding box",
      mesh.every(([x, y]) => x >= 18 && x <= 41 && y >= 10 && y <= 84));
check("edge points are flagged separately from interior ones",
      mesh.some(pt => pt[2] === 1) && mesh.some(pt => pt[2] === 0));
check("mesh is deterministic between calls",
      JSON.stringify(sampleMesh(body, W, H, 6)) === JSON.stringify(mesh));
check("wider spacing yields fewer points",
      sampleMesh(body, W, H, 12).length < mesh.length,
      `${sampleMesh(body, W, H, 12).length} < ${mesh.length}`);
check("an empty mask yields no mesh", sampleMesh(new Uint8Array(W * H), W, H).length === 0);

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - contour and mesh both match the mask they are given");

console.log("\nsampleChords");
const chords = sampleChords(body, W, H, 12);
check("chords are produced", chords.length > 6, `${chords.length} chords`);
check("every chord lies inside the mask",
      chords.every(c => body[c.y * W + c.x0] === 1 && body[c.y * W + c.x1] === 1));
check("chords span left to right", chords.every(c => c.x1 > c.x0));
check("chords are ordered top to bottom",
      chords.every((c, i) => i === 0 || c.y > chords[i - 1].y));
// torso is 18..41 wide, legs are two 6-wide columns: torso chords must be wider
const torso = chords.filter(c => c.y < 50), legs = chords.filter(c => c.y > 55);
check("a wide torso gives wider chords than a narrow leg",
      Math.max(...torso.map(c => c.x1 - c.x0)) > Math.max(...legs.map(c => c.x1 - c.x0)),
      `torso ${Math.max(...torso.map(c => c.x1 - c.x0))} vs leg ${Math.max(...legs.map(c => c.x1 - c.x0))}`);
check("an empty mask yields no chords", sampleChords(new Uint8Array(W * H), W, H).length === 0);

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - contour, mesh and chords all match the mask they are given");

console.log("\nalignment markers");
{
  const g = GUIDE;
  const ok = alignment(g.headY, g.feetY);
  check("head and feet on the markers is aligned", ok.aligned && !ok.hint,
        JSON.stringify(ok.hint));

  const far = alignment(0.32, 0.70);              // small in frame
  check("too far away is caught", !far.aligned && /closer/i.test(far.hint), far.hint);

  const near = alignment(0.01, 0.99);             // overflowing the frame
  check("too close is caught", !near.aligned && /back/i.test(near.hint), near.hint);

  const low = alignment(g.headY + 0.14, g.feetY + 0.02);
  check("head off its marker is named specifically",
        !low.headOk && /head/i.test(low.hint), low.hint);

  const feetOff = alignment(g.headY, g.feetY - 0.15);
  check("feet off the marker is named specifically",
        !feetOff.feetOk && /feet|closer/i.test(feetOff.hint), feetOff.hint);

  const edge = alignment(g.headY + g.tol * 0.9, g.feetY - g.tol * 0.9);
  check("small deviations inside tolerance still pass", edge.aligned,
        `head ${edge.headOk} feet ${edge.feetOk}`);

  check("head and feet are judged independently",
        alignment(g.headY, g.feetY - 0.14).headOk === true);
}

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - contour, mesh, chords and alignment all behave");
