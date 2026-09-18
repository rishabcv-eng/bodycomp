"""Does training on degraded silhouettes close the testB gap?

Stage 1 was trained on BodyM's clean ground-truth masks and it shows: on testA it
beats the height-and-weight baseline by 41%, but on testB - different subjects,
harder conditions - by only 3%. The model leans on clean capture.

reports/mask_robustness.csv already measured which degradations actually cost
accuracy at inference time. This trains on those same degradations, so the model
sees imperfect masks during fitting rather than meeting its first one in the
wild. Clean features for the test splits are untouched, so the comparison is
like for like.

Run:  python src/augmented_stage1.py
"""
import os

# Set before numpy loads, in this process and in every spawned worker: each
# worker only needs one BLAS thread, and a pool of them each opening a full
# thread pool exhausts memory and kills the pool.
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import json
import sys
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

WORKERS = max(2, min(6, (os.cpu_count() or 4) // 2))

import cv2
import numpy as np
import pandas as pd
from PIL import Image
from sklearn.metrics import mean_absolute_error
import lightgbm as lgb

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_silhouette import profile_array, ellipse_circumference, LEVELS

ROOT = Path(__file__).resolve().parent.parent
BODYM = ROOT / "data" / "raw" / "bodym"
PROC = ROOT / "data" / "processed"
AUG_CSV = PROC / "bodym_augmented_features.csv"
TARGETS = ["waist", "hip", "chest", "bicep", "thigh"]

# The degradations that mattered in the robustness study. Dilation is the
# expensive one at inference, so it is the one most worth training against.
AUGS = [("dilate1", "dilate", 1), ("dilate2", "dilate", 2),
        ("erode1", "erode", 1), ("boundary", "boundary", 2), ("soft", "soft", 2)]

PARAMS = dict(objective="l1", n_estimators=200, num_leaves=31, learning_rate=.10,
              min_child_samples=30, subsample=.8, subsample_freq=1,
              colsample_bytree=.7, reg_lambda=1., verbose=-1, random_state=42)


def degrade(mask, mode, k, rng):
    m = mask.astype(np.uint8) * 255
    el = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1,) * 2)
    if mode == "dilate":
        m = cv2.dilate(m, el)
    elif mode == "erode":
        m = cv2.erode(m, el)
    elif mode == "boundary":
        noise = rng.normal(0, 40 * k, m.shape).astype(np.float32)
        m = np.where(cv2.GaussianBlur(m.astype(np.float32) + noise, (0, 0), 3) > 127, 255, 0).astype(np.uint8)
    elif mode == "soft":
        m = np.where(cv2.GaussianBlur(m.astype(np.float32), (0, 0), 4 * k) > 127 + 22 * k, 255, 0).astype(np.uint8)
    return m > 0


def features_from(front, side, height_cm):
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
             torso_circ_mean=circ[torso].mean())
    return d


def build_one(args):
    """All augmented variants for one photo pair."""
    photo_id, height_cm = args
    try:
        front = np.array(Image.open(BODYM / "train" / "mask" / f"{photo_id}.png")) > 0
        side = np.array(Image.open(BODYM / "train" / "mask_left" / f"{photo_id}.png")) > 0
    except Exception:
        return []
    rng = np.random.default_rng(abs(hash(photo_id)) % (2 ** 32))
    rows = []
    for name, mode, k in AUGS:
        d = features_from(degrade(front, mode, k, rng), degrade(side, mode, k, rng), height_cm)
        if d:
            d["photo_id"] = photo_id
            d["aug"] = name
            rows.append(d)
    return rows


def build_augmented(train_meta):
    jobs = list(train_meta[["photo_id", "height_cm"]].itertuples(index=False, name=None))
    print(f"building {len(jobs)} x {len(AUGS)} augmented feature rows on {WORKERS} workers ...")
    out = []
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        for i, rows in enumerate(ex.map(build_one, jobs, chunksize=32), 1):
            out.extend(rows)
            if i % 1000 == 0:
                print(f"  {i}/{len(jobs)} photos", flush=True)
    df = pd.DataFrame(out)
    df.to_csv(AUG_CSV, index=False)
    print(f"-> {AUG_CSV.name}  {df.shape}")
    return df


def main():
    feats = pd.read_csv(PROC / "bodym_silhouette_features.csv")
    meas = pd.concat([pd.read_csv(BODYM / s / "measurements.csv") for s in ["train", "testA", "testB"]],
                     ignore_index=True)
    base = feats.merge(meas, on="subject_id").copy()
    base["sex"] = (base.gender == "male").astype(int)
    base["bmi"] = base.weight_kg / (base.height_cm / 100) ** 2

    sil = [c for c in base.columns if c.startswith(("front_w", "side_w", "circ"))] + \
          ["front_area", "side_area", "front_max_w", "side_max_w",
           "torso_circ_min", "torso_circ_max", "torso_circ_mean"]
    FEATURES = ["sex", "height_cm", "weight_kg", "bmi"] + sil

    train = base[base.split == "train"]
    testA = base[base.split == "testA"]
    testB = base[base.split == "testB"]

    aug = pd.read_csv(AUG_CSV) if AUG_CSV.exists() else build_augmented(train)
    # carry over the per-photo metadata and targets the augmented rows need
    side_cols = ["photo_id", "subject_id", "sex", "height_cm", "weight_kg", "bmi"] + TARGETS
    aug_full = aug.merge(train[side_cols], on="photo_id", how="inner")
    print(f"\nclean train rows {len(train)},  augmented rows {len(aug_full)}")

    results = {}
    print(f"\n{'target':<8}{'split':<8}{'clean-only':>12}{'+augmented':>12}{'change':>10}")
    print("-" * 50)
    for target in TARGETS:
        clean_model = lgb.LGBMRegressor(**PARAMS).fit(train[FEATURES], train[target])
        mixed = pd.concat([train[FEATURES + [target]], aug_full[FEATURES + [target]]], ignore_index=True)
        aug_model = lgb.LGBMRegressor(**PARAMS).fit(mixed[FEATURES], mixed[target])

        for name, split in (("testA", testA), ("testB", testB)):
            a = mean_absolute_error(split[target], clean_model.predict(split[FEATURES]))
            b = mean_absolute_error(split[target], aug_model.predict(split[FEATURES]))
            results[f"{target}|{name}"] = {"clean": round(a, 3), "augmented": round(b, 3),
                                           "delta": round(b - a, 3)}
            flag = "  better" if b < a - 0.005 else ("  worse" if b > a + 0.005 else "  same")
            print(f"{target:<8}{name:<8}{a:>12.3f}{b:>12.3f}{b - a:>+10.3f}{flag}")

    (ROOT / "reports").mkdir(exist_ok=True)
    (ROOT / "reports" / "augmentation.json").write_text(json.dumps(results, indent=1))

    gains = [v["delta"] for k, v in results.items() if k.endswith("testB")]
    print(f"\ntestB mean change: {np.mean(gains):+.3f} cm "
          f"({sum(g < 0 for g in gains)}/{len(gains)} targets improved)")
    print("wrote reports/augmentation.json")


if __name__ == "__main__":
    main()
