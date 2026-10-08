// The exercise library.
//
// Stored as a table rather than 300 object literals: it stays readable, it
// diffs cleanly when an exercise is added, and it costs ~18 KB instead of ~60.
//
// Each row is  name | muscle | equipment | metric
//
// The metric is the part that matters, because it decides what a personal
// record even means. Three kinds:
//
//   load  weight x reps        a barbell curl. PRs on load, estimated 1RM, volume
//   reps  reps, weight optional a pull-up. PRs on reps, and on reps at added weight
//   time  seconds, distance    a plank or a run. PRs on duration and distance
//
// Getting this wrong is how trackers end up congratulating someone for holding
// a plank "heavier" than last time.

const RAW = `
Barbell Bench Press|chest|barbell
Incline Barbell Bench Press|chest|barbell
Decline Barbell Bench Press|chest|barbell
Close-Grip Bench Press|chest|barbell
Floor Press|chest|barbell
Barbell Pullover|chest|barbell
Spoto Press|chest|barbell
Larsen Press|chest|barbell
Dumbbell Bench Press|chest|dumbbell
Incline Dumbbell Press|chest|dumbbell
Decline Dumbbell Press|chest|dumbbell
Dumbbell Fly|chest|dumbbell
Incline Dumbbell Fly|chest|dumbbell
Dumbbell Pullover|chest|dumbbell
Squeeze Press|chest|dumbbell
Machine Chest Press|chest|machine
Incline Machine Press|chest|machine
Pec Deck|chest|machine
Converging Chest Press|chest|machine
Smith Machine Bench Press|chest|smith
Smith Incline Press|chest|smith
Cable Fly|chest|cable
Low-to-High Cable Fly|chest|cable
High-to-Low Cable Fly|chest|cable
Cable Crossover|chest|cable
Single-Arm Cable Press|chest|cable
Push-Up|chest|bodyweight|reps
Incline Push-Up|chest|bodyweight|reps
Decline Push-Up|chest|bodyweight|reps
Wide Push-Up|chest|bodyweight|reps
Archer Push-Up|chest|bodyweight|reps
Clap Push-Up|chest|bodyweight|reps
Deficit Push-Up|chest|bodyweight|reps
Ring Push-Up|chest|bodyweight|reps
Chest Dip|chest|bodyweight|reps
Weighted Chest Dip|chest|bodyweight|reps

Deadlift|back|barbell
Sumo Deadlift|back|barbell
Rack Pull|back|barbell
Deficit Deadlift|back|barbell
Snatch-Grip Deadlift|back|barbell
Trap Bar Deadlift|back|trap bar
Barbell Row|back|barbell
Pendlay Row|back|barbell
Yates Row|back|barbell
Seal Row|back|barbell
T-Bar Row|back|machine
Chest-Supported Row|back|machine
Machine Row|back|machine
Hammer Strength Row|back|machine
Meadows Row|back|barbell
Dumbbell Row|back|dumbbell
Chest-Supported Dumbbell Row|back|dumbbell
Kroc Row|back|dumbbell
Lat Pulldown|back|cable
Wide-Grip Lat Pulldown|back|cable
Close-Grip Lat Pulldown|back|cable
Reverse-Grip Lat Pulldown|back|cable
Single-Arm Lat Pulldown|back|cable
Straight-Arm Pulldown|back|cable
Seated Cable Row|back|cable
Wide-Grip Seated Row|back|cable
Single-Arm Cable Row|back|cable
Face Pull|back|cable
Pull-Up|back|bodyweight|reps
Chin-Up|back|bodyweight|reps
Weighted Pull-Up|back|bodyweight|reps
Neutral-Grip Pull-Up|back|bodyweight|reps
Wide-Grip Pull-Up|back|bodyweight|reps
Commando Pull-Up|back|bodyweight|reps
Assisted Pull-Up|back|machine|reps
Inverted Row|back|bodyweight|reps
Back Extension|back|bodyweight|reps
Hyperextension|back|machine
Good Morning|back|barbell
Rope Climb|back|bodyweight|reps

Overhead Press|shoulders|barbell
Push Press|shoulders|barbell
Seated Barbell Press|shoulders|barbell
Behind-the-Neck Press|shoulders|barbell
Z Press|shoulders|barbell
Landmine Press|shoulders|barbell
Dumbbell Shoulder Press|shoulders|dumbbell
Seated Dumbbell Press|shoulders|dumbbell
Arnold Press|shoulders|dumbbell
Single-Arm Dumbbell Press|shoulders|dumbbell
Machine Shoulder Press|shoulders|machine
Smith Shoulder Press|shoulders|smith
Lateral Raise|shoulders|dumbbell
Cable Lateral Raise|shoulders|cable
Machine Lateral Raise|shoulders|machine
Leaning Lateral Raise|shoulders|dumbbell
Lu Raise|shoulders|dumbbell
Front Raise|shoulders|dumbbell
Plate Front Raise|shoulders|plate
Cable Front Raise|shoulders|cable
Rear Delt Fly|shoulders|dumbbell
Reverse Pec Deck|shoulders|machine
Cable Rear Delt Fly|shoulders|cable
Bent-Over Lateral Raise|shoulders|dumbbell
Upright Row|shoulders|barbell
Cable Upright Row|shoulders|cable
Pike Push-Up|shoulders|bodyweight|reps
Handstand Push-Up|shoulders|bodyweight|reps

Barbell Shrug|traps|barbell
Dumbbell Shrug|traps|dumbbell
Trap Bar Shrug|traps|trap bar
Cable Shrug|traps|cable
Smith Shrug|traps|smith
Farmer's Walk|traps|dumbbell|time

Barbell Curl|biceps|barbell
EZ-Bar Curl|biceps|ez-bar
Preacher Curl|biceps|ez-bar
Reverse Curl|biceps|barbell
Drag Curl|biceps|barbell
Spider Curl|biceps|dumbbell
21s|biceps|barbell
Dumbbell Curl|biceps|dumbbell
Hammer Curl|biceps|dumbbell
Incline Dumbbell Curl|biceps|dumbbell
Concentration Curl|biceps|dumbbell
Cross-Body Hammer Curl|biceps|dumbbell
Zottman Curl|biceps|dumbbell
Cable Curl|biceps|cable
Cable Hammer Curl|biceps|cable
High Cable Curl|biceps|cable
Machine Preacher Curl|biceps|machine
Bayesian Curl|biceps|cable

Triceps Pushdown|triceps|cable
Rope Pushdown|triceps|cable
Reverse-Grip Pushdown|triceps|cable
Single-Arm Pushdown|triceps|cable
Overhead Cable Extension|triceps|cable
Skull Crusher|triceps|ez-bar
JM Press|triceps|barbell
Dumbbell Overhead Extension|triceps|dumbbell
Dumbbell Kickback|triceps|dumbbell
Tate Press|triceps|dumbbell
Cable Kickback|triceps|cable
Machine Triceps Extension|triceps|machine
Triceps Dip|triceps|bodyweight|reps
Bench Dip|triceps|bodyweight|reps
Machine Dip|triceps|machine|reps
Diamond Push-Up|triceps|bodyweight|reps

Wrist Curl|forearms|barbell
Reverse Wrist Curl|forearms|barbell
Behind-Back Wrist Curl|forearms|barbell
Wrist Roller|forearms|other|time
Plate Pinch|forearms|plate|time
Dead Hang|forearms|bodyweight|time
Farmer's Carry|forearms|dumbbell|time

Back Squat|quads|barbell
High-Bar Squat|quads|barbell
Low-Bar Squat|quads|barbell
Front Squat|quads|barbell
Box Squat|quads|barbell
Pause Squat|quads|barbell
Safety Bar Squat|quads|barbell
Zercher Squat|quads|barbell
Overhead Squat|quads|barbell
Smith Squat|quads|smith
Belt Squat|quads|machine
Hack Squat|quads|machine
V-Squat|quads|machine
Leg Press|quads|machine
Single-Leg Press|quads|machine
Narrow-Stance Leg Press|quads|machine
Leg Extension|quads|machine
Single-Leg Extension|quads|machine
Goblet Squat|quads|dumbbell
Dumbbell Squat|quads|dumbbell
Split Squat|quads|dumbbell
Bulgarian Split Squat|quads|dumbbell
Lunge|quads|dumbbell
Walking Lunge|quads|dumbbell
Reverse Lunge|quads|dumbbell
Curtsy Lunge|quads|dumbbell
Step-Up|quads|dumbbell
Sissy Squat|quads|bodyweight|reps
Pistol Squat|quads|bodyweight|reps
Wall Sit|quads|bodyweight|time

Romanian Deadlift|hamstrings|barbell
Stiff-Leg Deadlift|hamstrings|barbell
Dumbbell Romanian Deadlift|hamstrings|dumbbell
Single-Leg Romanian Deadlift|hamstrings|dumbbell
Lying Leg Curl|hamstrings|machine
Seated Leg Curl|hamstrings|machine
Standing Leg Curl|hamstrings|machine
Nordic Curl|hamstrings|bodyweight|reps
Glute-Ham Raise|hamstrings|bodyweight|reps
Cable Pull-Through|hamstrings|cable

Hip Thrust|glutes|barbell
Single-Leg Hip Thrust|glutes|bodyweight|reps
Machine Hip Thrust|glutes|machine
Glute Bridge|glutes|barbell
Frog Pump|glutes|bodyweight|reps
Cable Glute Kickback|glutes|cable
Machine Glute Kickback|glutes|machine
Hip Abduction|glutes|machine
Standing Hip Abduction|glutes|cable
Sumo Squat|glutes|dumbbell
Banded Lateral Walk|glutes|band|time

Standing Calf Raise|calves|machine
Seated Calf Raise|calves|machine
Leg Press Calf Raise|calves|machine
Smith Calf Raise|calves|smith
Donkey Calf Raise|calves|machine
Single-Leg Calf Raise|calves|bodyweight|reps
Tibialis Raise|calves|bodyweight|reps

Plank|abs|bodyweight|time
Side Plank|abs|bodyweight|time
RKC Plank|abs|bodyweight|time
Hollow Hold|abs|bodyweight|time
L-Sit|abs|bodyweight|time
Dead Bug|abs|bodyweight|reps
Bird Dog|abs|bodyweight|reps
Crunch|abs|bodyweight|reps
Bicycle Crunch|abs|bodyweight|reps
Reverse Crunch|abs|bodyweight|reps
Sit-Up|abs|bodyweight|reps
Decline Sit-Up|abs|bodyweight|reps
V-Up|abs|bodyweight|reps
Cable Crunch|abs|cable
Machine Crunch|abs|machine
Hanging Leg Raise|abs|bodyweight|reps
Hanging Knee Raise|abs|bodyweight|reps
Captain's Chair Raise|abs|machine|reps
Toes-to-Bar|abs|bodyweight|reps
Dragon Flag|abs|bodyweight|reps
Russian Twist|abs|plate|reps
Cable Woodchopper|abs|cable
Pallof Press|abs|cable
Ab Wheel Rollout|abs|other|reps
Landmine Twist|abs|barbell
Mountain Climber|abs|bodyweight|time

Clean and Jerk|olympic|barbell
Power Clean|olympic|barbell
Hang Clean|olympic|barbell
Squat Clean|olympic|barbell
Clean Pull|olympic|barbell
Snatch|olympic|barbell
Power Snatch|olympic|barbell
Hang Snatch|olympic|barbell
Snatch Pull|olympic|barbell
Push Jerk|olympic|barbell
Split Jerk|olympic|barbell
Thruster|olympic|barbell
Kettlebell Swing|olympic|kettlebell
Kettlebell Clean|olympic|kettlebell
Kettlebell Snatch|olympic|kettlebell
Turkish Get-Up|olympic|kettlebell
Goblet Clean|olympic|kettlebell
Man Maker|olympic|dumbbell
Devil Press|olympic|dumbbell
Wall Ball|olympic|other
Medicine Ball Slam|olympic|other|reps
Box Jump|olympic|bodyweight|reps
Broad Jump|olympic|bodyweight|reps
Burpee|olympic|bodyweight|reps
Sled Push|olympic|machine|time
Sled Pull|olympic|machine|time
Battle Ropes|olympic|other|time

Treadmill Run|cardio|machine|time
Outdoor Run|cardio|none|time
Incline Walk|cardio|machine|time
Cycling|cardio|machine|time
Rowing Machine|cardio|machine|time
Elliptical|cardio|machine|time
Stair Climber|cardio|machine|time
Assault Bike|cardio|machine|time
Ski Erg|cardio|machine|time
Jump Rope|cardio|other|time
Swimming|cardio|none|time
Stationary Bike|cardio|machine|time
`;

