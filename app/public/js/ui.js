// Screen flow, tap-to-select choices and the results visuals.
//
// The redesign lives entirely here and in the markup. app.js still reads and
// writes the same element ids it always has, so the tested measurement and plan
// logic is untouched - this module only decides which screen is showing and
// turns plain form controls into something that feels like an app.

import {
  streak, deltas, badges, trendPoints, clearHistory,
  profiles, activeProfile, setActiveProfile, addProfile, crewBoard,
} from "./progress.js";
import { bodyFatAge, nextMilestone, etaTo, etaLabel } from "./goals.js";
import { shareResult } from "./share.js";

const $ = id => document.getElementById(id);
const SCREENS = ["welcome", "profile", "capture", "results"];
const STEP_OF = { profile: 1, capture: 2, results: 3 };

let current = "welcome";

/** Show one screen. Pushes history so the phone's back gesture works. */
export function go(name, { push = true } = {}) {
  if (!SCREENS.includes(name) || name === current && push) return;

  // leaving the camera screen should never leave the camera running
  if (current === "capture" && name !== "capture" && !$("camera-stop").hidden) {
    $("camera-stop").click();
  }

  // .screen only: <body> also carries data-screen (the CSS keys off it), and a
  // bare [data-screen] selector hid the entire page on the first navigation.
  for (const el of document.querySelectorAll(".screen[data-screen]")) {
    el.hidden = el.dataset.screen !== name;
  }
  current = name;
  document.body.dataset.screen = name;

  const step = STEP_OF[name] || 0;
  document.querySelectorAll(".progress i").forEach((seg, i) => seg.classList.toggle("on", i < step));
  $("stepcount").textContent = step ? `Step ${step} of 3` : "";

  if (name === "profile") renderWho();     // the crew can change between visits
  if (push) history.pushState({ screen: name }, "", `#${name}`);
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- chips --- */

/**
 * Chip groups carry data-bind="<select id>". Tapping one writes the hidden
 * select and fires the same events a real select would, so app.js listeners
 * (plan re-render, upload readiness) run exactly as before.
 */
function bindChips() {
  for (const group of document.querySelectorAll("[data-bind]")) {
    group.addEventListener("click", e => {
      const btn = e.target.closest("[data-value]");
      if (!btn) return;
      const target = $(group.dataset.bind);
      if (target.value === btn.dataset.value) return;
      target.value = btn.dataset.value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      syncChips();
    });
  }
  syncChips();
}

/** Reflect current select values in every chip group bound to them. */
export function syncChips() {
  for (const group of document.querySelectorAll("[data-bind]")) {
    const value = $(group.dataset.bind).value;
    for (const b of group.querySelectorAll("[data-value]")) {
      const on = b.dataset.value === value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  for (const el of document.querySelectorAll("[data-label-for]")) {
    const sel = $(el.dataset.labelFor);
    const opt = sel.options[sel.selectedIndex];
    el.textContent = opt?.dataset.short || opt?.text || "";
  }
}

/* ----------------------------------------------------------------- tabs --- */

export function showTab(name) {
  for (const t of document.querySelectorAll("[data-tab]")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("on", on);
    t.setAttribute("aria-selected", String(on));
  }
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== name;
}

/* ---------------------------------------------------------------- gauge --- */

// ACE body-fat categories. The top band is labelled "Higher" rather than the
// clinical term: this is a fitness app for young adults, and the plan below the
// gauge is what actually helps.
const BANDS = {
  male: {
    max: 40,
    bands: [
      [0, 6, "Essential", "sky", "Very lean. Don't cut any further - fuel for performance instead."],
      [6, 14, "Athletic", "volt", "Typical of people who train seriously."],
      [14, 18, "Fit", "lime", "Lean, healthy and easy to maintain."],
      [18, 25, "Average", "amber", "Where most adults sit. Small changes show fast from here."],
      [25, 40, "Higher", "coral", "Plenty of room to lean out - your plan is built for exactly that."],
    ],
  },
  female: {
    max: 48,
    bands: [
      [0, 14, "Essential", "sky", "Very lean. Don't cut any further - fuel for performance instead."],
      [14, 21, "Athletic", "volt", "Typical of people who train seriously."],
      [21, 25, "Fit", "lime", "Lean, healthy and easy to maintain."],
      [25, 32, "Average", "amber", "Where most adults sit. Small changes show fast from here."],
      [32, 48, "Higher", "coral", "Plenty of room to lean out - your plan is built for exactly that."],
    ],
  },
};

export function bodyFatBand(bf, sex) {
  const { bands } = BANDS[sex];
  const hit = bands.find(([lo, hi]) => bf >= lo && bf < hi) || bands[bands.length - 1];
  return { label: hit[2], tone: hit[3], caption: hit[4] };
}

function renderGauge(bf, sex) {
  const { max, bands } = BANDS[sex];
  const cx = 120, cy = 118, r = 96;
  const pt = f => {
    const a = Math.PI * (1 - f);
    return [+(cx + r * Math.cos(a)).toFixed(2), +(cy - r * Math.sin(a)).toFixed(2)];
  };
  const band = bodyFatBand(bf, sex);
  const gap = 0.012;

  const segs = bands.map(([lo, hi, label, tone]) => {
    const [x0, y0] = pt(lo / max + (lo > 0 ? gap : 0));
    const [x1, y1] = pt(hi / max - (hi < max ? gap : 0));
    const active = label === band.label ? " active" : "";
    return `<path class="seg ${tone}${active}" d="M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}"/>`;
  }).join("");

  const [kx, ky] = pt(Math.max(0, Math.min(1, bf / max)));
  $("bf-gauge").innerHTML = segs + `<circle class="knob" cx="${kx}" cy="${ky}" r="10"/>`;

  const pill = $("bf-category");
  pill.textContent = band.label;
  pill.className = `band ${band.tone}`;
  $("bf-caption").textContent = band.caption;
}

/* --------------------------------------------------------------- macros --- */

/** Stacked calorie bar: how the day's energy splits across the macros. */
export function renderMacros(plan) {
  const p = plan.macros.proteinG * 4, c = plan.macros.carbsG * 4, f = plan.macros.fatG * 9;
  const total = p + c + f || 1;
  const pct = x => Math.round((x / total) * 100);
  $("p-macrobar").innerHTML =
    `<span class="pro" style="width:${pct(p)}%"></span>` +
    `<span class="carb" style="width:${pct(c)}%"></span>` +
    `<span class="fat" style="width:${pct(f)}%"></span>`;
  $("p-pro-pct").textContent = `${pct(p)}%`;
  $("p-carb-pct").textContent = `${pct(c)}%`;
  $("p-fat-pct").textContent = `${pct(f)}%`;
}

/* ----------------------------------------------------- rank and progress --- */

let lastResult = null;            // what the share card draws

/** Where the user sits in their own age and sex band. */
function renderRank(r, sex) {
  const card = $("rank-band").closest(".card");
  if (!r) { card.hidden = true; return; }
  card.hidden = false;
  const group = `${sex === 1 ? "men" : "women"} aged ${r.band}`;
  $("rank-band").textContent = `${r.n.toLocaleString()} people`;
  $("rank-fill").style.left = `${Math.max(0, Math.min(100, r.leanerThan))}%`;
  $("rank-line").innerHTML = `Leaner than <b>${Math.round(r.leanerThan)}%</b> of ${group}`;
  $("rank-note").textContent =
    `Compared with ${r.n.toLocaleString()} ${group} who had real DXA scans (NHANES 2011-2018)` +
    (r.moreMuscleThan != null
      ? `, and carrying more muscle for your height than ${Math.round(r.moreMuscleThan)}% of them` : "") +
    `. ${r.exact ? "" : "Your age is outside the survey, so the nearest band is used. "}` +
    `It's a US survey sample, and leaner isn't automatically healthier.`;
}

function renderTrend(history) {
  const svg = $("trend-chart");
  const W = 320, H = 130;
  if (history.length < 2) {
    svg.innerHTML = `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">` +
      `Scan again in a week to start your trend</text>`;
    $("trend-change").hidden = true;
    $("trend-note").textContent = history.length
      ? "One scan so far. The second is where this starts being useful."
      : "";
    return;
  }
  const values = history.map(e => e.bodyFatPct);
  const pts = trendPoints(values, W, H, 18);
  const line = pts.map(p => p.join(",")).join(" ");
  const lo = Math.min(...values), hi = Math.max(...values);
  svg.innerHTML =
    `<line class="grid" x1="8" y1="${H - 8}" x2="${W - 8}" y2="${H - 8}"/>` +
    `<polygon class="area" points="${pts[0][0]},${H - 8} ${line} ${pts[pts.length - 1][0]},${H - 8}"/>` +
    `<polyline class="line" points="${line}"/>` +
    pts.map((p, i) => {
      const last = i === pts.length - 1;
      return `<circle class="dot${last ? " last" : ""}" cx="${p[0]}" cy="${p[1]}" r="${last ? 5 : 3}"/>`;
    }).join("") +
    `<text class="lab" x="6" y="15">${hi.toFixed(1)}%</text>` +
    `<text class="lab" x="6" y="${H - 15}">${lo.toFixed(1)}%</text>`;

  const d = deltas(history);
  const change = d.sinceFirst.bodyFat;
  const sign = v => (v > 0 ? "+" : "");
  $("trend-change").hidden = false;
  $("trend-change").textContent = `${sign(change)}${change} pts in ${d.sinceFirst.days} days`;
  $("trend-note").textContent =
    `Since your first scan: ${sign(change)}${change} points body fat, ` +
    `${sign(d.sinceFirst.lean)}${d.sinceFirst.lean} kg lean. One scan carries about 2.8 points of ` +
    `error, so the direction across several scans means more than any single step.`;
}

/** Who on this device the next scan belongs to. */
export function renderWho() {
  const box = $("who-chips");
  if (!box) return;
  const active = activeProfile();
  box.innerHTML = profiles().map(p =>
    `<button type="button" class="chip${p.id === active?.id ? " on" : ""}" data-person="${p.id}">${p.name}</button>`
  ).join("") + `<button type="button" class="chip" data-person="new">+ Add</button>`;
}

/** Switching person brings their own numbers back, not the last person's. */
function prefillFrom(person) {
  const last = person?.history?.[person.history.length - 1];
  if (!last) return;
  if (last.heightCm) $("height").value = last.heightCm;
  if (last.weightKg) $("weight").value = last.weightKg;
  if (last.age) $("age").value = last.age;
  if (last.sex != null) $("sex").value = last.sex === 1 ? "male" : "female";
  syncChips();
}

function renderCrew() {
  const rows = crewBoard();
  $("crew-count").textContent = rows.length === 1 ? "just you" : `${rows.length} people`;
  $("crew-list").innerHTML = rows.map(r => {
    const tone = r.change == null ? "none" : r.change < 0 ? "down" : r.change > 0 ? "up" : "none";
    const value = r.change == null ? "no trend yet" : `${r.change > 0 ? "+" : ""}${r.change} pts`;
    const detail = r.scans === 0
      ? "no scans yet"
      : `${r.scans} scan${r.scans === 1 ? "" : "s"}` +
        (r.weeks ? ` · ${r.weeks}w streak` : "") +
        (r.latest != null ? ` · now ${r.latest}%` : "");
    return `<li class="${r.active ? "you" : ""}"><span class="place">${r.place}</span>` +
      `<span class="who"><b>${r.name}</b><span>${detail}</span></span>` +
      `<span class="delta ${tone}">${value}</span></li>`;
  }).join("");
}

/** The next rung up, and when the current trend would reach it. */
function renderMilestone(bf, sex, r, history) {
  const card = $("milestone-card");
  const ms = r ? nextMilestone(bf, sex, r.band) : null;
  if (!ms) { card.hidden = true; return; }
  card.hidden = false;
  $("ms-label").textContent = ms.label;

  if (ms.reached) {
    $("ms-fill").style.left = "100%";
    $("ms-line").innerHTML = "You're in the <b>top tenth</b> of your band";
    $("ms-note").textContent = "No higher rung here - holding it is the work now.";
    return;
  }
  $("ms-fill").style.left = `${Math.max(0, Math.min(100, r.leanerThan))}%`;
  $("ms-line").innerHTML = `<b>${ms.gap}</b> points from ${ms.label}`;
  const eta = etaTo(history, ms.target);
  $("ms-note").textContent =
    `${ms.label} starts at ${ms.target}% body fat for your age and sex. ` +
    (eta ? `At your current rate that's ${etaLabel(eta)}.`
         : "Two scans a week or so apart will turn this into a date.");
}

function renderProgress(history, r) {
  const s = streak(history);
  $("streak-weeks").textContent = s.weeks;
  $("streak-scans").textContent = s.scans;
  $("streak-last").textContent =
    s.daysSinceLast === null ? "--" : s.daysSinceLast === 0 ? "today" : `${s.daysSinceLast}d ago`;
  $("streak-note").textContent = s.weeks >= 2
    ? `${s.weeks} weeks running. Once a week is the right rhythm - body composition doesn't move day to day.`
    : "Scan once a week to build a streak. Weekly, not daily: bodies don't change that fast.";

  renderTrend(history);
  renderCrew();

  const b = badges(history, r);
  $("badge-count").textContent = `${b.earned} of ${b.total}`;
  $("badge-grid").innerHTML = b.badges.map(x =>
    `<div class="badge${x.earned ? " earned" : ""}"><i>${x.icon}</i>` +
    `<div><b>${x.label}</b><span>${x.desc}</span></div></div>`).join("");
}

/** Called by app.js once a result exists. */
export function showResults(bf, sex, ctx = {}) {
  const sexKey = sex === 1 ? "male" : "female";
  renderGauge(bf, sexKey);
  renderRank(ctx.rank, sex);
  renderMilestone(bf, sex, ctx.rank, ctx.history || []);
  renderProgress(ctx.history || [], ctx.rank);

  const age = bodyFatAge(bf, sex);
  const ageLine = $("bf-age");
  ageLine.hidden = !age;
  if (age) {
    ageLine.textContent = `Body-fat age about ${age.coarse}${age.atCeiling ? "+" : ""} ` +
      `— the age whose median body fat matches yours`;
  }

  const d = deltas(ctx.history || []);
  lastResult = {
    bodyFatPct: bf,
    band: bodyFatBand(bf, sexKey).label,
    leanerThan: ctx.rank?.leanerThan ?? null,
    group: ctx.rank ? `${sex === 1 ? "men" : "women"} aged ${ctx.rank.band}` : "",
    fatFreeMassKg: ctx.entry?.fatFreeMassKg ?? 0,
    weightKg: ctx.entry?.weightKg ?? 0,
    scans: (ctx.history || []).length || 1,
    ...(d ? {
      changeLabel: "Since first",
      changeValue: `${d.sinceFirst.bodyFat > 0 ? "+" : ""}${d.sinceFirst.bodyFat}%`,
    } : {}),
  };

  syncChips();
  showTab("overview");
  go("results");
}

/* ----------------------------------------------------------------- wire --- */

function wire() {
  history.replaceState({ screen: "welcome" }, "", location.pathname + location.search);
  addEventListener("popstate", e => go(e.state?.screen || "welcome", { push: false }));

  $("back").addEventListener("click", () => history.back());

  for (const b of document.querySelectorAll("[data-go]")) {
    b.addEventListener("click", () => go(b.dataset.go));
  }

  // details first: every measurement is scaled by height, so it cannot be skipped
  $("to-capture").addEventListener("click", () => {
    const missing = ["height", "weight", "age"].filter(id => !(parseFloat($(id).value) > 0));
    for (const id of ["height", "weight", "age"]) {
      $(id).closest(".num").classList.toggle("invalid", missing.includes(id));
    }
    if (missing.length) { $(missing[0]).focus(); return; }
    go("capture");
  });

  for (const t of document.querySelectorAll("[data-tab]")) t.addEventListener("click", () => showTab(t.dataset.tab));
  for (const b of document.querySelectorAll("[data-tab-go]")) {
    b.addEventListener("click", () => { showTab(b.dataset.tabGo); window.scrollTo(0, $("results").offsetTop); });
  }

  // the one real #sample button lives on the welcome screen; others proxy it
  for (const b of document.querySelectorAll(".js-demo")) b.addEventListener("click", () => $("sample").click());

  const enable = () => document.querySelectorAll(".js-needs-models").forEach(b => { b.disabled = false; });
  document.addEventListener("models-ready", enable);
  if (window.__bodycomp?.ready) enable();

  $("share").addEventListener("click", async () => {
    if (!lastResult) return;
    const btn = $("share");
    const markup = btn.innerHTML;
    btn.disabled = true;
    try {
      const how = await shareResult(lastResult);
      btn.textContent = how === "downloaded" ? "Saved to your photos" :
                        how === "cancelled" ? "Share cancelled" : "Shared";
    } catch (err) {
      console.error(err);
      btn.textContent = "Couldn't create the image";
    }
    setTimeout(() => { btn.innerHTML = markup; btn.disabled = false; }, 2200);
  });

  const askForName = () => {
    const name = prompt("Who's scanning? First name is enough.");
    if (name && name.trim()) { addProfile(name); renderWho(); renderCrew(); }
  };

  $("who-chips").addEventListener("click", e => {
    const b = e.target.closest("[data-person]");
    if (!b) return;
    if (b.dataset.person === "new") { askForName(); return; }
    setActiveProfile(b.dataset.person);
    prefillFrom(activeProfile());
    renderWho();
  });
  $("add-person").addEventListener("click", askForName);

  $("clear-history").addEventListener("click", () => {
    clearHistory();
    renderProgress([], null);
    const btn = $("clear-history");
    btn.textContent = "History deleted";
    setTimeout(() => { btn.textContent = "Delete my history"; }, 2000);
  });

  bindChips();
  renderWho();
}

wire();
