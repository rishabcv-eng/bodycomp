// The PR engine decides when the app interrupts someone to congratulate them.
// Too eager and the popup becomes noise within a week; too strict and real
// progress goes unmarked. Both failure modes are cheap to test, so they are.
import {
  logSet, readSets, prsFor, e1rmOf, epley, records, sessions,
  trainingStreak, summary, strengthTrend, loggedExercises,
  formatDuration, prText, clearWorkouts, removeSet,
} from "./public/js/workouts.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`, extra); }
  else { fail++; console.log(`  FAIL ${name}`, extra); }
};

/** localStorage stand-in. */
const makeStore = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

const DAY = 86400000;
const P = "p-test";

/* ------------------------------------------------------- estimated 1RM --- */
console.log("Estimated 1RM");
{
  // Epley would say 103.3 here; a logged single is the one case we know exactly.
  ok("a logged single estimates itself exactly", epley(100, 1) === 100, String(epley(100, 1)));
  ok("more reps at the same weight estimates higher", epley(100, 5) > epley(100, 3));
  // The cap is the point: Epley drifts badly high on long sets, so a 20-rep
  // set must not be allowed to set a strength record.
  ok("a 12-rep set qualifies", e1rmOf({ kg: 60, reps: 12 }) > 0);
  ok("a 13-rep set does not", e1rmOf({ kg: 60, reps: 13 }) === 0, "capped");
  ok("bodyweight (0 kg) does not estimate a 1RM", e1rmOf({ kg: 0, reps: 5 }) === 0);
}

/* -------------------------------------------------------- first-ever set --- */
console.log("\nThe first set of an exercise");
{
  const store = makeStore();
  const r = logSet(P, { exerciseId: "barbell-bench-press", kg: 60, reps: 5 }, store, 1000);
  ok("is recorded", readSets(P, store).length === 1);
  ok("is flagged as a first, not a record", r.first === true && r.prs.length === 0);
  ok("so nothing is celebrated", r.headline === null);
}

/* ---------------------------------------------------------- real records --- */
console.log("\nBeating yourself");
{
  const store = makeStore();
  const bench = (kg, reps, ts) => logSet(P, { exerciseId: "barbell-bench-press", kg, reps }, store, ts);
  bench(60, 5, 1000);

  const heavier = bench(70, 5, 2000);
  ok("a heavier set is a weight PR", heavier.prs.some(p => p.kind === "weight"));
  ok("and is celebrated", heavier.headline?.kind === "weight");
  ok("it carries what it beat", heavier.headline.previous === 60, `previous=${heavier.headline.previous}`);

  const moreReps = bench(70, 8, 3000);
  ok("same weight, more reps is a rep PR", moreReps.prs.some(p => p.kind === "reps"));
  ok("and an estimated-1RM PR", moreReps.prs.some(p => p.kind === "e1rm"));
  ok("the 1RM gain is what gets celebrated", moreReps.headline?.kind === "e1rm");

  const same = bench(70, 8, 4000);
  ok("repeating a set breaks nothing", same.prs.length === 0 && same.headline === null);

  const lighter = bench(50, 10, 5000);
  ok("a lighter set is not a weight PR", !lighter.prs.some(p => p.kind === "weight"));
}

/* ------------------------------------------------- the back-off set trap --- */
console.log("\nBack-off sets must not fire the popup");
{
  const store = makeStore();
  const squat = (kg, reps, ts) => logSet(P, { exerciseId: "back-squat", kg, reps }, store, ts);
  squat(100, 5, 1000);
  squat(120, 3, 2000);

  // The classic false positive: a light, high-rep finisher after the top set.
  // It genuinely is the most reps ever at 60 kg and the biggest single-set
  // volume, and it is still not news.
  const backOff = squat(60, 20, 3000);
  ok("a light finisher can still set rep and volume records",
     backOff.prs.some(p => p.kind === "reps") || backOff.prs.some(p => p.kind === "volume"),
     backOff.prs.map(p => p.kind).join(",") || "none");
  ok("but none of them interrupt the user", backOff.headline === null);
  ok("its 20 reps cannot claim a 1RM record", !backOff.prs.some(p => p.kind === "e1rm"));
}

