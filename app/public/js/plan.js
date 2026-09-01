// Turns a scan into a training and nutrition plan.
//
// The scan earns its keep here. Standard calorie formulas (Mifflin-St Jeor,
// Harris-Benedict) estimate metabolic rate from weight, because that is all
// they have. With fat-free mass measured we can use Katch-McArdle, which
// predicts from lean tissue instead - the tissue that actually burns energy.
// Two people at the same weight and height get different targets, correctly.
//
// Everything here is general fitness guidance, not medical or dietetic advice.
// Guardrails below are deliberate: no plan drops below a floor, and deficits
// are capped, because an app that will happily prescribe 900 kcal is dangerous.

export const ACTIVITY = {
  sedentary:   { label: "Desk job, little exercise",        factor: 1.20 },
  light:       { label: "Light exercise 1-3 days a week",   factor: 1.375 },
  moderate:    { label: "Moderate exercise 3-5 days",       factor: 1.55 },
  active:      { label: "Hard exercise 6-7 days",           factor: 1.725 },
  athlete:     { label: "Physical job or twice-daily training", factor: 1.90 },
};

export const GOALS = {
  cut:      { label: "Lose fat",        pct: -0.20 },
  recomp:   { label: "Recomposition",   pct: -0.08 },
  maintain: { label: "Maintain",        pct: 0.00 },
  gain:     { label: "Build muscle",    pct: +0.12 },
};

// Absolute floors. Below these a plan stops being fitness advice.
const FLOOR = { male: 1500, female: 1200 };

/** Katch-McArdle: BMR from lean tissue, which the scan gives us. */
export function bmrFromLeanMass(fatFreeMassKg) {
  return 370 + 21.6 * fatFreeMassKg;
}

/** Mifflin-St Jeor, kept only to show what the scan buys over guessing. */
export function bmrFromWeight({ sex, weightKg, heightCm, age }) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 1 ? 5 : -161);
}

/**
 * @param scan   { bodyFatPct, fatFreeMassKg, weightKg, heightCm, age, sex }
 * @param choice { activity, goal, diet: "veg"|"nonveg" }
 */
export function buildPlan(scan, choice) {
  const { bodyFatPct, fatFreeMassKg, weightKg, heightCm, age, sex } = scan;
  const activity = ACTIVITY[choice.activity] ?? ACTIVITY.moderate;
  const goal = GOALS[choice.goal] ?? GOALS.maintain;
  const sexKey = sex === 1 ? "male" : "female";

  const bmr = bmrFromLeanMass(fatFreeMassKg);
  const bmrNaive = bmrFromWeight({ sex, weightKg, heightCm, age });
  const tdee = bmr * activity.factor;

  let calories = Math.round(tdee * (1 + goal.pct));
  const floor = FLOOR[sexKey];
  let floored = false;
  if (calories < floor) { calories = floor; floored = true; }
  // never prescribe below resting metabolism either
  if (calories < Math.round(bmr)) { calories = Math.round(bmr); floored = true; }

  // Protein scales with LEAN mass, not total weight: fat tissue does not need
  // feeding. This is the other place the scan beats a weight-only calculator.
  const proteinPerKgLean = goal === GOALS.gain ? 2.2 : 2.4;
  const proteinG = Math.round(fatFreeMassKg * proteinPerKgLean);
  const fatG = Math.round(Math.max(0.8 * weightKg, calories * 0.22 / 9));
  const carbsG = Math.max(0, Math.round((calories - proteinG * 4 - fatG * 9) / 4));

  const weeklyKcal = (tdee - calories) * 7;
  const weeklyKg = weeklyKcal / 7700;          // ~7700 kcal per kg of fat

  return {
    bmr: Math.round(bmr),
    bmrNaive: Math.round(bmrNaive),
    bmrDelta: Math.round(bmr - bmrNaive),
    tdee: Math.round(tdee),
    calories,
    floored,
    macros: { proteinG, fatG, carbsG },
    goal: goal.label,
    activity: activity.label,
    projection: project({ weightKg, bodyFatPct, fatFreeMassKg, weeklyKg, goalKey: choice.goal }),
    training: training(choice.goal),
    meals: mealPlan(proteinG, choice.diet === "veg" ? "veg" : "nonveg"),
    flags: healthFlags({ bodyFatPct, sexKey, age, floored }),
  };
}

/**
 * Twelve-week projection. Fat mass moves with the energy balance; lean mass is
 * held flat except in a surplus, and even then conservatively. Real lean-mass
 * change depends on training age, sleep and genetics, so anything more precise
 * would be invented.
 */
function project({ weightKg, bodyFatPct, fatFreeMassKg, weeklyKg, goalKey }) {
  const weeks = 12;
  const fatMass = weightKg * bodyFatPct / 100;
  let dFat = -weeklyKg * weeks;                       // negative weeklyKg = surplus
  let dLean = 0;
  if (goalKey === "gain") { dLean = 0.12 * weeks; dFat = Math.max(dFat, 0.06 * weeks); }
  if (goalKey === "recomp") { dLean = 0.05 * weeks; }

  const newFat = Math.max(fatMass * 0.35, fatMass + dFat);
  const newLean = fatFreeMassKg + dLean;
  const newWeight = newFat + newLean;
  return {
    weeks,
    weightKg: round1(newWeight),
    bodyFatPct: round1(100 * newFat / newWeight),
    fatFreeMassKg: round1(newLean),
    fatChangeKg: round1(newFat - fatMass),
    leanChangeKg: round1(dLean),
  };
}

