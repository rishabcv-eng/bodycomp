# Body Composition Estimation from Photos

Estimates **body fat %** and **appendicular lean mass** from body measurements,
trained against **real DXA scans** from NHANES.

This is Stage 2 of a two-stage pipeline:

```
front + side photo ──▶ [Stage 1: segmentation + measurement regression] ──▶ circumferences
                                                                                │
        height, weight, age, sex ───────────────────────────────────────────────┤
                                                                                ▼
                                              [Stage 2: this repo] ──▶ body fat %, lean mass
                                                                        + calibrated intervals
```

Stage 2 was built first deliberately: if measurements → body fat cannot be done
accurately, no amount of computer vision saves the product. Both stages are now
trained, and the pipeline runs end to end from a silhouette pair.

**Headline: 2.84% mean absolute error on body fat vs DXA, end to end from photos** —
better than the best published tape-measure formula (3.16%), without the user
owning a tape measure.

## Results

Held-out **2017–2018 NHANES cycle** (n = 2,425) — trained only on 2011–2016, so
the test cohort was collected years later by different examiners.

| Model | MAE | RMSE | R² | 95% limits of agreement | within ±3 pts |
|---|---|---|---|---|---|
| Deurenberg (BMI formula) | 4.58 | 5.89 | 0.533 | −12.0 to +11.0 | 42.3% |
| RFM (waist formula) | 3.16 | 4.00 | 0.784 | −5.9 to +8.8 | 54.8% |
| Linear regression | 2.86 | 3.65 | 0.821 | −7.3 to +7.0 | 60.4% |
| **LightGBM** | **2.70** | **3.46** | **0.839** | **−7.0 to +6.5** | **63.7%** |

Appendicular lean mass: **MAE 1.27 kg**, R² 0.933.

**14% better than the best published formula baseline, 41% better than BMI.**
Bias is −0.23 percentage points — essentially unbiased. For scale, two different
DXA machines disagree with each other by about 1–2 points.

![evaluation](reports/evaluation.png)

### Calibrated uncertainty

Raw LightGBM quantile heads were badly over-confident. Split-conformal
calibration fixes it:

| target | nominal | coverage before | coverage after | width |
|---|---|---|---|---|
| body fat % | 80% | 65.6% | **80.5%** | 6.4 → 8.8 |
| lean mass kg | 80% | 68.6% | **81.4%** | 3.2 → 4.1 |

The app reports "18.2% ± 2.4%", not a bare number that implies false precision.

### Where it fails

| slice | worst group | MAE | bias |
|---|---|---|---|
| BMI | under 18.5 (n=61) | 3.41 | −0.23 |
| sex | female | 2.85 | −0.12 |
| ethnicity | Asian (n=437) | 2.90 | **−1.40** |

Two honest caveats: accuracy degrades at the lean tail where training data is
thin, and the model **under-estimates body fat in Asian subjects by 1.4 points** —
a known limitation of anthropometric methods, which is why race/ethnicity is
excluded from the feature set and used only to audit fairness. Encoding it as a
feature would improve the metric while baking demographic assumptions into a
consumer health product.


## Stage 1 — silhouette → tape measurements

Trained on **BodyM** (2,018 subjects, 6,134 photo pairs), evaluated on BodyM's own
held-out `testA` and `testB` splits — different subjects, so no leakage by construction.

Each silhouette is sampled at 48 normalised heights; at every level the front and
side chord widths define an ellipse, and Ramanujan's formula turns that into a
circumference estimate. The model only has to learn the correction from ellipse
to true tape measurement, not the whole mapping from pixels.

| measurement | h+w+sex only | **+ silhouette** | gain | R² |
|---|---|---|---|---|
| waist | 3.37 | **1.97** | 41% | 0.937 |
| hip | 2.29 | **1.51** | 34% | 0.949 |
| chest | 3.07 | **2.37** | 23% | 0.919 |
| thigh | 1.67 | **1.36** | 19% | 0.884 |
| bicep | 1.29 | **1.15** | 11% | 0.821 |
| shoulder breadth | 0.78 | **0.60** | 23% | 0.903 |

MAE in cm on `testA`. The first column is the ablation that matters: a model given
only height, weight and sex. **The silhouette cuts waist error by 41%**, which is
what justifies the camera existing at all.

