// Scan history, streaks and badges - the reasons to open the app a second time.
//
// A single body-fat number is a demo. The trend is the product: what actually
// keeps someone going is seeing last month's line move. All of it lives in this
// browser's localStorage, so history costs no privacy either - and it means the
// user can wipe it in one tap.
//
// Every function here is pure apart from the storage accessor, which is
// injectable so the whole module is testable in Node.

export const KEY = "bodycomp.history.v1";     // v1: one bare array, still read to migrate
export const CREW_KEY = "bodycomp.crew.v2";   // v2: several people sharing one device
const MAX_ENTRIES = 250;
const MAX_PROFILES = 8;
const DAY = 86400000;

const safeStore = store => store || (typeof localStorage !== "undefined" ? localStorage : null);
const tidy = rows => (Array.isArray(rows) ? rows : [])
  .filter(e => e && typeof e.ts === "number" && typeof e.bodyFatPct === "number")
  .sort((a, b) => a.ts - b.ts);
const newId = () => "p" + Math.random().toString(36).slice(2, 9);

/**
 * Everyone stored on this device.
 *
 * Phones get shared - roommates, siblings, a couple training together - so
 * history belongs to a person rather than to the browser. It is also what makes
 * a genuine leaderboard possible with no server and no accounts: the people on
 * the board are the people holding the phone.
 */
export function readCrew(store) {
  const s = safeStore(store);
  if (!s) return { activeId: null, profiles: [] };
  try {
    const raw = JSON.parse(s.getItem(CREW_KEY) || "null");
    if (raw && Array.isArray(raw.profiles) && raw.profiles.length) {
      const profiles = raw.profiles.map(p => ({
        id: p.id || newId(),
        name: String(p.name || "You").slice(0, 18),
        history: tidy(p.history),
      }));
      return { activeId: profiles.some(p => p.id === raw.activeId) ? raw.activeId : profiles[0].id, profiles };
    }
  } catch { /* fall through and rebuild */ }

  let legacy = [];
  try { legacy = tidy(JSON.parse(s.getItem(KEY) || "[]")); } catch { legacy = []; }
  const first = { id: newId(), name: "You", history: legacy };
  return { activeId: first.id, profiles: [first] };
}

function writeCrew(crew, store) {
  const s = safeStore(store);
  if (!s) return crew;
  try { s.setItem(CREW_KEY, JSON.stringify(crew)); } catch { /* full or blocked */ }
  return crew;
}

export function profiles(store) { return readCrew(store).profiles; }

export function activeProfile(store) {
  const c = readCrew(store);
  return c.profiles.find(p => p.id === c.activeId) || c.profiles[0] || null;
}

export function setActiveProfile(id, store) {
  const c = readCrew(store);
  if (c.profiles.some(p => p.id === id)) c.activeId = id;
  return writeCrew(c, store);
}

export function addProfile(name, store) {
  const c = readCrew(store);
  if (c.profiles.length >= MAX_PROFILES) return c;
  const person = {
    id: newId(),
    name: String(name || "").trim().slice(0, 18) || "Friend",
    history: [],
  };
  c.profiles.push(person);
  c.activeId = person.id;
  return writeCrew(c, store);
}

/** Removing the last person is refused: the app always has someone to scan. */
export function removeProfile(id, store) {
  const c = readCrew(store);
  if (c.profiles.length <= 1) return c;
  c.profiles = c.profiles.filter(p => p.id !== id);
  if (!c.profiles.some(p => p.id === c.activeId)) c.activeId = c.profiles[0].id;
  return writeCrew(c, store);
}

/**
 * The board. Ranked on **progress**, not on who is leanest: someone starting
 * further out can still top it, which is the only version of this that
 * motivates rather than discourages.
 */
export function crewBoard(store, now = Date.now()) {
  const c = readCrew(store);
  const rows = c.profiles.map(p => {
    const d = deltas(p.history);
    const s = streak(p.history, now);
    return {
      id: p.id,
      name: p.name,
      active: p.id === c.activeId,
      scans: p.history.length,
      weeks: s.weeks,
      latest: p.history.length ? p.history[p.history.length - 1].bodyFatPct : null,
      change: d ? d.sinceFirst.bodyFat : null,
      leanGain: d ? d.sinceFirst.lean : null,
    };
  });
  rows.sort((a, b) => {
    const ca = a.change ?? Infinity, cb = b.change ?? Infinity;   // no trend yet ranks last
    if (ca !== cb) return ca - cb;
    if (b.weeks !== a.weeks) return b.weeks - a.weeks;
    return b.scans - a.scans;
  });
  return rows.map((r, i) => ({ ...r, place: i + 1 }));
}

/** Scans for whoever is active, oldest first. Never throws. */
export function loadHistory(store) {
  return activeProfile(store)?.history ?? [];
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
    // height is the ruler for every measurement, so it belongs to the person -
    // without it, switching profiles leaves the previous person's height behind
    heightCm: entry.heightCm != null ? +entry.heightCm.toFixed(1) : null,
    waistCm: entry.waistCm != null ? +entry.waistCm.toFixed(1) : null,
    almi: entry.almi != null ? +entry.almi.toFixed(2) : null,
    age: entry.age,
    sex: entry.sex,
  };
  const crew = readCrew(store);
  const person = crew.profiles.find(p => p.id === crew.activeId) || crew.profiles[0];
  if (!person) return [];
  person.history = person.history.filter(e => now - e.ts > 3600000);
  person.history.push(row);
  person.history = person.history.slice(-MAX_ENTRIES);
  writeCrew(crew, store);
  return person.history;
}

/** Wipes the active person's scans, leaving everyone else on the device alone. */
export function clearHistory(store) {
  const crew = readCrew(store);
  const person = crew.profiles.find(p => p.id === crew.activeId) || crew.profiles[0];
  if (person) person.history = [];
  writeCrew(crew, store);
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
