"""Stage 1: front + side silhouette -> tape measurements (BodyM).

Evaluated on BodyM's own held-out test splits (testA, testB) - different
subjects from training, so there is no subject leakage by construction.

The ablation is the point of this script. If silhouette features cannot beat a
model given only height, weight and sex, then the camera is decoration and the
honest product is a form with three text boxes. They do beat it - but by how
much, per measurement, is what decides which numbers the app is allowed to show.
"""
import json
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
from sklearn.metrics import mean_absolute_error, r2_score

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ["waist", "hip", "chest", "bicep", "thigh", "shoulder-breadth"]
LGB = dict(objective="l1", n_estimators=900, learning_rate=0.04, num_leaves=31,
           min_child_samples=30, subsample=0.8, subsample_freq=1,
           colsample_bytree=0.7, reg_lambda=1.0, verbose=-1, random_state=42)

feats = pd.read_csv(ROOT / "data" / "processed" / "bodym_silhouette_features.csv")
meas = pd.concat([pd.read_csv(ROOT / "data" / "raw" / "bodym" / s / "measurements.csv")
                  for s in ["train", "testA", "testB"]], ignore_index=True)
df = feats.merge(meas, on="subject_id", how="inner")
df["sex"] = (df.gender == "male").astype(int)
df["bmi"] = df.weight_kg / (df.height_cm / 100) ** 2

SIL = [c for c in df.columns if c.startswith(("front_w", "side_w", "circ"))] + \
      ["front_area", "side_area", "front_max_w", "side_max_w",
       "torso_circ_min", "torso_circ_max", "torso_circ_mean"]
BASIC = ["sex", "height_cm", "weight_kg", "bmi"]

tr = df[df.split == "train"]
tests = {"testA": df[df.split == "testA"], "testB": df[df.split == "testB"]}
print(f"train {len(tr)} photos / {tr.subject_id.nunique()} subjects   "
      f"testA {len(tests['testA'])}   testB {len(tests['testB'])}\n")

results = {}
print(f"{'measurement':<18}{'split':<8}{'h+w+sex':>10}{'+silhouette':>13}{'gain':>8}{'R2':>8}{'<2cm':>8}")
print("-" * 73)
for t in TARGETS:
    d_tr = tr[tr[t].notna()]
    basic_m = lgb.LGBMRegressor(**LGB).fit(d_tr[BASIC], d_tr[t])
    full_m = lgb.LGBMRegressor(**LGB).fit(d_tr[BASIC + SIL], d_tr[t])
    for name, te in tests.items():
        te = te[te[t].notna()]
        b = mean_absolute_error(te[t], basic_m.predict(te[BASIC]))
        p = full_m.predict(te[BASIC + SIL])
        f = mean_absolute_error(te[t], p)
        r2 = r2_score(te[t], p)
        w2 = (np.abs(p - te[t]) <= 2).mean() * 100
        results[f"{t}|{name}"] = {"baseline_mae": b, "silhouette_mae": f,
                                  "gain_pct": 100 * (b - f) / b, "r2": r2, "within_2cm": w2}
        print(f"{t:<18}{name:<8}{b:>10.2f}{f:>13.2f}{100*(b-f)/b:>7.1f}%{r2:>8.3f}{w2:>7.1f}%")
    print()

(ROOT / "reports" / "stage1_metrics.json").write_text(json.dumps(results, indent=2))

# retain the models Stage 2 consumes
import pickle
keep = {}
for t in ["waist", "bicep", "hip", "chest", "thigh"]:
    d_tr = tr[tr[t].notna()]
    keep[t] = lgb.LGBMRegressor(**LGB).fit(d_tr[BASIC + SIL], d_tr[t])
with open(ROOT / "models" / "stage1_measurements.pkl", "wb") as fh:
    pickle.dump({"features": BASIC + SIL, "models": keep}, fh)
print("saved models/stage1_measurements.pkl and reports/stage1_metrics.json")