/* ------------------------------------------------- reps compared fairly --- */
console.log("\nRep records compare like with like");
{
  const store = makeStore();
  const curl = (kg, reps, ts) => logSet(P, { exerciseId: "barbell-curl", kg, reps }, store, ts);
  curl(40, 20, 1000);
  const lightHighRep = curl(20, 21, 2000);
  ok("21 reps at 20 kg does not beat 20 reps at 40 kg",
     !lightHighRep.prs.some(p => p.kind === "reps"));

  const heavyRep = curl(40, 21, 3000);
  ok("21 reps at 40 kg does", heavyRep.prs.some(p => p.kind === "reps"));
}

/* ------------------------------------------------------ bodyweight work --- */
console.log("\nBodyweight exercises");
{
  const store = makeStore();
  const pull = (reps, kg, ts) => logSet(P, { exerciseId: "pull-up", reps, kg }, store, ts);
  pull(8, 0, 1000);
  const more = pull(10, 0, 2000);
  ok("more reps is a rep PR", more.prs.some(p => p.kind === "reps"));
  ok("no 1RM is estimated from bodyweight reps", !more.prs.some(p => p.kind === "e1rm"));

  const weighted = pull(6, 10, 3000);
  ok("adding weight is a weight PR", weighted.prs.some(p => p.kind === "weight"));
  ok("and it is celebrated", weighted.headline?.kind === "weight");
}

/* ------------------------------------------------------------ held time --- */
console.log("\nTimed and distance work");
{
  const store = makeStore();
  const plank = (seconds, ts) => logSet(P, { exerciseId: "plank", seconds }, store, ts);
  plank(60, 1000);
  const longer = plank(95, 2000);
  ok("a longer hold is a record", longer.prs.some(p => p.kind === "reps-time"));
  ok("and it is celebrated", longer.headline?.kind === "reps-time");
  ok("a plank never claims a weight record", !longer.prs.some(p => p.kind === "weight"));

  const run = (seconds, meters, ts) => logSet(P, { exerciseId: "outdoor-run", seconds, meters }, store, ts);
  run(1800, 5000, 3000);
  const further = run(1500, 6000, 4000);
  ok("a further run is a distance record", further.prs.some(p => p.kind === "distance"));
  ok("a shorter time is not automatically a record",
     !further.prs.some(p => p.kind === "reps-time"), "ran 1500s vs 1800s");
}

/* ------------------------------------------------------------- isolation --- */
console.log("\nRecords do not leak between exercises or people");
{
  const store = makeStore();
  logSet(P, { exerciseId: "back-squat", kg: 200, reps: 1 }, store, 1000);
  const press = logSet(P, { exerciseId: "overhead-press", kg: 40, reps: 5 }, store, 2000);
  ok("a squat record does not pre-empt a first press", press.first === true);

  logSet("p-other", { exerciseId: "back-squat", kg: 60, reps: 5 }, store, 3000);
  ok("another profile starts from nothing", readSets("p-other", store).length === 1);
  ok("and the first profile is untouched", readSets(P, store).length === 2);
}

/* ------------------------------------------------------- records summary --- */
console.log("\nThe records board");
{
  const store = makeStore();
  for (const [kg, reps, ts] of [[100, 5, 1000], [120, 2, 2000], [80, 12, 3000]]) {
    logSet(P, { exerciseId: "deadlift", kg, reps }, store, ts);
  }
  const r = records(P, "deadlift", store);
  ok("heaviest is the heaviest", r.weight.kg === 120);
  // 120x2 estimates 128 kg, above 100x5's 117 and 80x12's 112 - the best
  // estimate is not always the heaviest bar, but here it happens to be.
  ok("best estimated max is the set that estimates highest",
     r.e1rm.kg === 120 && r.e1rm.reps === 2, `from ${r.e1rm.kg}kg x ${r.e1rm.reps}`);
  ok("biggest set is by volume", r.volume.kg * r.volume.reps === 960, "80x12");
  ok("an unlogged exercise has no board", records(P, "plank", store) === null);
}