function training(goalKey) {
  const base = [
    { day: "Monday", focus: "Lower body", detail: "Squat or leg press, Romanian deadlift, split squat, calf raise" },
    { day: "Tuesday", focus: "Upper push", detail: "Bench or dumbbell press, overhead press, dips, triceps" },
    { day: "Wednesday", focus: "Rest or walk", detail: "30-45 min easy walk" },
    { day: "Thursday", focus: "Lower body", detail: "Deadlift or hip hinge, lunges, leg curl, core" },
    { day: "Friday", focus: "Upper pull", detail: "Pull-up or lat pulldown, row, face pull, biceps" },
    { day: "Saturday", focus: "Conditioning", detail: "" },
    { day: "Sunday", focus: "Rest", detail: "Full rest, prioritise sleep" },
  ];
  const cardio = {
    cut: "30-40 min steady cardio, or 8000-10000 steps",
    recomp: "25-30 min easy cardio",
    maintain: "20-30 min of anything you enjoy",
    gain: "15-20 min light cardio, keep it short",
  };
  base[5].detail = cardio[goalKey] ?? cardio.maintain;
  const note = {
    cut: "Keep the weights heavy. In a deficit, training volume is what tells your body to keep the muscle.",
    recomp: "Progress the load weekly. Recomposition is slow and the scale barely moves - track the scan, not the scale.",
    maintain: "Aim to add a little weight or one more rep each week.",
    gain: "Add load or reps every week. If bodyweight is not moving in a month, eat more.",
  };
  return { week: base, note: note[goalKey] ?? note.maintain };
}

/**
 * Protein-anchored day. Portions are everyday Indian kitchen staples rather
 * than supplements, and the totals are built to hit the protein target.
 */
function mealPlan(proteinG, diet) {
  const veg = {
    label: "Vegetarian",
    meals: [
      { name: "Breakfast", items: "Besan chilla or paneer bhurji (100 g paneer), 1 cup milk", protein: 28 },
      { name: "Lunch", items: "2 roti + 1.5 cups dal or rajma, curd (150 g), salad", protein: 26 },
      { name: "Snack", items: "Roasted chana (50 g) or peanut butter toast, fruit", protein: 14 },
      { name: "Dinner", items: "Soya chunks curry (60 g dry) or tofu, rice or roti, vegetables", protein: 32 },
    ],
    tip: "Soya chunks are the cheapest complete protein on this list - about 52 g of protein per "
       + "100 g dry. Pair dal with rice or roti across the day so the amino acid profile fills out.",
    b12: "A vegetarian plan needs a B12 source: fortified milk, curd, or a supplement.",
  };
  const nonveg = {
    label: "Non-vegetarian",
    meals: [
      { name: "Breakfast", items: "3 eggs (or 2 eggs + 3 whites), 2 toast, 1 cup milk", protein: 30 },
      { name: "Lunch", items: "Chicken breast (150 g) or fish, 2 roti or rice, dal, salad", protein: 42 },
      { name: "Snack", items: "Curd (200 g) or a boiled egg, fruit", protein: 14 },
      { name: "Dinner", items: "Fish or chicken (150 g), vegetables, roti or rice", protein: 38 },
    ],
    tip: "Chicken breast and eggs do the heavy lifting. Fish twice a week covers omega-3, which "
       + "most Indian diets are short on.",
    b12: null,
  };
  const chosen = diet === "veg" ? veg : nonveg;
  const covered = chosen.meals.reduce((s, m) => s + m.protein, 0);
  const gap = proteinG - covered;
  return {
    ...chosen,
    coveredProtein: covered,
    gap: Math.round(gap),
    gapAdvice: gap > 15
      ? `About ${Math.round(gap)} g short of your target. Add a scoop of whey, 100 g more paneer `
        + `or curd, or an extra portion at lunch.`
      : gap < -15
        ? `This sample runs about ${Math.round(-gap)} g over your target - trim portions slightly.`
        : "This sample day lands close to your protein target.",
  };
}

/** Cases where an app should stop and point at a human. */
function healthFlags({ bodyFatPct, sexKey, age, floored }) {
  const flags = [];
  const veryLow = sexKey === "male" ? 6 : 14;
  const high = sexKey === "male" ? 32 : 42;
  if (bodyFatPct < veryLow) {
    flags.push("Your estimate is very low. Cutting further is not advisable - speak to a doctor "
             + "or sports dietitian before reducing calories.");
  }
  if (bodyFatPct > high) {
    flags.push("Your estimate is in a range where a doctor or dietitian should guide the plan, "
             + "rather than an app.");
  }
  if (floored) {
    flags.push("Your target was raised to a safe floor. A larger deficit than this is not "
             + "something to run without supervision.");
  }
  if (age >= 60) {
    flags.push("Over 60, protein needs and training tolerance differ. Check with your doctor "
             + "before starting a new programme.");
  }
  return flags;
}

const round1 = x => Math.round(x * 10) / 10;
