// Scan history, streaks and badges - the reasons to open the app a second time.
//
// A single body-fat number is a demo. The trend is the product: what actually
// keeps someone going is seeing last month's line move. All of it lives in this
// browser's localStorage, so history costs no privacy either - and it means the
// user can wipe it in one tap.
//
// Every function here is pure apart from the storage accessor, which is
// injectable so the whole module is testable in Node.

export const KEY = "bodycomp.history.v1";
const MAX_ENTRIES = 250;
const DAY = 86400000;

const safeStore = store => store || (typeof localStorage !== "undefined" ? localStorage : null);

/** Scans, oldest first. Never throws: corrupt or blocked storage reads as empty. */
export function loadHistory(store) {
  const s = safeStore(store);
  if (!s) return [];
  try {
    const raw = JSON.parse(s.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e && typeof e.ts === "number" && typeof e.bodyFatPct === "number")
              .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/**
 * Record a scan. Two scans within an hour replace each other rather than both
 * landing - people re-run a capture they were not happy with, and that is one
 * measurement, not two.
 */
export function saveScan(entry, store, now = Date.now()) {
  const s = safeStore(store);
  if (!s) return loadHistory(store);
  const row = {
    ts: now,
    bodyFatPct: +entry.bodyFatPct.toFixed(1),
    fatFreeMassKg: +entry.fatFreeMassKg.toFixed(1),
    weightKg: +entry.weightKg.toFixed(1),
    waistCm: entry.waistCm != null ? +entry.waistCm.toFixed(1) : null,
    almi: entry.almi != null ? +entry.almi.toFixed(2) : null,
    age: entry.age,
    sex: entry.sex,
  };
  const history = loadHistory(store).filter(e => now - e.ts > 3600000);
  history.push(row);
  const trimmed = history.slice(-MAX_ENTRIES);
  try {
    s.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full or blocked: the scan still shows, it just is not remembered */
  }
  return trimmed;
}

export function clearHistory(store) {
  const s = safeStore(store);
  try { s?.removeItem(KEY); } catch { /* nothing to do */ }
  return [];
}

/** Monday-based week index, so "this week" means the same thing all week. */
function weekIndex(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7;                       // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return Math.floor(monday.getTime() / (7 * DAY));
}

/**
 * Consecutive weeks with at least one scan, counting back from this week.
 * Weekly rather than daily on purpose: body composition does not move day to
 * day, and a daily streak would push people to scan noise.
 */
export function streak(history, now = Date.now()) {
  if (!history.length) return { weeks: 0, scans: 0, daysSinceLast: null, active: false };
  const weeks = new Set(history.map(e => weekIndex(e.ts)));
  const thisWeek = weekIndex(now);
  // a streak stays alive through the current week even before this week's scan
  let cursor = weeks.has(thisWeek) ? thisWeek : thisWeek - 1;
  let count = 0;
  while (weeks.has(cursor)) { count++; cursor--; }
  const last = history[history.length - 1].ts;
  return {
    weeks: count,
    scans: history.length,
    daysSinceLast: Math.floor((now - last) / DAY),
    active: count > 0,
  };
}

/** Change since the first scan and since the previous one. */
export function deltas(history) {
  if (history.length < 2) return null;
  const first = history[0], prev = history[history.length - 2], last = history[history.length - 1];
  const diff = (a, b) => ({
    bodyFat: +(b.bodyFatPct - a.bodyFatPct).toFixed(1),
    lean: +(b.fatFreeMassKg - a.fatFreeMassKg).toFixed(1),
    weight: +(b.weightKg - a.weightKg).toFixed(1),
    days: Math.max(0, Math.round((b.ts - a.ts) / DAY)),
  });
  return { sinceFirst: diff(first, last), sincePrevious: diff(prev, last) };
}

/**
 * Badges reward what the user controls - showing up, and direction of travel -
 * not an absolute number. Nobody should feel worse for having started further
 * out; the "Top half" style badges are about their own population band.
 */
export function badges(history, rank = null, now = Date.now()) {
  const s = streak(history, now);
  const d = deltas(history);
  const leanest = history.length ? Math.min(...history.map(e => e.bodyFatPct)) : null;
  const gainedLean = d ? d.sinceFirst.lean : 0;

  const all = [
    { id: "first", icon: "1", label: "First scan", desc: "You measured instead of guessing.", earned: s.scans >= 1 },
    { id: "three", icon: "3", label: "Three scans", desc: "Enough points to see a trend.", earned: s.scans >= 3 },
    { id: "month", icon: "4w", label: "Four-week streak", desc: "Scanned four weeks running.", earned: s.weeks >= 4 },
    { id: "quarter", icon: "12w", label: "Twelve-week streak", desc: "A full training block, tracked.", earned: s.weeks >= 12 },
    { id: "fat1", icon: "-1", label: "Down one point", desc: "Body fat is a point below your first scan.", earned: !!d && d.sinceFirst.bodyFat <= -1 },
    { id: "fat3", icon: "-3", label: "Down three points", desc: "A real, visible change.", earned: !!d && d.sinceFirst.bodyFat <= -3 },
    { id: "lean1", icon: "+1", label: "Kilo of muscle", desc: "A kilogram more lean mass than you started with.", earned: gainedLean >= 1 },
    { id: "half", icon: "50", label: "Top half", desc: "Leaner than most people your age and sex.", earned: !!rank && rank.leanerThan >= 50 },
    { id: "quartile", icon: "75", label: "Top quarter", desc: "Leaner than three in four.", earned: !!rank && rank.leanerThan >= 75 },
  ];
  return { badges: all, earned: all.filter(b => b.earned).length, total: all.length, leanest };
}

/**
 * Polyline points for a sparkline, normalised into a w x h box.
 * Returns null when there is nothing to draw yet.
 */
export function trendPoints(values, w, h, pad = 6) {
  if (!values || values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  return values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - lo) / span) * (h - 2 * pad);
    return [+x.toFixed(1), +y.toFixed(1)];
  });
}
