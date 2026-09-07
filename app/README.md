# Body Composition — web app

The shipping surface of the pipeline. Details first, then a five-second camera
scan, and body fat and muscle out — **entirely on the device**, no upload, no
API, no account. Photo upload remains as a fallback.

**Easiest: double-click `start-app.cmd`.** It starts the server, restarts it
automatically if it ever stops, and prints the address. Keep that window open -
closing it stops the app.

```bash
npm install        # first time only
npm start          # http://localhost:8742
npm test           # parity, scan, overlay and plan suites
```

### If it stops serving

The app is a plain local server, so "the page will not load" almost always means
the process is gone. It dies when its terminal closes, when the machine sleeps,
or if it was started by a tool whose session ended.

| Symptom | Fix |
|---|---|
| Page will not load at all | Re-run `start-app.cmd` |
| `Port 8742 is already in use` | It is already running - just open the page |
| Need to force the port free | `Get-NetTCPConnection -LocalPort 8742 \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }` |
| Page loads but looks stale | Hard reload with Ctrl+Shift+R |

The server ignores unexpected exceptions rather than exiting, so a single bad
request cannot take it down.

**The permanent fix is to deploy it.** The whole app is static files, so any
static host serves it with no server to babysit - and HTTPS means the camera
works on a phone, which `http://` over LAN never will.

### Camera requirements

The scan needs a camera, and browsers only grant one on **`localhost` or HTTPS**.

- **`http://localhost:8742` in a normal browser** — works, prompts for permission.
- **Over LAN** (`http://<ip>:8742`, e.g. from a phone) — no camera: not a secure
  context. Upload mode still works.