/** Muscle groups in the order they are shown, with the colour each one uses. */
export const MUSCLES = [
  { id: "chest", name: "Chest", tone: "volt" },
  { id: "back", name: "Back", tone: "sky" },
  { id: "shoulders", name: "Shoulders", tone: "violet" },
  { id: "traps", name: "Traps", tone: "sky" },
  { id: "biceps", name: "Biceps", tone: "amber" },
  { id: "triceps", name: "Triceps", tone: "amber" },
  { id: "forearms", name: "Forearms", tone: "amber" },
  { id: "quads", name: "Quads", tone: "lime" },
  { id: "hamstrings", name: "Hamstrings", tone: "lime" },
  { id: "glutes", name: "Glutes", tone: "lime" },
  { id: "calves", name: "Calves", tone: "lime" },
  { id: "abs", name: "Core", tone: "coral" },
  { id: "olympic", name: "Olympic & power", tone: "violet" },
  { id: "cardio", name: "Cardio", tone: "coral" },
];

const MUSCLE_NAME = Object.fromEntries(MUSCLES.map(m => [m.id, m.name]));

/** "Barbell Bench Press" -> "barbell-bench-press". Stable: it is the stored id. */
export const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const EXERCISES = RAW.trim().split("\n")
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => {
    const [name, muscle, equipment, metric = "load"] = line.split("|");
    return {
      id: slug(name),
      name,
      muscle,
      muscleName: MUSCLE_NAME[muscle] || muscle,
      equipment,
      metric,                       // load | reps | time
    };
  });