On the harder `testB` split waist MAE rises to 3.18 cm and the gain shrinks to 3%.
That gap is the real engineering finding: performance is dominated by capture
conditions, not model capacity, so the app must control pose, distance and
lighting rather than chase a bigger network.

## End-to-end

No public dataset pairs photos with DXA, so the pipeline cannot be scored
directly. Instead the Stage 1 error distribution is propagated through Stage 2 by
Monte Carlo (25 draws) over NHANES test subjects:

| input to Stage 2 | body fat MAE | vs tape |
|---|---|---|
| true tape measurements | 2.70 | — |
| Stage 1 estimates, good conditions | **2.84** | +0.13 |
| Stage 1 estimates, harder conditions | **2.99** | +0.28 |
| *published RFM formula, tape* | *3.16* | — |

Vision costs only **0.13–0.28 points** of body fat accuracy, and the photo pipeline
still beats the best tape-measure formula.

One integration risk was found and closed. Stage 2's strongest single feature was
NHANES upper-leg length, which BodyM does not define the same way (its
`leg-length` is the full leg). Training a *photo-available* Stage 2 variant that
drops limb lengths entirely costs **0.01 points** (2.70 → 2.71) — the tree model had
collinear substitutes. The shipped model uses only quantities Stage 1 can
genuinely supply, so no measurement definition is silently mismatched.


## Segmentation and capture quality

The last gap is closed: `src/segment.py` turns an ordinary camera photo into the
binary silhouette Stage 1 expects, using MediaPipe selfie segmentation plus pose
landmarks. Two design decisions come straight out of the robustness study below.

**The alpha matte is thresholded conservatively** (0.62, not 0.5). Over-segmentation
costs real accuracy; under-segmentation does not. When in doubt, cut in.

**Quality control gates on pose and framing, not mask quality.** The photo path
refuses to return a number when a check fails — a silent failure hands the user a
confidently wrong reading. Checks: whole body in frame, feet and head visible,
arms clear of the torso, shoulders level and square.

### How good does the segmenter have to be?

Ground-truth BodyM masks were degraded in ways real segmenters fail, then fed
through the trained Stage 1 model (600 photo pairs, unseen subjects):

| Failure mode | Mask IoU | Waist MAE | Penalty |
|---|---|---|---|
| clean ground truth | 1.000 | 2.01 | — |
| boundary noise | 0.99 | 2.03 | +0.02 |
| erosion (under-segment) | 0.91–0.97 | 1.89–1.95 | **−0.09** |
| soft/blurred matte | 0.76–0.97 | 1.93–2.60 | +0.16 |
| **dilation (over-segment)** | 0.92–0.97 | 2.14–2.70 | **+0.41** |

**IoU is the wrong metric to tune the segmenter on.** A 0.90-IoU soft matte was
harmless, while a 0.92-IoU dilated mask was the worst case in the study. What
matters is the *direction* of the error: eating a few boundary pixels is free,
adding them is not — loose clothing and hair are the real enemy, not jagged edges.

### Validated how far

`segment.py` was run on a real public-domain full-length photograph. Segmentation
recovered the head and torso but **lost the legs entirely**, where dark trousers met a
dark background — and quality control correctly rejected the photo rather than
returning a number. Forced past the gate, it produced a 122.8 cm hip for a slim
subject, which is exactly the silent failure the gate prevents.

That is a stress test on a low-contrast 19th-century plate, not a representative
one. **Segmentation accuracy on ordinary phone photos is not yet measured** — that
needs a handful of real A-pose captures against a plain background.


## The app

`app/` is a web app that runs the whole pipeline **on the device** — no upload, no
API, no account. Details first, then a guided capture that confirms each position
(front, side, optional second side) before moving on; photo upload stays as a
fallback.

```bash
cd app && npm install && npm start   # http://localhost:8742
```

Chosen as a web app because it runs on any phone from a link, which is what a
demo needs. The inference core is plain ES modules with no framework and no
dependencies, so it ports to React Native or Flutter unchanged.

**11 models, 1.4 MB, ~16 ms inference.** After the scan it also produces a
training and nutrition plan — and that is where measuring body composition pays
off: with fat-free mass known, calories come from **Katch-McArdle** (lean tissue)
rather than a weight-only formula. Two people at 72.5 kg and 178 cm get 2710 vs
2273 kcal depending on how much of that weight is muscle; a weight-only formula
cannot tell them apart. Safety floors, deficit caps and referral flags are tested,
not assumed. The deployed models are deliberately
smaller than the research ones: Stage 2 at 250 trees × 15 leaves is 10× smaller
*and slightly more accurate* than 1200 × 31, because the big model was overfit.

