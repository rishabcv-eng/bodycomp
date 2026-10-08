// The training log screen: pick an exercise, log a set, get told when it was
// a record.
//
// Rendering only - every decision about what counts as a record lives in
// workouts.js, which is tested in Node. This module is the part that has to
// feel fast under a gym's worth of sweat and impatience, so the set sheet
// prefills from last time and the number fields have taps either side.

import {
  logSet, readSets, records, sessions, summary, loggedExercises,
  removeSet, clearWorkouts, formatDuration, prText, e1rmOf,
} from "./workouts.js";
import { EXERCISES, MUSCLES, BY_ID, search } from "./exercises.js";
import { activeProfile } from "./progress.js";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let pickedMuscle = null;
let current = null;              // the exercise whose sheet is open
let onChange = () => {};

const pid = () => activeProfile()?.id || null;

/* ---------------------------------------------------------------- screen --- */

export function renderTrain() {
  const id = pid();
  if (!id) return;

  const s = summary(id, null);
  $("t-streak").textContent = s.streak;
  $("t-week-sets").textContent = s.weekSets;
  $("t-week-vol").textContent = s.weekVolumeKg >= 1000
    ? (s.weekVolumeKg / 1000).toFixed(1) + "t" : s.weekVolumeKg;

  const all = sessions(id, null);
  $("t-empty").hidden = all.length > 0;
  renderSessions(all.slice(0, 12));
  renderRecords(id);
}

function renderSessions(list) {
  $("t-sessions").innerHTML = list.map(ses => {
    const when = relDay(ses.ts);
    const body = ses.exercises.map(ex => {
      const name = ex.exercise?.name || ex.id;
      const metric = ex.exercise?.metric || "load";
      const sets = ex.sets.map(st => `<li>${esc(setText(st, metric))}
        <button class="del" type="button" data-del="${st.ts}" aria-label="Delete set">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`).join("");
      return `<div class="sx">
        <div class="sx-head"><b>${esc(name)}</b><span>${ex.sets.length} ${ex.sets.length === 1 ? "set" : "sets"}</span></div>
        <ul class="sx-sets">${sets}</ul>
      </div>`;
    }).join("");

    return `<div class="card session">
      <div class="card-head">
        <h3>${esc(when)}</h3>
        <span class="pill">${ses.sets} sets${ses.volumeKg ? ` &middot; ${ses.volumeKg.toLocaleString()} kg` : ""}</span>
      </div>
      ${body}
    </div>`;
  }).join("");
}

function renderRecords(id) {
  const logged = loggedExercises(id, null);
  const rows = [];
  for (const { id: exId, exercise } of logged) {
    const r = records(id, exId, null);
    if (!r) continue;
    let best;
    if (r.metric === "time") {
      best = formatDuration(r.duration.seconds) + (r.distance ? ` &middot; ${r.distance.meters} m` : "");
    } else if (r.weight.kg > 0) {
      best = `${r.weight.kg} kg &times; ${r.weight.reps}`;
      if (r.e1rm) best += ` <i>~${e1rmOf(r.e1rm).toFixed(0)} kg max</i>`;
    } else {
      best = `${r.reps.reps} reps`;
    }
    rows.push(`<div class="rec">
      <div><b>${esc(exercise.name)}</b><span>${esc(exercise.muscleName)} &middot; ${r.sets} sets logged</span></div>
      <div class="rec-v">${best}</div>
    </div>`);
  }
  $("t-records-card").hidden = !rows.length;
  $("t-records-count").textContent = `${rows.length} ${rows.length === 1 ? "exercise" : "exercises"}`;
  $("t-records").innerHTML = rows.join("");
}

function setText(st, metric) {
  if (metric === "time") {
    const bits = [formatDuration(st.seconds)];
    if (st.meters) bits.push(`${st.meters} m`);
    return bits.join(" · ");
  }
  if (st.kg > 0) return `${st.kg} kg × ${st.reps}`;
  return `${st.reps} reps`;
}

