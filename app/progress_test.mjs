// History, streaks, badges and population ranking.
// These drive what the user is told about their progress, so the edges matter:
// a streak that miscounts or a rank that points the wrong way is worse than none.
import { readFileSync } from "node:fs";
import {
  loadHistory, saveScan, clearHistory, streak, deltas, badges, trendPoints, KEY,
} from "./public/js/progress.js";
import { setRanks, rank, bandFor, percentileOf, rankLabel } from "./public/js/rank.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

/** Minimal stand-in for localStorage. */
const makeStore = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _dump: () => m,
  };
};

const DAY = 86400000, WEEK = 7 * DAY;
const scan = (bf, lean = 58, weight = 72) => ({
  bodyFatPct: bf, fatFreeMassKg: lean, weightKg: weight, waistCm: 84, almi: 8.4, age: 24, sex: 1,
});

console.log("history");
{
  const store = makeStore();
  check("empty storage reads as no history", loadHistory(store).length === 0);
  store.setItem(KEY, "{not json");
  check("corrupt storage does not throw", loadHistory(store).length === 0);
  store.removeItem(KEY);

  const t0 = Date.UTC(2026, 0, 5, 9);                  // a Monday
  saveScan(scan(24.0), store, t0);
  check("a scan is remembered", loadHistory(store).length === 1);

  saveScan(scan(23.8), store, t0 + 10 * 60000);        // 10 minutes later
  const afterRetry = loadHistory(store);
  check("a re-scan within the hour replaces, not appends",
        afterRetry.length === 1 && afterRetry[0].bodyFatPct === 23.8,
        `${afterRetry.length} entries, bf=${afterRetry[0].bodyFatPct}`);

  saveScan(scan(23.1), store, t0 + 8 * DAY);
  check("a later scan appends", loadHistory(store).length === 2);
  check("history is oldest first", loadHistory(store)[0].ts < loadHistory(store)[1].ts);
  check("values are rounded for storage", loadHistory(store).every(e => String(e.bodyFatPct).length <= 4));

  clearHistory(store);
  check("history can be wiped", loadHistory(store).length === 0);
}

console.log("\nstreak");
{
  const now = Date.UTC(2026, 1, 2, 12);                // Monday
  const weekly = n => Array.from({ length: n }, (_, i) => ({ ...scan(24), ts: now - i * WEEK }));
  check("no history is no streak", streak([], now).weeks === 0);
  check("this week alone is a one-week streak", streak(weekly(1), now).weeks === 1);
  check("four consecutive weeks count", streak(weekly(4), now).weeks === 4, `${streak(weekly(4), now).weeks}`);

  const gap = [{ ...scan(24), ts: now }, { ...scan(24), ts: now - 3 * WEEK }];
  check("a missed week breaks the streak", streak(gap, now).weeks === 1, `${streak(gap, now).weeks}`);

  const lastWeekOnly = [{ ...scan(24), ts: now - WEEK }];
  check("the streak survives until this week ends", streak(lastWeekOnly, now).weeks === 1,
        "a scan last week but none yet this week still counts");

  const stale = [{ ...scan(24), ts: now - 4 * WEEK }];
  check("an old scan is not a live streak", streak(stale, now).weeks === 0);
  check("days since last scan is reported", streak(stale, now).daysSinceLast === 28,
        `${streak(stale, now).daysSinceLast}`);
}

console.log("\ndeltas");
{
  const now = Date.UTC(2026, 2, 1);
  const h = [
    { ...scan(28.0, 56), ts: now - 60 * DAY },
    { ...scan(26.0, 57), ts: now - 30 * DAY },
    { ...scan(24.5, 58), ts: now },
  ];
  check("one scan has no deltas", deltas([h[0]]) === null);
  const d = deltas(h);
  check("change since the first scan", d.sinceFirst.bodyFat === -3.5, `${d.sinceFirst.bodyFat}`);
  check("lean change since the first scan", d.sinceFirst.lean === 2, `${d.sinceFirst.lean}`);
  check("change since the previous scan", d.sincePrevious.bodyFat === -1.5, `${d.sincePrevious.bodyFat}`);
  check("elapsed days are reported", d.sinceFirst.days === 60, `${d.sinceFirst.days}`);
}

