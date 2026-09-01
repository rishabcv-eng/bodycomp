"""How good does the segmenter have to be?

Stage 1 was trained on BodyM's ground-truth masks. In the app the mask comes from
MediaPipe or SAM, which will be imperfect. This script degrades the ground-truth
masks in ways real segmenters actually fail, then re-runs the trained Stage 1
model, producing a spec: the mask IoU required to hold waist error at a target.

Failure modes simulated:
  erode/dilate  systematic under/over-segmentation - a segmenter that consistently
                eats or adds boundary pixels (the most common real bias)
  boundary      jagged edges from a noisy alpha matte, via random morphology
  soft          blurred alpha thresholded at the wrong point - MediaPipe's
                characteristic failure on loose clothing and hair
"""
import pickle, sys
import numpy as np, pandas as pd, cv2
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_silhouette import profile_array, ellipse_circumference, LEVELS

ROOT = Path(__file__).resolve().parent.parent
B = ROOT / "data" / "raw" / "bodym" / "testA"
S1 = pickle.load(open(ROOT / "models" / "stage1_measurements.pkl", "rb"))
RNG = np.random.default_rng(0)
N_SUBJECTS = 600
TARGETS = ["waist", "hip", "chest"]


def degrade(mask: np.ndarray, mode: str, k: int) -> np.ndarray:
    if k == 0:
        return mask
    m = mask.astype(np.uint8) * 255
    if mode == "erode":
        m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1,) * 2))
    elif mode == "dilate":
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1,) * 2))
    elif mode == "boundary":
        noise = RNG.normal(0, 40 * k, m.shape).astype(np.float32)
        m = np.where(cv2.GaussianBlur(m.astype(np.float32) + noise, (0, 0), 3) > 127, 255, 0).astype(np.uint8)
    elif mode == "soft":
        blurred = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 4 * k)
        m = np.where(blurred > 127 + 22 * k, 255, 0).astype(np.uint8)   # mis-thresholded matte
    return m > 0


def iou(a, b):
    return (a & b).sum() / max((a | b).sum(), 1)


def features(front, side, height_cm, weight_kg, sex):
    f = profile_array(front, height_cm)
    s = profile_array(side, height_cm)
    if f is None or s is None:
        return None
    fc, ft = f
    sc, st = s
    circ = ellipse_circumference(fc / 2, sc / 2)
    d = {}
    for i in range(LEVELS):
        d[f"front_w{i:02d}"], d[f"side_w{i:02d}"], d[f"circ{i:02d}"] = fc[i], sc[i], circ[i]
    torso = slice(int(LEVELS * .25), int(LEVELS * .60))
    d.update(front_area=ft.sum(), side_area=st.sum(), front_max_w=fc.max(), side_max_w=sc.max(),
             torso_circ_min=circ[torso].min(), torso_circ_max=circ[torso].max(),
             torso_circ_mean=circ[torso].mean(), sex=sex, height_cm=height_cm,
             weight_kg=weight_kg, bmi=weight_kg / (height_cm / 100) ** 2)
    return d


hwg = pd.read_csv(B / "hwg_metadata.csv")
smap = pd.read_csv(B / "subject_to_photo_map.csv")
truth = pd.read_csv(B / "measurements.csv")
# sample photos, not subjects: differences here are ~0.3 cm and need the statistical power
m = smap.merge(hwg, on="subject_id").merge(truth, on="subject_id")
m = m[[(B / "mask" / f"{r.photo_id}.png").exists() and (B / "mask_left" / f"{r.photo_id}.png").exists()
       for r in m.itertuples()]].sample(min(N_SUBJECTS, len(m)), random_state=1)
print(f"{len(m)} unseen test subjects\n")

masks = [(np.array(Image.open(B / "mask" / f"{r.photo_id}.png")) > 0,
          np.array(Image.open(B / "mask_left" / f"{r.photo_id}.png")) > 0, r) for r in m.itertuples()]

CONDITIONS = [("clean", 0)] + [(mode, k) for mode in ["erode", "dilate", "boundary", "soft"]
                               for k in (1, 2, 3)]
rows = []
for mode, k in CONDITIONS:
    feats, ious = [], []
    for front, side, r in masks:
        df_, ds_ = degrade(front, mode, k), degrade(side, mode, k)
        if df_.sum() < 500 or ds_.sum() < 500:
            continue
        d = features(df_, ds_, r.height_cm, r.weight_kg, 1 if r.gender == "male" else 0)
        if d is None:
            continue
        for tg in TARGETS:
            d[f"_true_{tg}"] = getattr(r, tg)
        feats.append(d)
        ious.append((iou(front, df_) + iou(side, ds_)) / 2)
    X = pd.DataFrame(feats)
    row = {"condition": f"{mode}" + (f" k={k}" if k else ""), "mask_iou": float(np.mean(ious))}
    for t in TARGETS:
        row[t] = float(np.abs(S1["models"][t].predict(X[S1["features"]]) - X[f"_true_{t}"].values).mean())
    rows.append(row)
    print(f"  {row['condition']:<14} IoU {row['mask_iou']:.3f}   " +
          "   ".join(f"{t} {row[t]:.2f}" for t in TARGETS))

res = pd.DataFrame(rows)
res.to_csv(ROOT / "reports" / "mask_robustness.csv", index=False)

clean = res[res.condition == "clean"].iloc[0]
print(f"\n{'='*72}\nSEGMENTER SPEC\n{'='*72}")
deg = res[res.condition != "clean"].copy()
deg["waist_penalty"] = deg.waist - clean.waist
ok = deg[deg.waist_penalty <= 0.5]
print(f"  Clean ground-truth masks .............. waist MAE {clean.waist:.2f} cm")
print(f"  Conditions holding penalty <= 0.5 cm .. min IoU {ok.mask_iou.min():.3f}" if len(ok)
      else "  No degraded condition held the penalty under 0.5 cm")
worst = deg.loc[deg.waist_penalty.idxmax()]
print(f"  Worst simulated failure ............... {worst.condition} at IoU {worst.mask_iou:.3f} "
      f"-> waist MAE {worst.waist:.2f} cm (+{worst.waist_penalty:.2f})")
print(f"\n  Systematic bias hurts far more than boundary noise:")
for mode in ["erode", "dilate", "boundary", "soft"]:
    sub = deg[deg.condition.str.startswith(mode)]
    print(f"    {mode:<10} mean waist penalty {sub.waist_penalty.mean():+.2f} cm "
          f"over IoU {sub.mask_iou.min():.2f}-{sub.mask_iou.max():.2f}")
print("\nwrote reports/mask_robustness.csv")
