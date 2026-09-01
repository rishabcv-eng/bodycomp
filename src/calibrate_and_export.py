"""Conformalized quantile regression + model export.

Raw LightGBM quantile heads are badly under-calibrated (80% nominal band only
covered ~68% of subjects). Split-conformal calibration (Romano et al., 2019)
widens the band by a constant learned on a held-out calibration set, which
restores the coverage guarantee without retraining anything.
"""
import json
import pickle
import numpy as np
import pandas as pd
import lightgbm as lgb
from pathlib import Path
from sklearn.model_selection import train_test_split

ROOT = Path(__file__).resolve().parent.parent
RNG = 42
ALPHA = 0.20                      # target 80% prediction interval

FEATURES = ["sex", "age", "height_cm", "weight_kg", "bmi", "waist_cm",
            "arm_circ_cm", "arm_len_cm", "leg_len_cm",
            "waist_to_height", "waist_to_weight", "arm_to_height",
            "waist_to_arm", "ponderal_index"]

LGB = dict(n_estimators=1200, learning_rate=0.03, num_leaves=31,
           min_child_samples=40, subsample=0.8, subsample_freq=1,
           colsample_bytree=0.8, reg_lambda=1.0, verbose=-1, random_state=RNG)

df = pd.read_csv(ROOT / "data" / "processed" / "nhanes_bodycomp.csv")
bundle, summary = {}, {}

for target in ["bodyfat_pct", "alm_kg"]:
    d = df[df[target].notna()].copy()
    train_full = d[d.cycle != "2017-2018"]
    test = d[d.cycle == "2017-2018"]
    # calibration set must be disjoint from fitting set for the guarantee to hold
    fit, calib = train_test_split(train_full, test_size=0.25, random_state=RNG)

    point = lgb.LGBMRegressor(objective="l1", **LGB).fit(fit[FEATURES], fit[target])
    lo = lgb.LGBMRegressor(objective="quantile", alpha=ALPHA / 2, **LGB).fit(fit[FEATURES], fit[target])
    hi = lgb.LGBMRegressor(objective="quantile", alpha=1 - ALPHA / 2, **LGB).fit(fit[FEATURES], fit[target])

    # conformity score: how far outside the band each calibration point fell
    c_lo, c_hi, y_c = lo.predict(calib[FEATURES]), hi.predict(calib[FEATURES]), calib[target].values
    scores = np.maximum(c_lo - y_c, y_c - c_hi)
    n = len(scores)
    q = np.quantile(scores, min(1.0, np.ceil((n + 1) * (1 - ALPHA)) / n), method="higher")

    t_lo, t_hi, y_t = lo.predict(test[FEATURES]), hi.predict(test[FEATURES]), test[target].values
    raw_cov = ((y_t >= t_lo) & (y_t <= t_hi)).mean() * 100
    cal_lo, cal_hi = t_lo - q, t_hi + q
    cal_cov = ((y_t >= cal_lo) & (y_t <= cal_hi)).mean() * 100
    pred = point.predict(test[FEATURES])

    summary[target] = {
        "mae": float(np.abs(pred - y_t).mean()),
        "conformal_q": float(q),
        "coverage_before": float(raw_cov),
        "coverage_after": float(cal_cov),
        "width_before": float((t_hi - t_lo).mean()),
        "width_after": float((cal_hi - cal_lo).mean()),
    }
    bundle[target] = {"point": point, "lo": lo, "hi": hi, "q": float(q)}

    print(f"\n{target}")
    print(f"  point MAE (held-out 2017-2018)  {summary[target]['mae']:.2f}")
    print(f"  80% interval coverage  raw {raw_cov:5.1f}%  ->  conformal {cal_cov:5.1f}%")
    print(f"  80% interval width     raw {(t_hi-t_lo).mean():5.2f}   ->  conformal "
          f"{(cal_hi-cal_lo).mean():5.2f}   (q={q:.2f})")

(ROOT / "models").mkdir(exist_ok=True)
with open(ROOT / "models" / "stage2_bodycomp.pkl", "wb") as f:
    pickle.dump({"features": FEATURES, "alpha": ALPHA, "models": bundle}, f)
(ROOT / "reports" / "calibration.json").write_text(json.dumps(summary, indent=2))
print("\nsaved models/stage2_bodycomp.pkl")