function relDay(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/* ---------------------------------------------------------------- picker --- */

function openPicker() {
  $("picker").hidden = false;
  document.body.classList.add("sheet-open");
  $("pick-search").value = "";
  pickedMuscle = null;
  renderMuscles();
  renderPickList();
  // Not focused on purpose: a phone keyboard springing up covers the list, and
  // most people pick from recents rather than type.
}

function closePicker() {
  $("picker").hidden = true;
  document.body.classList.remove("sheet-open");
}

function renderMuscles() {
  $("pick-muscles").innerHTML =
    `<button type="button" class="chip${pickedMuscle ? "" : " on"}" data-muscle="">All</button>` +
    MUSCLES.map(m => `<button type="button" class="chip${pickedMuscle === m.id ? " on" : ""}"
      data-muscle="${m.id}">${esc(m.name)}</button>`).join("");
}

function renderPickList() {
  const q = $("pick-search").value;
  const id = pid();
  const out = [];

  // Recently used first, but only when the list is not being filtered -
  // otherwise a search for "squat" would bury the match under yesterday's rows.
  if (!q && !pickedMuscle && id) {
    const recent = loggedExercises(id, null).slice(0, 6);
    if (recent.length) {
      out.push(`<p class="picklabel">Recent</p>`);
      out.push(...recent.map(r => pickRow(r.exercise)));
      out.push(`<p class="picklabel">All exercises</p>`);
    }
  }
  const list = search(q, { muscle: pickedMuscle, limit: 80 });
  out.push(...list.map(pickRow));
  if (!list.length) out.push(`<p class="picknone">Nothing matches &ldquo;${esc(q)}&rdquo;.</p>`);
  $("pick-list").innerHTML = out.join("");
}

const pickRow = e => `<button type="button" class="pickrow" data-ex="${e.id}">
  <span class="pickname">${esc(e.name)}</span>
  <span class="pickmeta">${esc(e.muscleName)} &middot; ${esc(e.equipment)}</span>
</button>`;

/* ------------------------------------------------------------- set sheet --- */

const STEPS = {
  kg: [-5, -2.5, 2.5, 5],
  reps: [-1, 1],
  time: [-30, -10, 10, 30],
  dist: [-100, 100],
};

function openSet(exerciseId) {
  const ex = BY_ID[exerciseId];
  if (!ex) return;
  current = ex;
  closePicker();

  $("set-name").textContent = ex.name;
  $("set-sub").textContent = `${ex.muscleName} · ${ex.equipment}`;

  const timed = ex.metric === "time";
  const cardio = ex.muscle === "cardio";
  $("f-kg").hidden = timed;
  $("f-reps").hidden = timed;
  $("f-time").hidden = !timed;
  $("f-dist").hidden = !timed || !cardio;

  // Prefill from the last set of this exercise: in the gym the next set is
  // usually the same again, and retyping it every time is the whole reason
  // people stop logging by week two.
  const id = pid();
  const mine = id ? readSets(id, null).filter(s => s.exerciseId === exerciseId) : [];
  const last = mine[mine.length - 1];
  if (last) {
    $("in-kg").value = last.kg || "";
    $("in-reps").value = last.reps || "";
    $("in-time").value = last.seconds || "";
    $("in-dist").value = last.meters || "";
    $("set-last").hidden = false;
    $("set-last").innerHTML = `Last time: <b>${esc(setText(last, ex.metric))}</b> &middot; ${esc(relDay(last.ts))}`;
  } else {
    for (const f of ["in-kg", "in-reps", "in-time", "in-dist"]) $(f).value = "";
    $("set-last").hidden = false;
    $("set-last").innerHTML = `First time logging this &mdash; this set becomes the baseline to beat.`;
  }

  renderSteps(timed, cardio);
  renderToday(exerciseId, ex.metric);
  $("setsheet").hidden = false;
  document.body.classList.add("sheet-open");
}

function closeSet() {
  $("setsheet").hidden = true;
  document.body.classList.remove("sheet-open");
  current = null;
}

function renderSteps(timed, cardio) {
  const groups = timed
    ? [["in-time", STEPS.time, "sec"], ...(cardio ? [["in-dist", STEPS.dist, "m"]] : [])]
    : [["in-kg", STEPS.kg, "kg"], ["in-reps", STEPS.reps, "reps"]];
  $("set-steps").innerHTML = groups.map(([target, steps, unit]) =>
    `<div class="steprow"><span>${unit}</span>${steps.map(n =>
      `<button type="button" class="step" data-step="${n}" data-target="${target}">${n > 0 ? "+" : ""}${n}</button>`
    ).join("")}</div>`).join("");
}

function renderToday(exerciseId, metric) {
  const id = pid();
  if (!id) return;
  const today = startOfDay(new Date());
  const mine = readSets(id, null).filter(s => s.exerciseId === exerciseId && s.ts >= today);
  $("set-today").innerHTML = mine.length
    ? `<p class="picklabel">Today</p>` + mine.map((s, i) =>
        `<div class="todayrow"><span>${i + 1}</span><b>${esc(setText(s, metric))}</b>
         <button class="del" type="button" data-del="${s.ts}" aria-label="Delete set">
           <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")
    : "";
}

function saveSet() {
  if (!current) return;
  const id = pid();
  if (!id) return;
  const n = el => parseFloat($(el).value) || 0;

  const entry = current.metric === "time"
    ? { exerciseId: current.id, seconds: n("in-time"), meters: n("in-dist") }
    : { exerciseId: current.id, kg: n("in-kg"), reps: n("in-reps") };

  const result = logSet(id, entry, null);
  if (!result) {
    flash($("set-save"), current.metric === "time" ? "Enter a time first" : "Enter some reps first");
    return;
  }

  renderToday(current.id, current.metric);
  renderTrain();
  onChange();

  if (result.headline) celebrate(result.headline, current);
  else flash($("set-save"), "Set saved");
}

/** Briefly replace a button's label - cheaper than a toast, and it stays put. */
function flash(btn, text) {
  const was = btn.textContent;
  btn.textContent = text;
  btn.classList.add("flashed");
  setTimeout(() => { btn.textContent = was; btn.classList.remove("flashed"); }, 1100);
}

/* ------------------------------------------------------------ the record --- */

function celebrate(pr, exercise) {
  $("pr-title").textContent = pr.label;
  $("pr-value").textContent = prText(pr);
  $("pr-ex").textContent = exercise.name;
  $("pr-was").textContent = pr.previous > 0
    ? `Your best was ${prText({ ...pr, value: pr.previous })}`
    : "";
  $("pr-was").hidden = !(pr.previous > 0);
  $("prpop").hidden = false;
  document.body.classList.add("sheet-open");

  if (navigator.vibrate) { try { navigator.vibrate([18, 60, 28]); } catch { /* unsupported */ } }
  $("pr-ok").focus({ preventScroll: true });
}

const closePr = () => {
  $("prpop").hidden = true;
  if ($("setsheet").hidden && $("picker").hidden) document.body.classList.remove("sheet-open");
};

/* ----------------------------------------------------------------- wiring --- */

export function wireTrain(opts = {}) {
  onChange = opts.onChange || (() => {});

  $("t-add").addEventListener("click", openPicker);
  for (const el of document.querySelectorAll("[data-close-picker]")) el.addEventListener("click", closePicker);
  for (const el of document.querySelectorAll("[data-close-set]")) el.addEventListener("click", closeSet);

  $("pick-search").addEventListener("input", renderPickList);
  $("pick-muscles").addEventListener("click", e => {
    const b = e.target.closest("[data-muscle]");
    if (!b) return;
    pickedMuscle = b.dataset.muscle || null;
    renderMuscles();
    renderPickList();
  });
  $("pick-list").addEventListener("click", e => {
    const b = e.target.closest("[data-ex]");
    if (b) openSet(b.dataset.ex);
  });

  $("set-steps").addEventListener("click", e => {
    const b = e.target.closest("[data-step]");
    if (!b) return;
    const input = $(b.dataset.target);
    const step = parseFloat(b.dataset.step);
    const next = Math.max(0, (parseFloat(input.value) || 0) + step);
    input.value = Math.round(next * 100) / 100;
  });

  $("set-save").addEventListener("click", saveSet);
  $("pr-ok").addEventListener("click", closePr);
  $("prpop").addEventListener("click", e => { if (e.target.id === "prpop") closePr(); });

  // Deleting a set has to work from the sheet and from the session list.
  for (const host of [$("set-today"), $("t-sessions")]) {
    host.addEventListener("click", e => {
      const b = e.target.closest("[data-del]");
      if (!b) return;
      const id = pid();
      if (!id) return;
      removeSet(id, +b.dataset.del, null);
      if (current) renderToday(current.id, current.metric);
      renderTrain();
      onChange();
    });
  }

  $("t-clear").addEventListener("click", () => {
    const id = pid();
    if (!id) return;
    if (!confirm("Delete every set you've logged? This can't be undone.")) return;
    clearWorkouts(id, null);
    renderTrain();
    onChange();
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("prpop").hidden) closePr();
    else if (!$("setsheet").hidden) closeSet();
    else if (!$("picker").hidden) closePicker();
  });
}
