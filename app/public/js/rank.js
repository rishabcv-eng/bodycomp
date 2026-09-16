// Where you sit among real people - the leaderboard, without a leaderboard.
//
// Ranking users against each other would need accounts, a server and a database
// of other people's body composition. Instead the comparison group is the one
// the models were trained against: adults with real DXA scans from NHANES. The
// percentile tables ship with the app and the lookup runs here, so a rank costs
// nothing in privacy and works offline.
//
// Honest framing, because this is the part that is easy to overstate:
//   - it is a US survey sample, not a global or Indian population
//   - leaner is not automatically healthier, and the app never says "better"
//   - the estimate's own error (~2.8 points) is wider than a few percentile places

let data = null;

export async function loadRanks(base = "models") {
  if (data) return data;
  const res = await fetch(`${base}/percentiles.json`);
  if (!res.ok) throw new Error(`percentiles.json: HTTP ${res.status}`);
  data = await res.json();
  return data;
}

/** Inject tables directly (tests, or a caller that already has them). */
export function setRanks(d) { data = d; }

const BANDS = [["18-29", 18, 29], ["30-39", 30, 39], ["40-49", 40, 49], ["50-59", 50, 59]];

/**
 * Age band, clamped. Someone aged 62 is compared with the 50-59 band and told
 * so, rather than silently ranked against a group they are not in.
 */
export function bandFor(age) {
  for (const [name, lo, hi] of BANDS) if (age >= lo && age <= hi) return { band: name, exact: true };
  if (age < 18) return { band: "18-29", exact: false };
  return { band: "50-59", exact: false };
}

/**
 * Percentage of the group sitting below `value`, interpolating between the
 * stored P0..P100 points. Flat runs (many people at the same value) resolve to
 * the middle of the run rather than to one end.
 */
export function percentileOf(sorted, value) {
  const last = sorted.length - 1;
  if (value <= sorted[0]) return 0;
  if (value >= sorted[last]) return 100;
  let i = 0;
  while (i < last && sorted[i + 1] <= value) i++;      // last index with sorted[i] <= value
  if (sorted[i + 1] === sorted[i]) return i;
  let j = i;
  while (j > 0 && sorted[j - 1] === sorted[i]) j--;    // start of a flat run
  const frac = (value - sorted[i]) / (sorted[i + 1] - sorted[i]);
  return +(((i + j) / 2) + frac).toFixed(1);
}

/**
 * @returns {{band, n, exact, leanerThan, moreMuscleThan, people, source}|null}
 *   leanerThan      percent of the group carrying MORE body fat than you
 *   moreMuscleThan  percent of the group with LESS lean mass for their height
 */
export function rank(bodyFatPct, almi, age, sex) {
  if (!data) return null;
  const { band, exact } = bandFor(age);
  const key = `${sex === 1 ? "male" : "female"}|${band}`;
  const t = data.tables[key];
  if (!t) return null;
  return {
    band,
    exact,
    n: t.n,
    people: data.people,
    source: data.source,
    leanerThan: +(100 - percentileOf(t.bodyfat, bodyFatPct)).toFixed(1),
    moreMuscleThan: almi != null ? percentileOf(t.almi, almi) : null,
  };
}

/** A line that reads like a person wrote it, not a statistics table. */
export function rankLabel(r, sex) {
  if (!r) return "";
  const group = `${sex === 1 ? "men" : "women"} aged ${r.band}`;
  return `Leaner than ${Math.round(r.leanerThan)}% of ${group}`;
}
