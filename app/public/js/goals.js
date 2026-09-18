// Something to aim at next.
//
// A rank on its own is a verdict. What keeps someone going is knowing the next
// rung and how far away it is - and, once there are a few scans, roughly when
// they'll get there at their current rate.

import { tablesFor } from "./rank.js";

const WEEK = 7 * 86400000;

/**
 * The age whose median body fat matches yours.
 *
 * A novelty, but a grounded one: it reads the real median curve across age
 * bands rather than inventing a formula. Body fat rises with age in the survey,
 * so a lean 40-year-old genuinely reads younger on this one measure. It says
 * nothing about health, and the app labels it as body-fat age, not fitness age.
 *
 * `coarse` exists because the curve flattens badly: for men the median only
 * moves from 27.3 to 27.8 between 30 and 59, so half a point of body fat can
 * swing the exact age by twenty years. Showing a single year would imply a
 * precision this cannot support, so the UI uses the rounded value.
 */
export function bodyFatAge(bodyFatPct, sex) {
  const bands = tablesFor(sex);
  if (!bands || bands.length < 2) return null;
  const pts = bands.map(b => ({ age: b.mid, median: b.t.bodyfat[50] }));

  const out = age => ({ age: Math.round(age), coarse: Math.round(age / 5) * 5 });

  if (bodyFatPct <= pts[0].median) return { ...out(pts[0].age), atFloor: true };
  const oldest = pts[pts.length - 1];
  if (bodyFatPct >= oldest.median) return { ...out(oldest.age), atCeiling: true };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (bodyFatPct >= a.median && bodyFatPct <= b.median) {
      const f = (bodyFatPct - a.median) / ((b.median - a.median) || 1);
      return out(a.age + f * (b.age - a.age));
    }
  }
  return null;
}

// Rungs are about your own age-and-sex band, so nobody is chasing someone
// else's body - only a clearer version of their own.
const RUNGS = [[50, "Top half"], [75, "Top quarter"], [90, "Top tenth"]];

/**
 * The next rung up, and the body fat that reaches it.
 * @returns {{label, pct, target, gap, reached}|null}
 */
export function nextMilestone(bodyFatPct, sex, bandName) {
  const band = tablesFor(sex)?.find(b => b.band === bandName);
  if (!band) return null;
  for (const [pct, label] of RUNGS) {
    const target = band.t.bodyfat[100 - pct];       // top quarter = leaner than P25
    if (bodyFatPct > target) {
      return { label, pct, target: +target.toFixed(1), gap: +(bodyFatPct - target).toFixed(1), reached: false };
    }
  }
  return { label: "Top tenth", pct: 90, target: null, gap: 0, reached: true };
}

/**
 * Body-fat points per week, from a least-squares fit over the recent scans.
 * Negative means coming down. Null until there are two scans far enough apart
 * to mean anything.
 */
export function weeklyRate(history) {
  if (!history || history.length < 2) return null;
  const pts = history.slice(-6).map(e => [e.ts / WEEK, e.bodyFatPct]);
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  if (den < 1e-9) return null;                      // all scans on the same day
  return +(num / den).toFixed(3);
}

/**
 * When the current trend reaches a target, if it ever does.
 * Deliberately refuses to answer when the trend is flat, going the wrong way,
 * or further out than six months. Fat loss is not linear over a year - rates
 * slow as you get leaner - so projecting a date that far out would be fiction.
 */
const HORIZON_WEEKS = 26;

export function etaTo(history, targetBodyFat, now = Date.now()) {
  const rate = weeklyRate(history);
  if (rate === null || rate > -0.02) return null;
  const last = history[history.length - 1];
  const weeks = (last.bodyFatPct - targetBodyFat) / -rate;
  if (!(weeks > 0) || weeks > HORIZON_WEEKS) return null;
  return {
    weeks: Math.round(weeks),
    ratePerWeek: rate,
    date: new Date(Math.max(now, last.ts) + weeks * WEEK),
  };
}

/** "in 6 weeks (early November)" - vague on purpose; a precise date would be a lie. */
export function etaLabel(eta) {
  if (!eta) return null;
  const d = eta.date;
  const part = d.getDate() <= 10 ? "early" : d.getDate() <= 20 ? "mid" : "late";
  const month = d.toLocaleString(undefined, { month: "long" });
  return `about ${eta.weeks} ${eta.weeks === 1 ? "week" : "weeks"} away, ${part} ${month}`;
}
