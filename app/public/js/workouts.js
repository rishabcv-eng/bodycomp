// Workout logging and the personal-record engine.
//
// Sets are stored flat, each carrying its own timestamp, and sessions are
// derived by calendar day. That is deliberate: a stored "current session" is
// state that can be left open, double-opened or orphaned by a refresh, and
// none of those bugs can exist if the session is just a view over the sets.
//
// Everything here is pure apart from the storage accessor, which is injectable
// so the whole module runs under Node in workouts_test.mjs.

import { BY_ID } from "./exercises.js";

export const WORKOUT_KEY = "bodycomp.workouts.v1";
const MAX_SETS = 20000;          // ~10 years of serious training
const DAY = 86400000;

/* Epley. Above about 12 reps the estimate drifts badly high - a 20-rep set is
 * limited by conditioning, not by maximal strength - so sets longer than this
 * simply do not compete for the estimated-1RM record rather than inflating it. */
const E1RM_MAX_REPS = 12;

/* Epley reads 1RM = w(1 + r/30), which at r = 1 returns 1.033w - it claims a
 * true single was 3.3% heavier than the bar actually was. A logged 1RM is the
 * one case where the answer is known exactly, so it is returned exactly. */
export const epley = (kg, reps) => (reps <= 1 ? kg : kg * (1 + reps / 30));

/** The estimated 1RM a set is allowed to claim, or 0 if it does not qualify. */
export function e1rmOf(set) {
  if (!(set.kg > 0) || !(set.reps > 0) || set.reps > E1RM_MAX_REPS) return 0;
  return epley(set.kg, set.reps);
}

const safeStore = store => store || (typeof localStorage !== "undefined" ? localStorage : null);
const num = v => (Number.isFinite(+v) && +v >= 0 ? +v : 0);

/** A set is only kept if it records something. */
function tidySet(s) {
  if (!s || typeof s.ts !== "number" || !s.exerciseId) return null;
  const out = {
    ts: s.ts,
    exerciseId: String(s.exerciseId),
    reps: Math.round(num(s.reps)),
    kg: Math.round(num(s.kg) * 100) / 100,
    seconds: Math.round(num(s.seconds)),
    meters: Math.round(num(s.meters)),
  };
  return (out.reps || out.seconds || out.meters) ? out : null;
}