/* ---------------------------------------------------------- the sessions --- */
console.log("\nSessions, streak and totals");
{
  const store = makeStore();
  const now = new Date("2026-03-10T18:00:00").getTime();
  logSet(P, { exerciseId: "back-squat", kg: 100, reps: 5 }, store, now - 2 * DAY);
  logSet(P, { exerciseId: "back-squat", kg: 100, reps: 5 }, store, now - DAY);
  logSet(P, { exerciseId: "barbell-bench-press", kg: 80, reps: 5 }, store, now);
  logSet(P, { exerciseId: "barbell-curl", kg: 30, reps: 10 }, store, now + 60000);

  const s = sessions(P, store);
  ok("one session per day", s.length === 3, `${s.length} sessions`);
  ok("newest first", s[0].ts >= s[1].ts);
  ok("same-day sets land in one session", s[0].sets === 2);
  ok("and group by exercise inside it", s[0].exercises.length === 2);
  ok("volume is summed", s[0].volumeKg === 80 * 5 + 30 * 10, String(s[0].volumeKg));

  ok("three days running is a streak of 3", trainingStreak(P, store, now) === 3,
     String(trainingStreak(P, store, now)));
  // Not having trained *yet today* should not read as a broken streak.
  ok("the streak survives until the day is actually missed",
     trainingStreak(P, store, now + DAY) === 3, String(trainingStreak(P, store, now + DAY)));
  ok("and breaks once a day is skipped", trainingStreak(P, store, now + 2 * DAY) === 0);

  const sum = summary(P, store, now + 60000);
  ok("the week counts every set", sum.weekSets === 4, String(sum.weekSets));
  ok("and the distinct days trained", sum.weekDays === 3, String(sum.weekDays));
  ok("and the distinct exercises", sum.exercises === 3, String(sum.exercises));
}

/* ------------------------------------------------------------ the trend --- */
console.log("\nStrength trend");
{
  const store = makeStore();
  const base = new Date("2026-03-01T10:00:00").getTime();
  logSet(P, { exerciseId: "barbell-bench-press", kg: 60, reps: 8 }, store, base);
  logSet(P, { exerciseId: "barbell-bench-press", kg: 70, reps: 8 }, store, base + 3600000);
  logSet(P, { exerciseId: "barbell-bench-press", kg: 75, reps: 6 }, store, base + 7 * DAY);

  const t = strengthTrend(P, "barbell-bench-press", store);
  ok("one point per training day, not per set", t.length === 2, `${t.length} points`);
  ok("each day keeps its best set", t[0].value === epley(70, 8), String(t[0].value));
  ok("and it rises with the training", t[1].value > t[0].value);

  const logged = loggedExercises(P, store);
  ok("logged exercises resolve to real ones", logged[0].exercise.name === "Barbell Bench Press");
}

/* ------------------------------------------------------------ edit, wipe --- */
console.log("\nCorrecting mistakes");
{
  const store = makeStore();
  logSet(P, { exerciseId: "plank", seconds: 60 }, store, 1000);
  logSet(P, { exerciseId: "plank", seconds: 90 }, store, 2000);
  removeSet(P, 2000, store);
  ok("a mistyped set can be removed", readSets(P, store).length === 1);
  ok("removing it restores the old record", records(P, "plank", store).duration.seconds === 60);
  clearWorkouts(P, store);
  ok("and everything can be wiped", readSets(P, store).length === 0);
}

/* ------------------------------------------------------------- wording --- */
console.log("\nHow it reads");
{
  ok("short holds read in seconds", formatDuration(45) === "45s");
  ok("minutes read as m:ss", formatDuration(330) === "5:30", formatDuration(330));
  ok("hours read as h:mm:ss", formatDuration(3930) === "1:05:30", formatDuration(3930));
  ok("a weight PR reads plainly", prText({ kind: "weight", value: 102.5 }) === "102.5 kg");
  ok("a rep PR says at what weight",
     prText({ kind: "reps", value: 8, atKg: 70 }) === "8 reps at 70 kg");
}

/* ------------------------------------------------------------ bad input --- */
console.log("\nRubbish in");
{
  const store = makeStore();
  ok("an empty set is refused", logSet(P, { exerciseId: "back-squat", kg: 100, reps: 0 }, store) === null);
  ok("a set with no exercise is refused", logSet(P, { kg: 100, reps: 5 }, store) === null);
  ok("negative weight is treated as zero",
     logSet(P, { exerciseId: "pull-up", reps: 5, kg: -20 }, store, 1000).set.kg === 0);
  ok("nothing rubbish was stored", readSets(P, store).length === 1);

  const noStore = readSets(P, null);
  ok("a missing store reads as empty rather than throwing", Array.isArray(noStore));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "FAIL - the PR engine does not behave"
                 : "PASS - records, sessions and streaks all behave");
process.exit(fail ? 1 : 0);
