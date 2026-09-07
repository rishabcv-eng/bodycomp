// Drives the step machine with a fake pose source: no camera, no DOM canvas.
// Verifies positions are confirmed one at a time and that a wrong orientation
// blocks progress rather than banking a frame.
import { ScanController, STEPS, HOLD_MS, CONFIRM_MS } from "./public/js/scan.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

function pose({ shoulderSep = 0.35, armsOut = true } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: .95 }));
  const put = (i, x, y, v = .95) => { lm[i] = { x, y, z: 0, visibility: v }; };
  const cx = .5;
  put(0, cx, .08); put(11, cx + shoulderSep / 2, .25); put(12, cx - shoulderSep / 2, .25);
  put(23, cx + shoulderSep / 2.6, .52); put(24, cx - shoulderSep / 2.6, .52);
  const w = armsOut ? shoulderSep * 1.15 : shoulderSep * .28;
  put(13, cx + w * .7, .38); put(14, cx - w * .7, .38);
  put(15, cx + w, .50); put(16, cx - w, .50);
  put(25, cx + .05, .72); put(26, cx - .05, .72);
  put(27, cx + .05, .94, .9); put(28, cx - .05, .94, .9);
  return lm;
}

// stand-ins for the browser objects the controller touches
// no-op 2D context: any method returns undefined, any property assignment sticks
const stubCtx = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k]
    : (k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {})),
  set: (t, k, v) => { t[k] = v; return true; },
});
const stubCanvas = () => ({ width: 0, height: 0, getContext: () => stubCtx() });
globalThis.document = { createElement: stubCanvas };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

let current = pose();
const controller = new ScanController({
  video: { readyState: 4, videoWidth: 720, videoHeight: 1280, srcObject: null, play: async () => {} },
  overlay: stubCanvas(),
  pose: { detectForVideo: () => ({ landmarks: [current] }) },
  onState: (s, p) => { events.push({ s, step: p.step?.id, msg: p.message }); last = { s, p }; },
});
const events = [];
let last = null;

await controller.start(async () => ({
  getTracks: () => [{ stop() {} }],
  getVideoTracks: () => [{ stop() {}, getCapabilities: () => ({}), getSettings: () => ({}) }],
}));

let fakeNow = 1000;
const FRAME_MS = 60;                 // pretend ~16 fps
controller.clock = () => fakeNow;
const runTicks = n => { for (let i = 0; i < n; i++) { fakeNow += FRAME_MS; controller.tick(); } };
// Landmarks are smoothed, so a pose change takes a few frames to register.
// Assert on outcomes and on the MINIMUM ticks required, not an exact count.
const runUntil = (pred, max = 120) => {
  for (let i = 1; i <= max; i++) { fakeNow += FRAME_MS; controller.tick(); if (pred()) return i; }
  return -1;
};

console.log("step 1 - front");
current = pose({ shoulderSep: 0.06 });          // wrong: profile while front is asked for
runTicks(Math.ceil(HOLD_MS / FRAME_MS) + 5);
check("a side-on pose does not satisfy the front step",
      controller.captured.front.length === 0, `state=${controller.state}`);
check("the guidance says to turn back to face the camera",
      /face the camera/i.test(last.p.message || ""), last.p.message);

current = pose();                                // correct front
runTicks(4);                                     // let the smoothing catch up
check("holding is reported while the pose is held", controller.state === "holding",
      `state=${controller.state}, held=${last.p.held}/${last.p.needed}`);
check("front not banked early", controller.captured.front.length === 0);

const frontTicks = runUntil(() => controller.state === "confirmed");
check("front confirmed once the hold completes", controller.state === "confirmed",
      `after ${frontTicks} more ticks`);
check("it cannot confirm faster than the hold time allows",
      frontTicks * FRAME_MS >= HOLD_MS - 3 * FRAME_MS,
      `${frontTicks * FRAME_MS}ms vs hold of ${HOLD_MS}ms`);
check("front frames banked", controller.captured.front.length > 0,
      `${controller.captured.front.length} frames`);

// the confirmation must persist, not flash past
controller.tick();
check("confirmation is held on screen", controller.state === "confirmed");
fakeNow += CONFIRM_MS + 60;
controller.tick();
check("advances to step 2 after the confirmation", controller.stepIndex === 1,
      `stepIndex=${controller.stepIndex}`);

console.log("\nstep 2 - side");
current = pose();                                // wrong: still facing front
runTicks(Math.ceil(HOLD_MS / FRAME_MS) + 5);
check("a front pose does not satisfy the side step", controller.captured.side.length === 0);
check("the guidance says to keep turning", /keep turning/i.test(last.p.message || ""), last.p.message);

current = pose({ shoulderSep: 0.06, armsOut: false });
const sideTicks = runUntil(() => controller.captured.side.length > 0);
check("side confirmed", controller.captured.side.length > 0,
      `${controller.captured.side.length} frames after ${sideTicks} ticks`);
check("finishing early is now possible", controller.canFinish);

console.log("\ntolerance to jitter");
{
  // Three levels of tolerance, from a single glitch to a genuine change of pose.
  controller.stepIndex = 1;
  controller._hold = 0; controller._bad = 0; controller._lmEma = null;
  controller.state = "positioning";
  current = pose({ shoulderSep: 0.06, armsOut: false });
  runTicks(15);                            // build up a hold, short of confirming
  const before = controller._hold;

  current = pose();                       // one wrong frame
  controller.tick();
  current = pose({ shoulderSep: 0.06, armsOut: false });
  check("a single bad frame costs at most one frame of credit, never a reset",
        controller._hold >= before - 1 && controller._hold > 0,
        `${before} -> ${controller._hold}`);

  const peak = controller._hold;
  current = pose();                       // a brief wobble out of position
  runTicks(4);
  check("a brief wobble costs credit without resetting",
        controller._hold > 0 && controller._hold < peak, `${peak} -> ${controller._hold}`);

  runTicks(20);                           // sustained wrong position
  check("sustained wrong position does reset the hold", controller._hold === 0,
        `hold=${controller._hold}`);

  // put it back for the remaining checks
  controller.stepIndex = 2;
  controller.state = "positioning";
  controller._hold = 0; controller._bad = 0; controller._lmEma = null;
}

console.log("\noptional third position");
check("advances to the optional step", controller.stepIndex === 2);
check("the optional step is flagged optional", STEPS[2].optional === true);

controller.finishEarly();
check("finishing early completes the scan", controller.state === "done", controller.state);
check("both views present in the result", last.p.front?.length > 0 && last.p.side?.length > 0);
check("front and side are different views", last.p.spread > 0.25, `spread=${last.p.spread?.toFixed(2)}`);

const order = events.filter(e => e.s === "confirmed").map(e => e.step);
check("positions confirmed one at a time, in order",
      JSON.stringify(order) === JSON.stringify(["front", "side"]), JSON.stringify(order));

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - stepped capture confirms each position before advancing");