export const BY_ID = Object.fromEntries(EXERCISES.map(e => [e.id, e]));

export const EQUIPMENT = [...new Set(EXERCISES.map(e => e.equipment))].sort();

/*
 * The lifts people actually mean.
 *
 * Pure string matching ranks "Bench Dip" above "Barbell Bench Press" for the
 * query "bench", because it starts with the word - which is correct by the
 * letters and wrong by every other measure. Nobody types "bench" looking for a
 * tricep dip. Relevance here is partly about what is popular, and since there
 * is no usage data to learn it from, the staples are simply named.
 */
const STAPLES = new Set([
  "barbell-bench-press", "incline-barbell-bench-press", "dumbbell-bench-press",
  "back-squat", "front-squat", "deadlift", "sumo-deadlift", "romanian-deadlift",
  "overhead-press", "dumbbell-shoulder-press", "lateral-raise",
  "pull-up", "chin-up", "lat-pulldown", "barbell-row", "dumbbell-row", "seated-cable-row",
  "barbell-curl", "dumbbell-curl", "hammer-curl", "triceps-pushdown", "skull-crusher",
  "leg-press", "leg-extension", "lying-leg-curl", "hip-thrust", "standing-calf-raise",
  "push-up", "chest-dip", "plank", "face-pull", "cable-fly", "bulgarian-split-squat",
  "power-clean", "clean-and-jerk", "snatch", "kettlebell-swing", "hanging-leg-raise",
]);

/**
 * Search by name, muscle or equipment.
 *
 * Word starts, not any substring, so "row" does not surface "Narrow-Stance Leg
 * Press". A staple outranks a variation at the same kind of match, and shorter
 * names break the remaining ties.
 */
export function search(query, { muscle = null, limit = 60 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  let pool = muscle ? EXERCISES.filter(e => e.muscle === muscle) : EXERCISES;
  if (!q) {
    // With no query the staples lead, so the default list is useful rather
    // than alphabetical-by-accident.
    return [...pool].sort((a, b) => (STAPLES.has(b.id) - STAPLES.has(a.id))).slice(0, limit);
  }

  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${safe}`);
  const scored = [];
  for (const e of pool) {
    const name = e.name.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (word.test(name)) score = 70;          // prefix or any word start
    else if (name.includes(q)) score = 40;
    else if (e.equipment.startsWith(q) || e.muscleName.toLowerCase().startsWith(q)) score = 20;
    if (!score) continue;
    if (STAPLES.has(e.id)) score += 15;
    if (name.startsWith(q)) score += 5;            // mild, not decisive
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length);
  return scored.slice(0, limit).map(x => x.e);
}