**Parity is tested, not assumed** — porting a model to a second language silently
is how wrong numbers ship:

| Test | Scope | Worst disagreement |
|---|---|---|
| `parity_test.mjs` | 440 predictions, all 11 models | **0.0** (exact) |
| `parity_silhouette.mjs` | 906 feature values, 6 mask pairs | 4.6e-13 |
| `selftest.html` | full pipeline + multi-frame median | exact on all 11 values |
| `scan_score_test.mjs` | frame scoring, alignment gate | 15 checks pass |
| `scan_steps_test.mjs` | stepped capture state machine | 18 checks pass |
| `overlay_test.mjs` | contour and point-mesh geometry | 20 checks pass |
| `plan_test.mjs` | plan maths and safety floors | 30 checks pass |

### A bug worth keeping

Swapping the heavy pose model for the lite one to save 25 MB raised its reported
landmark confidence, which quietly let a photo through that Python had rejected —
and the app returned a **123.6 cm hip for a slim subject**. Tuned thresholds had
silently stopped protecting anything.

The fix does not depend on landmark confidence at all: compare where the pose says
the body ends against where the mask actually ends. If the silhouette stops well
above the ankles, it has lost the legs. Both implementations now carry the check
and both reject the photo.


## Clothing is the biggest practical limit

The silhouette is the measurement, so fabric standing off the body is read as body.
Simulated on 400 pairs from 83 unseen subjects (`src/clothing_effect.py`):

| Fabric standoff | Waist bias | Body fat shift |
|---|---|---|
| Skin-tight | +0.97 cm | — |
| Fitted t-shirt (0.5 cm) | +2.89 cm | +0.74 pts |
| **Normal t-shirt (1 cm)** | **+5.10 cm** | **+1.64 pts** |
| Loose hoodie (2–3 cm) | +8.72 to +11.60 cm | +2.96 to +3.91 pts |

**~+1.6 body-fat points per cm of standoff.** A normal t-shirt nearly triples waist
error (1.91 → 5.18 cm MAE). The error only ever points one way — clothing makes you
read fatter — so it is a bias that frame averaging cannot remove. The app requires
fitted clothing up front rather than discovering the problem afterwards.

## Data

NHANES 2011–2018, four cycles, 11,701 adults aged 18–59 after filtering.
Ground truth is whole-body DXA (`DXDTOPF`), the clinical reference standard.
Hip circumference exists only in 2017–2018, so it is excluded from the main model.

## Running it

```bash
# Stage 2 - NHANES / DXA
bash src/download_nhanes.sh          # 12 files from CDC
python src/build_dataset.py          # merge + filter -> 11,701 adults
python src/train.py                  # baselines, models, fairness audit
python src/calibrate_and_export.py   # conformal calibration

# Stage 1 - BodyM silhouettes
python src/list_bodym.py             # enumerate public S3 bucket
python src/download_bodym.py         # 17,956 masks, resumable
python src/extract_silhouette.py     # ellipse-based shape features
python src/train_stage1.py           # with the h+w+sex ablation

# Segmentation
python src/segment.py PHOTO.jpg      # photo -> silhouette + capture QC
python src/mask_robustness.py        # how good must the segmenter be?

# End to end
python src/end_to_end.py             # error propagation study
python src/pipeline.py               # silhouettes -> body composition
```

```python
from src.predict import predict
predict(sex=1, age=24, height_cm=178, weight_kg=70, waist_cm=78, arm_circ_cm=31)
# body fat 19.8% (80% CI 16.8–20.7), limb muscle 25.1 kg

from src.pipeline import analyse_photos
analyse_photos("front.jpg", "side.jpg", height_cm=178, weight_kg=70, age=24, sex=1)
# {"ok": False, "issues": ["front: arms too close to the body - hold them out..."]}
```

## Next

Models, segmentation and the app are all built and on-device. What remains:

1. **Measure segmentation on real phone photos**, and run the scan against a real
   camera. Both need a phone and five minutes — they are the only unmeasured parts
   of the project.
2. **Deploy it over HTTPS** so the demo is a link rather than a localhost port.
   The camera needs TLS off localhost.

## Disclaimer

Fitness and wellness estimation only. Not a medical device, not diagnostic.
