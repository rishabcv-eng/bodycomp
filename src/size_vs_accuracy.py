"""Model compression for on-device inference: how small can the trees get?

Full-size models are ~130 MB of tree structure - fine on a laptop, absurd to ship
to a phone browser. This measures the accuracy cost of shrinking them so the
deployed size is a decision with a number attached, not a guess.
"""
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
from sklearn.metrics import mean_absolute_error

ROOT = Path(__file__).resolve().parent.parent
FULL = dict(objective="l1", learning_rate=.03, num_leaves=31, min_child_samples=40,
            subsample=.8, subsample_freq=1, colsample_bytree=.8, reg_lambda=1.,
            verbose=-1, random_state=42, n_estimators=1200)

S2_FEATURES = ["sex", "age", "height_cm", "weight_kg", "bmi", "waist_cm", "arm_circ_cm",
               "arm_len_cm", "leg_len_cm", "waist_to_height", "waist_to_weight",
               "arm_to_height", "waist_to_arm", "ponderal_index"]


def node_count(model):
    d = model.booster_.dump_model()
    def walk(n):
        return 0 if "leaf_index" in n else 1 + walk(n["left_child"]) + walk(n["right_child"])
    return sum(walk(t["tree_structure"]) for t in d["tree_info"])


def bytes_est(model):
    # 13 bytes per internal node (int16 feat, float32 thresh, int32 left, int32 right,
    # uint8 flag) + 4 bytes per leaf
    d = model.booster_.dump_model()
    internal = node_count(model)
    leaves = sum(t["num_leaves"] for t in d["tree_info"])
    return internal * 13 + leaves * 4


# ---- Stage 2: body fat -----------------------------------------------------
df = pd.read_csv(ROOT / "data" / "processed" / "nhanes_bodycomp.csv")
d = df[df.bodyfat_pct.notna()]
tr, te = d[d.cycle != "2017-2018"], d[d.cycle == "2017-2018"]

print("STAGE 2  body fat %  (held-out 2017-2018)")
print(f"  {'config':<28}{'MAE':>7}{'penalty':>9}{'size':>10}")
base = None
for n, leaves, lr in [(1200, 31, .03), (600, 31, .05), (400, 31, .06),
                      (250, 31, .09), (250, 15, .09), (150, 15, .12)]:
    p = {**FULL, "n_estimators": n, "num_leaves": leaves, "learning_rate": lr}
    m = lgb.LGBMRegressor(**p).fit(tr[S2_FEATURES], tr.bodyfat_pct)
    mae = mean_absolute_error(te.bodyfat_pct, m.predict(te[S2_FEATURES]))
    base = base if base is not None else mae
    kb = bytes_est(m) / 1024
    print(f"  {f'{n} trees x {leaves} leaves':<28}{mae:>7.3f}{mae-base:>+9.3f}{kb:>9.0f}K")

# ---- Stage 1: waist --------------------------------------------------------
feats = pd.read_csv(ROOT / "data" / "processed" / "bodym_silhouette_features.csv")
meas = pd.concat([pd.read_csv(ROOT / "data" / "raw" / "bodym" / s / "measurements.csv")
                  for s in ["train", "testA", "testB"]], ignore_index=True)
b = feats.merge(meas, on="subject_id")
b["sex"] = (b.gender == "male").astype(int)
b["bmi"] = b.weight_kg / (b.height_cm / 100) ** 2
SIL = [c for c in b.columns if c.startswith(("front_w", "side_w", "circ"))] + \
      ["front_area", "side_area", "front_max_w", "side_max_w",
       "torso_circ_min", "torso_circ_max", "torso_circ_mean"]
S1_FEATURES = ["sex", "height_cm", "weight_kg", "bmi"] + SIL
btr, bte = b[b.split == "train"], b[b.split == "testA"]

print("\nSTAGE 1  waist  (held-out testA)")
print(f"  {'config':<28}{'MAE':>7}{'penalty':>9}{'size':>10}")
base = None
for n, leaves, lr in [(900, 31, .04), (500, 31, .06), (300, 31, .08),
                      (200, 31, .10), (200, 15, .10), (120, 15, .14)]:
    p = {**FULL, "n_estimators": n, "num_leaves": leaves, "learning_rate": lr,
         "min_child_samples": 30, "colsample_bytree": .7}
    m = lgb.LGBMRegressor(**p).fit(btr[S1_FEATURES], btr.waist)
    mae = mean_absolute_error(bte.waist, m.predict(bte[S1_FEATURES]))
    base = base if base is not None else mae
    kb = bytes_est(m) / 1024
    print(f"  {f'{n} trees x {leaves} leaves':<28}{mae:>7.3f}{mae-base:>+9.3f}{kb:>9.0f}K")
