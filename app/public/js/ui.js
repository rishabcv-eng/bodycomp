// Screen flow, tap-to-select choices and the results visuals.
//
// The redesign lives entirely here and in the markup. app.js still reads and
// writes the same element ids it always has, so the tested measurement and plan
// logic is untouched - this module only decides which screen is showing and
// turns plain form controls into something that feels like an app.

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

/** Called by app.js once a result exists. */
export function showResults(bf, sex) {
  renderGauge(bf, sex === 1 ? "male" : "female");
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

  bindChips();
}

wire();