console.log("\nbadges");
{
  const now = Date.UTC(2026, 1, 2, 12);
  const has = (res, id) => res.badges.find(b => b.id === id).earned;
  const one = badges([{ ...scan(24), ts: now }], null, now);
  check("first scan is earned immediately", has(one, "first"));
  check("nothing else is handed out for free", one.earned === 1, `${one.earned} earned`);

  const four = badges(Array.from({ length: 4 }, (_, i) => ({ ...scan(24), ts: now - i * WEEK })), null, now);
  check("four-week streak badge", has(four, "month"));
  check("twelve-week badge is not yet earned", !has(four, "quarter"));

  const down = badges([{ ...scan(28, 56), ts: now - 60 * DAY }, { ...scan(24.5, 58), ts: now }], null, now);
  check("down one point", has(down, "fat1"));
  check("down three points", has(down, "fat3"));
  check("kilo of muscle", has(down, "lean1"));

  const ranked = badges([{ ...scan(14), ts: now }], { leanerThan: 82 }, now);
  check("top half from rank", has(ranked, "half"));
  check("top quarter from rank", has(ranked, "quartile"));
  check("no rank means no rank badges", !has(one, "half"));
  check("leanest scan is tracked", down.leanest === 24.5, `${down.leanest}`);
}

console.log("\ntrend sparkline");
{
  check("one point cannot make a line", trendPoints([24], 100, 40) === null);
  const pts = trendPoints([28, 26, 24], 100, 40);
  check("points span the box", pts.length === 3 && pts[0][0] === 6 && pts[2][0] === 94,
        JSON.stringify(pts));
  // Standard chart orientation: a bigger number sits higher, so body fat coming
  // down over time draws a line that descends.
  check("falling body fat draws a descending line", pts[0][1] < pts[2][1],
        `y ${pts[0][1]} -> ${pts[2][1]}`);
  const flat = trendPoints([24, 24], 100, 40);
  check("a flat series does not divide by zero", flat.every(p => Number.isFinite(p[1])));
}

console.log("\npopulation rank");
{
  setRanks(JSON.parse(readFileSync("./public/models/percentiles.json", "utf8")));

  check("bands map by age", bandFor(24).band === "18-29" && bandFor(45).band === "40-49");
  check("ages outside the data are clamped and flagged",
        bandFor(70).band === "50-59" && bandFor(70).exact === false);

  const asc = [10, 20, 30, 40, 50];
  check("below the range is 0", percentileOf(asc, 5) === 0);
  check("above the range is 100", percentileOf(asc, 99) === 100);
  check("interpolates between points", percentileOf(asc, 25) === 1.5, `${percentileOf(asc, 25)}`);
  check("a flat run resolves to its middle", percentileOf([10, 20, 20, 20, 50], 20) === 2,
        `${percentileOf([10, 20, 20, 20, 50], 20)}`);

  const lean = rank(12, 10.5, 24, 1);
  const average = rank(24.4, 8.62, 24, 1);      // the male 18-29 median
  const higher = rank(35, 7.5, 24, 1);
  check("a lean man ranks high", lean.leanerThan > 85, `${lean.leanerThan}%`);
  check("the median lands near the middle", Math.abs(average.leanerThan - 50) < 3,
        `${average.leanerThan}%`);
  check("higher body fat ranks lower", higher.leanerThan < 20, `${higher.leanerThan}%`);
  check("leaner always outranks fatter", lean.leanerThan > average.leanerThan &&
        average.leanerThan > higher.leanerThan);
  check("more muscle ranks higher", lean.moreMuscleThan > higher.moreMuscleThan,
        `${lean.moreMuscleThan} vs ${higher.moreMuscleThan}`);
  check("the comparison group is reported", average.n > 1000 && average.band === "18-29",
        `n=${average.n}`);

  const women = rank(28, 7.2, 24, 0);
  check("women are ranked against women", women.leanerThan > 50,
        `28% body fat is lean for a woman: ${women.leanerThan}%`);
  check("the same number ranks differently by sex", women.leanerThan !== rank(28, 7.2, 24, 1).leanerThan);

  check("the label reads like a sentence",
        /^Leaner than \d+% of men aged 18-29$/.test(rankLabel(average, 1)), rankLabel(average, 1));
}

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - history, streaks, badges and population ranking all behave");
