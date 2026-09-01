"""Compile LightGBM models into a compact binary the browser can evaluate.

Sizes chosen from reports/size_vs_accuracy: Stage 2 is SMALLER and slightly more
accurate at 250x15 than at the original 1200x31 (the big model was overfit);
Stage 1 gives up 0.04 cm of waist accuracy for a 4.5x size cut.

The web Stage 2 deliberately drops arm/leg length. end_to_end.py showed that costs
0.01 points, and it means no NaN ever reaches the browser - removing a whole class
of missing-value parity bugs between LightGBM's C++ and our JS tree walker.

Binary layout, little-endian, one file per model:
    int32   numTrees, numInternal, numLeaves
    int32[] treeRoot     (>=0 internal index, <0 -> leaf index -(v+1))
    int16[] feature
    float64[] threshold
    int32[] left, right  (same encoding as treeRoot)
    uint8[] defaultLeft
    float64[] leafValue
"""
import json, struct, pickle
import numpy as np, pandas as pd, lightgbm as lgb
from pathlib import Path
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "models"
OUT.mkdir(parents=True, exist_ok=True)
RNG = 42
ALPHA = 0.20

S2_FEATURES = ["sex", "age", "height_cm", "weight_kg", "bmi", "waist_cm", "arm_circ_cm",
               "waist_to_height", "waist_to_weight", "arm_to_height", "waist_to_arm",
               "ponderal_index"]
S2_PARAMS = dict(n_estimators=250, num_leaves=15, learning_rate=.09, min_child_samples=40,
                 subsample=.8, subsample_freq=1, colsample_bytree=.8, reg_lambda=1.,
                 verbose=-1, random_state=RNG)
S1_PARAMS = dict(n_estimators=200, num_leaves=31, learning_rate=.10, min_child_samples=30,
                 subsample=.8, subsample_freq=1, colsample_bytree=.7, reg_lambda=1.,
                 verbose=-1, random_state=RNG)


def flatten(model):
    """LightGBM tree dump -> flat arrays."""
    dump = model.booster_.dump_model()
    roots, feat, thr, left, right, dleft, leaves = [], [], [], [], [], [], []

    def add(node):
        if "leaf_value" in node:
            leaves.append(float(node["leaf_value"]))
            return -len(leaves)                     # encode leaf as -(idx+1)
        assert node["decision_type"] == "<=", "categorical splits are not supported"
        assert node["missing_type"] in ("None", "NaN"), node["missing_type"]
        idx = len(feat)
        feat.append(int(node["split_feature"]))
        thr.append(float(node["threshold"]))
        dleft.append(1 if node["default_left"] else 0)
        left.append(0); right.append(0)
        left[idx] = add(node["left_child"])
        right[idx] = add(node["right_child"])
        return idx

    for t in dump["tree_info"]:
        roots.append(add(t["tree_structure"]))
    return roots, feat, thr, left, right, dleft, leaves


def write_bin(model, path: Path):
    roots, feat, thr, left, right, dleft, leaves = flatten(model)
    buf = bytearray()
    buf += struct.pack("<iii", len(roots), len(feat), len(leaves))
    buf += np.asarray(roots, "<i4").tobytes()
    buf += np.asarray(feat, "<i2").tobytes()
    buf += np.asarray(thr, "<f8").tobytes()
    buf += np.asarray(left, "<i4").tobytes()
    buf += np.asarray(right, "<i4").tobytes()
    buf += np.asarray(dleft, "u1").tobytes()
    buf += np.asarray(leaves, "<f8").tobytes()
    path.write_bytes(buf)
    return len(buf)


manifest = {"stage1": {}, "stage2": {}, "s1_features": None, "s2_features": S2_FEATURES}
total = 0

# ---------- Stage 1 ----------
feats = pd.read_csv(ROOT / "data" / "processed" / "bodym_silhouette_features.csv")
meas = pd.concat([pd.read_csv(ROOT / "data" / "raw" / "bodym" / s / "measurements.csv")
                  for s in ["train", "testA", "testB"]], ignore_index=True)
b = feats.merge(meas, on="subject_id").copy()
b["sex"] = (b.gender == "male").astype(int)
b["bmi"] = b.weight_kg / (b.height_cm / 100) ** 2
SIL = [c for c in b.columns if c.startswith(("front_w", "side_w", "circ"))] + \
      ["front_area", "side_area", "front_max_w", "side_max_w",
       "torso_circ_min", "torso_circ_max", "torso_circ_mean"]
S1_FEATURES = ["sex", "height_cm", "weight_kg", "bmi"] + SIL
manifest["s1_features"] = S1_FEATURES
btr = b[b.split == "train"]

py_models = {"stage1": {}, "stage2": {}}
for t in ["waist", "bicep", "hip", "chest", "thigh"]:
    m = lgb.LGBMRegressor(objective="l1", **S1_PARAMS).fit(btr[S1_FEATURES], btr[t])
    n = write_bin(m, OUT / f"s1_{t}.bin")
    manifest["stage1"][t] = f"s1_{t}.bin"
    py_models["stage1"][t] = m
    total += n
    print(f"  s1_{t:<7} {n/1024:>6.0f} KB")

# ---------- Stage 2 ----------
df = pd.read_csv(ROOT / "data" / "processed" / "nhanes_bodycomp.csv")
for target in ["bodyfat_pct", "alm_kg"]:
    d = df[df[target].notna()]
    train_full = d[d.cycle != "2017-2018"]
    fit, calib = train_test_split(train_full, test_size=.25, random_state=RNG)
    point = lgb.LGBMRegressor(objective="l1", **S2_PARAMS).fit(fit[S2_FEATURES], fit[target])
    lo = lgb.LGBMRegressor(objective="quantile", alpha=ALPHA/2, **S2_PARAMS).fit(fit[S2_FEATURES], fit[target])
    hi = lgb.LGBMRegressor(objective="quantile", alpha=1-ALPHA/2, **S2_PARAMS).fit(fit[S2_FEATURES], fit[target])
    c_lo, c_hi, y = lo.predict(calib[S2_FEATURES]), hi.predict(calib[S2_FEATURES]), calib[target].values
    scores = np.maximum(c_lo - y, y - c_hi)
    n_c = len(scores)
    q = float(np.quantile(scores, min(1., np.ceil((n_c+1)*(1-ALPHA))/n_c), method="higher"))

    te = d[d.cycle == "2017-2018"]
    mae = float(np.abs(point.predict(te[S2_FEATURES]) - te[target].values).mean())
    cov = float((((te[target].values >= lo.predict(te[S2_FEATURES]) - q) &
                  (te[target].values <= hi.predict(te[S2_FEATURES]) + q)).mean()) * 100)
    manifest["stage2"][target] = {"point": f"s2_{target}_point.bin", "lo": f"s2_{target}_lo.bin",
                                  "hi": f"s2_{target}_hi.bin", "q": q,
                                  "mae": round(mae, 3), "coverage80": round(cov, 1)}
    for k, m in [("point", point), ("lo", lo), ("hi", hi)]:
        n = write_bin(m, OUT / f"s2_{target}_{k}.bin")
        py_models["stage2"][f"{target}_{k}"] = m
        total += n
    print(f"  s2_{target:<12} MAE {mae:.3f}  80% coverage {cov:.1f}%  q={q:.2f}")

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
pickle.dump(py_models, open(ROOT / "models" / "web_models_python.pkl", "wb"))
print(f"\ntotal weights: {total/1024:.0f} KB across {len(list(OUT.glob('*.bin')))} files")
