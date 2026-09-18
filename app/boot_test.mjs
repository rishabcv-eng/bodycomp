// The app loads 20 MB of segmentation models lazily, so the sharing and retry
// behaviour of the memoiser is load-bearing: get it wrong and either the same
// 15 MB file downloads several times, or one dropped request breaks the camera
// until the page is reloaded.
import { once } from "./public/js/once.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`, extra); }
  else { fail++; console.log(`  FAIL ${name}`, extra); }
};
const marks = [];
const mark = n => marks.push(n);

/* ------------------------------------------------------------- sharing --- */
{
  let calls = 0;
  const step = once("x", async () => { calls++; await new Promise(r => setTimeout(r, 10)); return "v"; }, mark);
  const [a, b, c] = await Promise.all([step(), step(), step()]);
  ok("concurrent callers share one in-flight attempt", calls === 1, `calls=${calls}`);
  ok("every caller gets the same value", a === "v" && b === "v" && c === "v");

  await step();
  ok("a later call is served from cache, not refetched", calls === 1, `calls=${calls}`);
  ok("the mark is left exactly once", marks.filter(m => m === "x").length === 1);
}

/* ------------------------------------------------------------- retrying --- */
{
  let calls = 0;
  const flaky = once("y", async () => {
    calls++;
    if (calls === 1) throw new Error("network down");
    return "recovered";
  }, mark);

  let firstErr = null;
  try { await flaky(); } catch (e) { firstErr = e; }
  ok("a failing step rejects rather than resolving", firstErr?.message === "network down");

  // The bug this guards: a cached rejection would hand every later caller the
  // same failure forever, so a warm-up that ran during a blip would leave the
  // camera permanently broken.
  ok("a failure is not cached - the next call retries", await flaky() === "recovered", `calls=${calls}`);
  ok("no mark is left for the attempt that failed",
     marks.filter(m => m === "y").length === 1, `marks=${marks.filter(m => m === "y").length}`);
}

/* ------------------------------------------------- failure stays isolated --- */
{
  let calls = 0;
  const step = once("z", async () => { calls++; throw new Error("nope"); }, mark);
  const results = await Promise.allSettled([step(), step()]);
  ok("concurrent callers of a failing step still share one attempt", calls === 1, `calls=${calls}`);
  ok("both concurrent callers see the rejection",
     results.every(r => r.status === "rejected" && r.reason.message === "nope"));
  await step().catch(() => {});
  ok("and it retries afterwards", calls === 2, `calls=${calls}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "FAIL - lazy model loading does not behave"
                 : "PASS - model groups are shared once and retried after failure");
process.exit(fail ? 1 : 0);