export function readSets(profileId, store) {
  const s = safeStore(store);
  if (!s || !profileId) return [];
  try {
    const all = JSON.parse(s.getItem(WORKOUT_KEY) || "{}");
    return (all[profileId] || []).map(tidySet).filter(Boolean).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

function writeSets(profileId, sets, store) {
  const s = safeStore(store);
  if (!s || !profileId) return sets;
  try {
    const all = JSON.parse(s.getItem(WORKOUT_KEY) || "{}");
    all[profileId] = sets.slice(-MAX_SETS);
    s.setItem(WORKOUT_KEY, JSON.stringify(all));
  } catch { /* full or blocked - the session still works, it just will not persist */ }
  return sets;
}

/* ------------------------------------------------------------------- PRs --- */

/* Which records a popup is allowed to interrupt for.
 *
 * Only `weight` and `e1rm` qualify, and the reason is back-off sets. After a
 * top set of 100 kg x 5, a light 60 kg x 15 finisher can easily be the most
 * reps ever done at 60 kg and the biggest single-set volume - both true, both
 * worthless as news. Neither can touch the heaviest weight or the estimated
 * 1RM, so those two are exactly the records a lighter set cannot fake.
 *
 * Rep and volume records still get recorded and shown on the set itself; they
 * just do not take over the screen. */
const CELEBRATED = new Set(["weight", "e1rm", "reps-time", "distance"]);

const RANK = ["weight", "e1rm", "reps-time", "distance", "reps", "volume"];

const LABEL = {
  weight: "Heaviest ever",
  e1rm: "Best estimated 1RM",
  reps: "Most reps at this weight",
  volume: "Biggest set",
  "reps-time": "Longest hold",
  distance: "Furthest",
};

/**
 * Which records `set` breaks, given every set of the same exercise logged
 * before it. `prior` must exclude the set itself.
 *
 * The first time an exercise is ever logged nothing is a record - otherwise the
 * very first set of every exercise fires a celebration, which trains people to
 * ignore the popup within a week.
 */
export function prsFor(set, prior, metric = "load") {
  if (!prior.length) return { first: true, prs: [], headline: null };

  const prs = [];
  const best = (fn) => prior.reduce((m, p) => Math.max(m, fn(p)), 0);

  if (metric === "time") {
    if (set.seconds > 0 && set.seconds > best(p => p.seconds)) {
      prs.push({ kind: "reps-time", value: set.seconds, previous: best(p => p.seconds) });
    }
    if (set.meters > 0 && set.meters > best(p => p.meters)) {
      prs.push({ kind: "distance", value: set.meters, previous: best(p => p.meters) });
    }
  } else {
    if (set.kg > 0 && set.kg > best(p => p.kg)) {
      prs.push({ kind: "weight", value: set.kg, previous: best(p => p.kg) });
    }
    // Reps are compared only against the same weight. Ranking them across
    // weights cannot be made to mean anything: 21 reps at 20 kg is not better
    // than 20 reps at 40 kg, and no comparison of the two numbers says so.
    // "Most reps at 70 kg" is a claim that is simply true.
    const atSame = prior.filter(p => p.kg === set.kg);
    if (atSame.length && set.reps > 0) {
      const bestReps = atSame.reduce((m, p) => Math.max(m, p.reps), 0);
      if (set.reps > bestReps) prs.push({ kind: "reps", value: set.reps, previous: bestReps, atKg: set.kg });
    }
    if (metric === "load") {
      const e = e1rmOf(set);
      const bestE = best(e1rmOf);
      if (e > 0 && e > bestE) prs.push({ kind: "e1rm", value: e, previous: bestE });

      const vol = set.kg * set.reps;
      const bestVol = best(p => p.kg * p.reps);
      if (vol > 0 && vol > bestVol) prs.push({ kind: "volume", value: vol, previous: bestVol });
    }
  }

  prs.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind));
  for (const p of prs) {
    p.label = LABEL[p.kind];
    p.celebrate = CELEBRATED.has(p.kind);
  }
  const headline = prs.find(p => p.celebrate) || null;
  return { first: false, prs, headline };
}

/**
 * Log one set and report what it broke.
 *
 * Returns `{ set, first, prs, headline }` so the caller can celebrate without
 * re-deriving anything.
 */
export function logSet(profileId, entry, store, now = Date.now()) {
  const set = tidySet({ ...entry, ts: entry.ts ?? now });
  if (!set) return null;

  const all = readSets(profileId, store);
  const metric = BY_ID[set.exerciseId]?.metric || "load";
  const prior = all.filter(s => s.exerciseId === set.exerciseId && s.ts < set.ts);
  const result = prsFor(set, prior, metric);

  all.push(set);
  all.sort((a, b) => a.ts - b.ts);
  writeSets(profileId, all, store);
  return { set, ...result };
}

export function removeSet(profileId, ts, store) {
  const all = readSets(profileId, store).filter(s => s.ts !== ts);
  return writeSets(profileId, all, store);
}

export function clearWorkouts(profileId, store) {
  return writeSets(profileId, [], store);
}

/* ---------------------------------------------------------------- records --- */

/** The records board for one exercise: the best of each kind, ever. */
export function records(profileId, exerciseId, store) {
  const sets = readSets(profileId, store).filter(s => s.exerciseId === exerciseId);
  if (!sets.length) return null;
  const metric = BY_ID[exerciseId]?.metric || "load";

  const pick = (fn) => sets.reduce((best, s) => (fn(s) > fn(best) ? s : best), sets[0]);
  if (metric === "time") {
    return {
      metric, sets: sets.length,
      duration: pick(s => s.seconds),
      distance: sets.some(s => s.meters > 0) ? pick(s => s.meters) : null,
    };
  }
  return {
    metric, sets: sets.length,
    weight: pick(s => s.kg),
    e1rm: sets.some(s => e1rmOf(s) > 0) ? pick(e1rmOf) : null,
    volume: pick(s => s.kg * s.reps),
    reps: pick(s => s.reps),
  };
}

