// The plan turns a measurement into calorie advice, so the guardrails matter
// more than the arithmetic. These check both.
import { buildPlan, bmrFromLeanMass, bmrFromWeight, ACTIVITY, GOALS } from "./public/js/plan.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

const male = { bodyFatPct: 20, fatFreeMassKg: 58, weightKg: 72.5, heightCm: 178, age: 24, sex: 1 };
const female = { bodyFatPct: 30, fatFreeMassKg: 42, weightKg: 60, heightCm: 163, age: 28, sex: 0 };

console.log("energy");
check("Katch-McArdle uses lean mass", Math.round(bmrFromLeanMass(58)) === 1623,
      `${Math.round(bmrFromLeanMass(58))}`);
const p = buildPlan(male, { activity: "moderate", goal: "cut", diet: "nonveg" });
check("TDEE = BMR x activity factor",
      Math.abs(p.tdee - p.bmr * ACTIVITY.moderate.factor) < 1, `${p.tdee}`);
check("a cut lands below maintenance", p.calories < p.tdee, `${p.calories} < ${p.tdee}`);
check("the deficit is capped near 20%",
      Math.abs(1 - p.calories / p.tdee - 0.20) < 0.01, `${(1 - p.calories / p.tdee).toFixed(3)}`);
check("the scan-based BMR is reported against the weight-only one",
      Number.isFinite(p.bmrNaive) && p.bmrDelta === p.bmr - p.bmrNaive);

console.log("\ntwo bodies, same weight and height");
const lean = { ...male, bodyFatPct: 12, fatFreeMassKg: 63.8 };
const fat  = { ...male, bodyFatPct: 30, fatFreeMassKg: 50.75 };
const pl = buildPlan(lean, { activity: "moderate", goal: "maintain", diet: "veg" });
const pf = buildPlan(fat,  { activity: "moderate", goal: "maintain", diet: "veg" });
check("the leaner body gets a higher target", pl.calories > pf.calories,
      `${pl.calories} vs ${pf.calories}`);
check("a weight-only formula could not tell them apart",
      bmrFromWeight(lean) === bmrFromWeight(fat));
check("protein scales with lean mass", pl.macros.proteinG > pf.macros.proteinG,
      `${pl.macros.proteinG} vs ${pf.macros.proteinG} g`);

console.log("\nmacros");
const kcal = p.macros.proteinG * 4 + p.macros.fatG * 9 + p.macros.carbsG * 4;
check("macros add up to the calorie target", Math.abs(kcal - p.calories) <= 5,
      `${kcal} vs ${p.calories}`);
check("carbohydrate is never negative", p.macros.carbsG >= 0);

console.log("\nsafety floors");
const tiny = { bodyFatPct: 34, fatFreeMassKg: 30, weightKg: 46, heightCm: 150, age: 30, sex: 0 };
const pt = buildPlan(tiny, { activity: "sedentary", goal: "cut", diet: "veg" });
check("never prescribes below the female floor", pt.calories >= 1200, `${pt.calories}`);
check("never prescribes below resting metabolism", pt.calories >= pt.bmr, `${pt.calories} vs ${pt.bmr}`);
check("the floor is disclosed to the user", pt.floored === true);
check("hitting the floor raises a flag", pt.flags.some(f => /safe floor/i.test(f)));

const veryLean = { ...male, bodyFatPct: 4, fatFreeMassKg: 66 };
check("very low body fat is flagged",
      buildPlan(veryLean, { activity: "active", goal: "cut", diet: "nonveg" })
        .flags.some(f => /doctor|dietitian/i.test(f)));
const heavy = { ...female, bodyFatPct: 46 };
check("very high body fat points at a professional",
      buildPlan(heavy, { activity: "sedentary", goal: "cut", diet: "veg" })
        .flags.some(f => /doctor|dietitian/i.test(f)));
check("older users get an extra caution",
      buildPlan({ ...male, age: 64 }, { activity: "light", goal: "gain", diet: "veg" })
        .flags.some(f => /Over 60/.test(f)));

console.log("\ndiet");
const veg = buildPlan(male, { activity: "moderate", goal: "cut", diet: "veg" });
const non = buildPlan(male, { activity: "moderate", goal: "cut", diet: "nonveg" });
check("vegetarian plan is vegetarian", veg.meals.label === "Vegetarian");
check("vegetarian plan raises B12", !!veg.meals.b12);
check("non-vegetarian plan differs", non.meals.label === "Non-vegetarian" && !non.meals.b12);
check("both suggest how to close the protein gap",
      veg.meals.gapAdvice.length > 10 && non.meals.gapAdvice.length > 10);
check("no meat appears in the vegetarian plan",
      !/chicken|fish|egg|mutton|prawn/i.test(veg.meals.meals.map(m => m.items).join(" ")),
      veg.meals.meals.map(m => m.items).join(" | ").slice(0, 60));

console.log("\nprojection");
const cut = buildPlan(male, { activity: "moderate", goal: "cut", diet: "nonveg" }).projection;
check("a cut loses fat over 12 weeks", cut.fatChangeKg < 0, `${cut.fatChangeKg} kg`);
check("a cut lowers body fat percent", cut.bodyFatPct < male.bodyFatPct,
      `${male.bodyFatPct} -> ${cut.bodyFatPct}`);
check("a cut holds lean mass flat", cut.leanChangeKg === 0);
const gain = buildPlan(male, { activity: "moderate", goal: "gain", diet: "nonveg" }).projection;
check("a bulk adds lean mass", gain.leanChangeKg > 0, `${gain.leanChangeKg} kg`);
check("a bulk is honest that some fat comes with it", gain.fatChangeKg > 0, `${gain.fatChangeKg} kg`);
check("projections stay physically sane", cut.bodyFatPct > 3 && cut.weightKg > 40);

console.log("\ntraining");
check("a week has seven days", p.training.week.length === 7);
check("the week includes rest", p.training.week.some(d => /rest/i.test(d.focus)));
check("cutting advice stresses keeping the weights heavy", /heavy/i.test(
      buildPlan(male, { activity: "moderate", goal: "cut", diet: "veg" }).training.note));

if (failures) { console.error(`\nFAIL: ${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS - plan maths, safety floors and diet variants all behave");