- **Embedded preview panes** (including Claude Code's) block `getUserMedia`
  outright, returning `NotAllowedError` even for `{video: true}`.

When the camera is unavailable the app says which of these applies, switches
itself to Upload, and leaves the sample runner available. It never shows an
empty video box.

**No camera to hand?** The app has a *Run a sample body* button: a real BodyM
subject whose true tape measurements are known, so the output is shown next to
the right answer (waist &minus;0.1 cm, hip &minus;0.5, chest &minus;3.8, thigh +0.0).

Open `/selftest.html` to watch the browser reproduce Python's numbers on a known
input.

## Why a web app

It runs on any phone from a link, which is the whole point for a demo — no store
review, no APK, no install. The inference core (`js/trees.js`, `js/silhouette.js`,
`js/pipeline.js`) is plain ES modules with no framework and no dependencies, so
the same logic ports to React Native or Flutter unchanged if a native app is
wanted later.

## How it fits together

```
photo ─▶ MediaPipe selfie segmentation ─▶ alpha cut at 0.62 ─▶ open3 ─▶ largest blob
                        │                                                    │
                  pose landmarks ──▶ capture quality control ◀───────────────┘
                                              │ (must pass)
                                              ▼
                        silhouette.js ─▶ Stage 1 trees ─▶ waist, hip, chest, thigh, arm
                                                                    │
                                              Stage 2 trees ◀───────┘
                                                    │
                                    body fat %, lean mass, 80% intervals
```

| File | Does |
|---|---|
| `js/trees.js` | LightGBM inference — reads the compact binary, walks the trees |
| `js/silhouette.js` | Port of `extract_silhouette.py`, matched to 4.6e-13 |
| `js/mask.js` | Alpha cut, morphology, largest component, capture QC |
| `js/scan.js` | Live scan: step machine, frame scoring, zoom and lens control |
| `js/overlay.js` | Silhouette contour tracing and the camera overlay |
| `js/plan.js` | Training and nutrition plan from lean mass |
| `js/pipeline.js` | Stage 1 → Stage 2 |
| `js/app.js` | MediaPipe wiring and UI |
| `server.mjs` | Static server — MediaPipe needs correct `.wasm` MIME types |


## The scan

Asking someone to take a good side photo does not work — people misjudge a 90
degree turn. So the app records five seconds while they turn and picks the frames
itself.

**How front and side are identified.** Shoulder span divided by torso length, in
pixels. It runs about 0.75–0.9 square to the camera and 0.1–0.3 in profile, so the
widest frame is the front view and the narrowest is the true side view. Scale
cancels out, so it works at any distance.

**Confirmed positions, not a timed sweep.** The first build recorded five seconds
blind, which gave the user no idea what had been captured. Capture is now a
sequence of positions: the app states one, waits until the pose actually matches,
holds ~1 s while it banks the best three frames, confirms *"Face the camera
captured"*, then advances. Positions are Front, Side, and an optional second Side.

There is no back step: shoulder span cannot distinguish front from back, and the
models were never trained on back silhouettes. Capturing one would be theatre.

**Turn detection.** If the front and side frames differ by less than 0.25 in that
ratio, the user never actually turned, and the scan is rejected rather than
measuring the same view twice.

**Combining frames.** Each front/side pair is measured independently and the
results combined by **median**, so one bad segmentation cannot drag the answer the
way a mean would. The results table shows the frame-to-frame spread. This shrinks
the random component of the error only — systematic model bias is untouched by
averaging, and the app says so.

### A second leak in the same gate

The alignment check reported "good position" for a photo with the arms clearly
down. Cause: the arm and shoulder checks are skipped in profile (where shoulders
overlap and the measures stop meaning anything), gated on that same span ratio —
and this subject's ratio fell below the profile threshold, silently skipping the
check.

During alignment the user faces the camera by definition, so that phase now forces
the check on via `assumeFacing`. Same shape of bug as the pose-model swap: a
heuristic that quietly stopped applying.


## Clothing

The silhouette *is* the measurement, so fabric standing off the body is read as
body. `../src/clothing_effect.py` quantifies it by padding the torso band of
ground-truth silhouettes by a known standoff (400 pairs, 83 unseen subjects):

| Fabric standoff | Waist bias | Body fat shift |
|---|---|---|
| Skin-tight | +0.97 cm | — |
| Fitted t-shirt (0.5 cm) | +2.89 cm | +0.74 pts |
| Normal t-shirt (1 cm) | +5.10 cm | +1.64 pts |
| Loose hoodie (2–3 cm) | +8.72 to +11.60 cm | +2.96 to +3.91 pts |

**About +1.6 body-fat points per centimetre of standoff.** A normal t-shirt nearly
triples waist error, from 1.91 cm to 5.18 cm MAE. It is the same asymmetry the
mask-robustness study found: over-segmentation is the expensive direction, and
loose clothing is over-segmentation.

The error is one-directional — clothing only ever makes you read fatter — so this
is a bias, not noise, and no amount of frame averaging removes it. The app states
the requirement before capture rather than discovering it afterwards.

This is a *simulation* of uniform standoff, not a study of real clothed photos. It
gives the direction and the order of magnitude; it is not a measurement of how any
particular garment behaves.


## The overlay

A pose skeleton looks like a debug view, and a scatter of dots looks decorative.
The overlay now shows **what the measurement actually is**: Stage 1 reads the
body's width at a set of heights and nothing else, so the overlay draws those
chords across the silhouette, each with a tick at either end.

That choice is not only cosmetic. The user can see the exact quantity being taken
off them, and a loose top shows up as visibly wider chords before any number is
produced.

Around it: a hairline contour with a soft glow, thin corner marks, the area
outside the body dimmed so the subject separates from the room, a faint interior
texture, and a sweep that brightens each chord as it passes. Progress is a
hairline along the bottom of the frame rather than a badge.

Chords use the run nearest the body centreline, matching `silhouette.js`, so an
arm held away from the torso does not stretch one.

**No amber anywhere.** The first version used the project's warning colour for
"keep adjusting", which made an ordinary moment look like a fault. The palette is
cool throughout - muted cyan while adjusting, mint on lock, near-white on capture
- and warm tones are reserved for real errors.

## Camera framing

`zoomRange` reports what the hardware actually exposes and drives a slider;
`cameras()` lists the video inputs so a phone's ultra-wide lens can be picked
directly. That distinction matters: zooming **in** narrows the field of view, so
it does not help anyone stand closer — a wider lens does, and on a phone that is a
separate device rather than a zoom value.

Zoom cannot corrupt a measurement. Scale comes from the silhouette's pixel height
against the stated body height, recomputed every frame, so magnification cancels.

## Making it detect real people

The first build was tuned entirely against synthetic poses, and on a real device
it often refused to lock on. Causes, in order of how much they mattered:

**Holding was counted in frames, not seconds.** `HOLD_FRAMES = 18` was documented
as "~1 second", silently assuming 18 fps. The live loop runs pose detection every
frame *plus* a segmentation pass for the overlay, so on a modest machine it drops
to 5-10 fps - where 18 frames means **three seconds** of near-perfect stillness,
with credit decaying on every bad frame. Holding is now wall-clock
(`HOLD_MS = 1200`) accumulated from the real frame delta, so it behaves the same
at 6 fps and at 60. Gaps over 250 ms are ignored, so a backgrounded tab cannot
bank a position it never saw.

**The overlay competed with detection.** A preview segmentation pass now widens
its own interval (up to 600 ms) when it costs more than 45 ms. Decoration must
never starve the checks that are the actual product.

**The preview was cropped.** The video sat in a fixed 3:4 box with
`object-fit: cover` while the model analysed the whole frame, so what the user
saw was not what was measured. Now `contain`.

**A single bad frame reset everything** - both a failed check and a dropped
detection. Credit now decays rather than resetting, up to six consecutive missed
detections are tolerated, and landmarks are smoothed with an EMA before any check
runs.

**Front/side used an unreachable threshold.** See the section above.

## Camera self-check

Iterating on a live-camera feature without a camera is guesswork, and it showed.
`Test my camera` runs five seconds of real detection and reports frame rate,
detection rate, every gating metric against its threshold, and the single check
that failed most often:

```
camera check  5.0s

  resolution      1280 x 720
  frame rate      11.4 fps
  person seen     54/57  (95%)

  body in frame     0.31   need >=0.38   FAILING
  tracking          0.72   need >=0.35   ok
  arms out          0.61   need >=0.45   ok
  shoulders level   0.07   need <=0.22   ok
  facing camera     0.19   need >=0.13   ok

  most common blocker (49 of 54 frames):
    Move the camera back - your feet must be in frame.
```

That turns "it does not work" into a specific number, which is the only way this
gets fixed on hardware the author cannot run.

## The plan

The scan pays for itself here. Standard calorie formulas estimate metabolic rate
from body weight because weight is all they have. With fat-free mass measured, the
app uses **Katch-McArdle**, which predicts from lean tissue — so two people at the
same weight and height get different targets, correctly:

| Same 72.5 kg, 178 cm male | Lean mass | Maintenance |
|---|---|---|
| At 12% body fat | 63.8 kg | **2710 kcal** |
| At 30% body fat | 50.8 kg | **2273 kcal** |

A weight-only formula returns an identical number for both. Protein is likewise
set per kg of *lean* mass, since fat tissue does not need feeding.

Output: calorie and macro targets, a 12-week before/after projection, a seven-day
training split, and a day of food as either a vegetarian or non-vegetarian plan
built from everyday Indian staples.

**Guardrails are part of the feature.** No plan is issued below 1200 kcal (female)
or 1500 kcal (male), never below resting metabolism, and deficits cap at 20%. Very
low or very high body fat, and age 60+, raise a flag pointing at a doctor or
dietitian rather than an app. `plan_test.mjs` covers all of it — 30 checks.

It is general fitness guidance, not medical or dietetic advice, and the page says so.

## Model weights

`public/models/` holds 11 gradient-boosted models as a compact binary, **1.4 MB
total**, generated by `../src/export_web_models.py`.

The deployed models are deliberately smaller than the research ones. Stage 2 at
250 trees × 15 leaves is 10× smaller **and slightly more accurate** than the
original 1200 × 31 — the big model was overfit. Stage 1 gives up 0.04 cm of waist
accuracy for a 4.5× size cut. Full curve in `../reports/size_vs_accuracy`.

Stage 2 here also drops arm and leg length. That costs 0.01 points of body fat
accuracy and means no `NaN` ever reaches the browser, removing a whole class of
missing-value parity bugs between LightGBM's C++ and the JS tree walker.

Inference is **~16 ms** for both stages. Segmentation dominates the wait.

## Parity is tested, not assumed

Porting a model to a second language silently is how wrong numbers ship.

- `parity_test.mjs` — 440 predictions across all 11 models, **exact** to 0.0
- `parity_silhouette.mjs` — 906 feature values across 6 mask pairs, worst 4.6e-13
- `scan_score_test.mjs` — 15 checks on frame scoring and the alignment gate
- `scan_steps_test.mjs` — 18 checks driving the step machine with a fake pose
  source: wrong orientations must not bank frames, and each position must be
  confirmed before the next begins
- `overlay_test.mjs` — 26 checks on contour, mesh and chord geometry against known masks
- `plan_test.mjs` — 30 checks on plan maths, safety floors and diet variants
- `public/selftest.html` — full pipeline plus multi-frame median, in the browser

`ScanController.tick()` processes exactly one frame and the rAF loop just calls
it, so the controller can be driven step by step from a harness where
requestAnimationFrame is throttled or paused.

## Capture quality control

The app refuses to show a number when a photo fails its checks. Whole body in
frame, feet and head visible, arms clear of the torso, shoulders level — plus a
check that the silhouette actually covers the body the pose model found.

That last check exists because of a real bug. Swapping the heavy pose model for
the lite one (to save 25 MB) raised its reported landmark confidence, which
quietly let a photo through that Python had rejected — and the app returned a
123.6 cm hip for a slim subject. Comparing mask extent against pose extent
doesn't depend on landmark confidence, so it holds whichever pose model ships.

## Known limits

- Segmentation quality on real phone photos is still unmeasured — the one
  outstanding gap in the whole project.
- **The live camera path has not been exercised against a real camera.** The state
  machine, frame scoring, selection and turn detection are verified (unit tests,
  plus a synthetic `captureStream` driving the real controller); actual capture
  from device hardware is not.
- **Loose clothing breaks the measurement** - see below. This is a property of
  silhouette-based measurement, not a bug that can be patched out.
- MediaPipe assets are ~22 MB on first load, then browser-cached.
- Not a medical device. Fitness and wellness estimation only.