/** Every exercise this person has ever logged, most recently used first. */
export function loggedExercises(profileId, store) {
  const seen = new Map();
  for (const s of readSets(profileId, store)) seen.set(s.exerciseId, s.ts);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, ts]) => ({ id, lastTs: ts, exercise: BY_ID[id] }))
    .filter(x => x.exercise);
}

/* --------------------------------------------------------------- sessions --- */

const dayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * Sets grouped into sessions by calendar day, newest first.
 *
 * Two gym visits in one day read as one session. That is the right trade for a
 * tracker: it matches how people describe their training ("legs on Tuesday"),
 * and the alternative needs an explicit end-session step that people forget.
 */
export function sessions(profileId, store) {
  const byDay = new Map();
  for (const s of readSets(profileId, store)) {
    const k = dayKey(s.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }

  const out = [];
  for (const [key, sets] of byDay) {
    const byExercise = new Map();
    for (const s of sets) {
      if (!byExercise.has(s.exerciseId)) byExercise.set(s.exerciseId, []);
      byExercise.get(s.exerciseId).push(s);
    }
    out.push({
      key,
      ts: sets[0].ts,
      endTs: sets[sets.length - 1].ts,
      sets: sets.length,
      volumeKg: Math.round(sets.reduce((v, s) => v + s.kg * s.reps, 0)),
      seconds: sets.reduce((v, s) => v + s.seconds, 0),
      exercises: [...byExercise.entries()].map(([id, ss]) => ({
        id, exercise: BY_ID[id], sets: ss,
        volumeKg: Math.round(ss.reduce((v, s) => v + s.kg * s.reps, 0)),
        topKg: ss.reduce((m, s) => Math.max(m, s.kg), 0),
      })),
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** Distinct training days in a row, counting back from today (or yesterday). */
export function trainingStreak(profileId, store, now = Date.now()) {
  const days = new Set(readSets(profileId, store).map(s => dayKey(s.ts)));
  if (!days.size) return 0;

  let streak = 0;
  // Starting from today would reset the streak to 0 every morning before the
  // first set, which reads as punishment for not having trained yet.
  let cursor = days.has(dayKey(now)) ? now : now - DAY;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor -= DAY;
  }
  return streak;
}

/** Totals for the headline row: sets, volume and PRs over a window. */
export function summary(profileId, store, now = Date.now(), windowDays = 7) {
  const since = now - windowDays * DAY;
  const sets = readSets(profileId, store);
  const recent = sets.filter(s => s.ts >= since);
  return {
    totalSets: sets.length,
    weekSets: recent.length,
    weekVolumeKg: Math.round(recent.reduce((v, s) => v + s.kg * s.reps, 0)),
    weekDays: new Set(recent.map(s => dayKey(s.ts))).size,
    streak: trainingStreak(profileId, store, now),
    exercises: new Set(sets.map(s => s.exerciseId)).size,
  };
}

/**
 * Estimated-1RM over time for one exercise, best per training day.
 *
 * One point per day rather than per set: a session's working sets would
 * otherwise draw a sawtooth that hides the trend the chart exists to show.
 */
export function strengthTrend(profileId, exerciseId, store) {
  const byDay = new Map();
  for (const s of readSets(profileId, store)) {
    if (s.exerciseId !== exerciseId) continue;
    const e = e1rmOf(s);
    if (!e) continue;
    const k = dayKey(s.ts);
    if (!byDay.has(k) || e > byDay.get(k).value) byDay.set(k, { ts: s.ts, value: e });
  }
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

/** Format seconds as 1:05:30 / 5:30 / 45s. */
export function formatDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = n => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** How a record is worded on screen. */
export function prText(pr) {
  switch (pr.kind) {
    case "weight": return `${pr.value} kg`;
    case "e1rm": return `${pr.value.toFixed(1)} kg estimated max`;
    case "reps": return `${pr.value} reps at ${pr.atKg} kg`;
    case "volume": return `${Math.round(pr.value)} kg in one set`;
    case "reps-time": return formatDuration(pr.value);
    case "distance": return `${pr.value} m`;
    default: return "";
  }
}
