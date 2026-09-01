// Unit tests for the scan's frame scoring. This logic decides which frames
// become the measurement, so it is tested directly rather than only through
// the camera path.
import { frameAssessment, viewScores } from "./public/js/scan.js";

const W = 720, H = 1280;
let failures = 0;

const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

/**
 * Build a plausible 33-point standing pose. shoulderSep is in normalised x.
 * The default is calibrated to real proportions: a ~40 cm shoulder span on a
 * body filling most of a 720x1280 frame is about 0.35 of the frame width.
 */
function pose({ shoulderSep = 0.35, armsOut = true, feet = true, head = true, tilt = 0 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  const cx = 0.5;
  const put = (i, x, y, v = 0.95) => { lm[i] = { x, y, z: 0, visibility: v }; };

  put(0, cx, 0.08, head ? 0.95 : 0.2);                       // nose
  put(11, cx + shoulderSep / 2, 0.25 + tilt);                // left shoulder
  put(12, cx - shoulderSep / 2, 0.25 - tilt);                // right shoulder
  put(23, cx + shoulderSep / 2.6, 0.52);                     // left hip
  put(24, cx - shoulderSep / 2.6, 0.52);                     // right hip
  const wristOut = armsOut ? shoulderSep * 1.15 : shoulderSep * 0.28;
  put(13, cx + wristOut * 0.7, 0.38); put(14, cx - wristOut * 0.7, 0.38);
  put(15, cx + wristOut, 0.50); put(16, cx - wristOut, 0.50); // wrists
  put(25, cx + 0.05, 0.72); put(26, cx - 0.05, 0.72);
  put(27, cx + 0.05, 0.94, feet ? 0.9 : 0.2);                // left ankle
  put(28, cx - 0.05, 0.94, feet ? 0.9 : 0.2);                // right ankle
  return lm;
}

console.log("frameAssessment");
const front = frameAssessment(pose(), W, H);
check("a square front pose is usable", front.usable, JSON.stringify(front.issues));
check("front ratio is high", front.ratio > 0.6, `ratio=${front.ratio.toFixed(2)}`);

// In profile the shoulders overlap, collapsing their horizontal separation.
const side = frameAssessment(pose({ shoulderSep: 0.06, armsOut: false }), W, H);
check("side ratio is low", side.ratio < 0.5, `ratio=${side.ratio.toFixed(2)}`);
check("side pose is not blocked by the arm check", side.usable,
      JSON.stringify(side.issues));

const armsDown = frameAssessment(pose({ armsOut: false }), W, H);
check("arms down is rejected facing the camera",
      armsDown.issues.some(i => i.includes("arms out")), JSON.stringify(armsDown.issues));

const noFeet = frameAssessment(pose({ feet: false }), W, H);
check("missing feet is rejected", noFeet.issues.some(i => i.includes("feet")));

const noHead = frameAssessment(pose({ head: false }), W, H);
check("missing head is rejected", noHead.issues.some(i => i.includes("head")));

const tilted = frameAssessment(pose({ tilt: 0.045 }), W, H);
check("tilted shoulders are rejected",
      tilted.issues.some(i => i.includes("Level")), JSON.stringify(tilted.issues));

check("no landmarks is handled", !frameAssessment(null, W, H).usable);

console.log("\nviewScores");
const fs = viewScores(front), ss = viewScores(side);
check("front frame wins the front slot", fs.front > ss.front,
      `${fs.front.toFixed(2)} > ${ss.front.toFixed(2)}`);
check("side frame wins the side slot", ss.side > fs.side,
      `${ss.side.toFixed(2)} > ${fs.side.toFixed(2)}`);
check("unusable frames score -Infinity", viewScores(noFeet).front === -Infinity);

console.log("\nfront/side separation");
const spread = front.ratio - side.ratio;
check("turn is detectable (spread > 0.25)", spread > 0.25, `spread=${spread.toFixed(2)}`);

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - scan frame scoring behaves as specified");

console.log("\nassumeFacing (alignment phase)");
// A narrow build, or arms held in front, can push the ratio below the profile
// threshold. During alignment the user is square to the camera by definition,
// so the arm check must still run.
const narrowArmsDown = pose({ shoulderSep: 0.16, armsOut: false });
const lenient = frameAssessment(narrowArmsDown, W, H);
const strict = frameAssessment(narrowArmsDown, W, H, { assumeFacing: true });
check("low ratio alone skips the arm check", lenient.usable, `ratio=${lenient.ratio.toFixed(2)}`);
check("assumeFacing catches arms down anyway",
      strict.issues.some(i => i.includes("arms out")), JSON.stringify(strict.issues));

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("PASS - alignment phase applies the arm check regardless of ratio");
