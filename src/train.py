"""Stage 2: anthropometry -> body fat % and appendicular lean mass, DXA as truth.

Evaluated two ways:
  random    - stratified random split, the optimistic number most papers quote
  by_cycle  - train on 2011-2016, test on 2017-2018; simulates deployment on a
              cohort collected later by different examiners. This is the number
              worth trusting.

Baselines (BMI-based Deurenberg, waist-based RFM) are the bar to clear; a model
that cannot beat a two-variable formula is not worth shipping.
"""
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

ROOT = Path(__file__).resolve().parent.parent
RNG = 42

FEATURES = ["sex", "age", "height_cm", "weight_kg", "bmi", "waist_cm",
            "arm_circ_cm", "arm_len_cm", "leg_len_cm",
            "waist_to_height", "waist_to_weight", "arm_to_height",
            "waist_to_arm", "ponderal_index"]
# ethnicity is intentionally NOT a feature - it is used only to audit fairness.

LGB_PARAMS = dict(objective="l1", n_estimators=1200, learning_rate=0.03,
                  num_leaves=31, min_child_samples=40, subsample=0.8,
                  subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
                  verbose=-1, random_state=RNG)


def metrics(y, pred):
    d = pred - y
    return {
        "n": int(len(y)),
        "mae": float(mean_absolute_error(y, pred)),
        "rmse": float(np.sqrt(mean_squared_error(y, pred))),
        "r2": float(r2_score(y, pred)),
        "bias": float(d.mean()),
        # Bland-Altman limits of agreement: the honest "how wrong can it be" range
        "loa_low": float(d.mean() - 1.96 * d.std()),
        "loa_high": float(d.mean() + 1.96 * d.std()),
        "within_2": float((np.abs(d) <= 2).mean() * 100),
        "within_3": float((np.abs(d) <= 3).mean() * 100),
        "within_5": float((np.abs(d) <= 5).mean() * 100),
    }


def deurenberg(d):   # classic BMI-based body fat estimate
    return 1.20 * d.bmi + 0.23 * d.age - 10.8 * d.sex - 5.4


def rfm(d):          # Relative Fat Mass, Woolcott & Bergman 2018
    return np.where(d.sex == 1, 64, 76) - 20 * (d.height_cm / d.waist_cm)


def split(df, how):
    if how == "random":
        strat = pd.qcut(df.bodyfat_pct, 10, labels=False, duplicates="drop")
        tr, te = train_test_split(df, test_size=0.2, random_state=RNG, stratify=strat)
    else:
        tr = df[df.cycle != "2017-2018"]
        te = df[df.cycle == "2017-2018"]
    return tr, te


df = pd.read_csv(ROOT / "data" / "processed" / "nhanes_bodycomp.csv")
results, models = {}, {}

for target, label in [("bodyfat_pct", "BODY FAT %"), ("alm_kg", "APPENDICULAR LEAN MASS (kg)")]:
    d = df[df[target].notna()].copy()
    for how in ["random", "by_cycle"]:
        tr, te = split(d, how)
        Xtr, ytr = tr[FEATURES], tr[target]
        Xte, yte = te[FEATURES], te[target]
        key = f"{target}|{how}"
        res = {}

        if target == "bodyfat_pct":
            res["baseline_deurenberg_bmi"] = metrics(yte, deurenberg(te))
            res["baseline_rfm_waist"] = metrics(yte, rfm(te))

        lin = LinearRegression().fit(Xtr.fillna(Xtr.median()), ytr)
        res["linear_regression"] = metrics(yte, lin.predict(Xte.fillna(Xtr.median())))

        model = lgb.LGBMRegressor(**LGB_PARAMS).fit(Xtr, ytr)
        pred = model.predict(Xte)
        res["lightgbm"] = metrics(yte, pred)

        # conformal-style interval: 80% band from residual quantiles on train folds
        lo = lgb.LGBMRegressor(**{**LGB_PARAMS, "objective": "quantile", "alpha": 0.1}).fit(Xtr, ytr)
        hi = lgb.LGBMRegressor(**{**LGB_PARAMS, "objective": "quantile", "alpha": 0.9}).fit(Xtr, ytr)
        lo_p, hi_p = lo.predict(Xte), hi.predict(Xte)
        res["lightgbm"]["interval_coverage_80"] = float(((yte >= lo_p) & (yte <= hi_p)).mean() * 100)
        res["lightgbm"]["interval_width_mean"] = float((hi_p - lo_p).mean())

        results[key] = res
        if how == "by_cycle":
            models[target] = (model, lo, hi, te, pred)

        print(f"\n{'='*74}\n{label}   split={how}   train={len(tr)} test={len(te)}\n{'='*74}")
        print(f"{'model':<26}{'MAE':>7}{'RMSE':>8}{'R2':>7}{'bias':>8}"
              f"{'95% limits of agreement':>26}{'|err|<3':>9}")
        for name, m in res.items():
            print(f"{name:<26}{m['mae']:>7.2f}{m['rmse']:>8.2f}{m['r2']:>7.3f}{m['bias']:>8.2f}"
                  f"{('[%+.1f, %+.1f]' % (m['loa_low'], m['loa_high'])):>26}{m['within_3']:>8.1f}%")
        b = res["lightgbm"]
        print(f"  -> 80% prediction interval: {b['interval_coverage_80']:.1f}% actual coverage, "
              f"mean width {b['interval_width_mean']:.1f}")

# ---- fairness + failure-mode audit on the deployment split ----------------
model, lo, hi, te, pred = models["bodyfat_pct"]
te = te.copy()
te["pred"] = pred
te["err"] = te.pred - te.bodyfat_pct

print(f"\n{'='*74}\nWHERE THE BODY FAT MODEL FAILS  (2017-2018 held-out cycle)\n{'='*74}")
for name, grp in [("sex", te.sex.map({1: "male", 0: "female"})),
                  ("BMI band", pd.cut(te.bmi, [0, 18.5, 25, 30, 35, 100],
                                      labels=["<18.5", "18.5-25", "25-30", "30-35", "35+"])),
                  ("age band", pd.cut(te.age, [17, 30, 45, 60], labels=["18-30", "31-45", "46-59"])),
                  ("ethnicity", te.ethnicity)]:
    print(f"\n  by {name}:")
    g = te.groupby(grp, observed=True).apply(
        lambda x: pd.Series({"n": len(x), "MAE": np.abs(x.err).mean(), "bias": x.err.mean()}),
        include_groups=False)
    for idx, row in g.iterrows():
        print(f"    {str(idx):<18} n={int(row['n']):>5}  MAE={row['MAE']:.2f}  bias={row['bias']:+.2f}")

print(f"\n{'='*74}\nFEATURE IMPORTANCE (body fat %)\n{'='*74}")
imp = pd.Series(model.feature_importances_, index=FEATURES).sort_values(ascending=False)
for f, v in imp.items():
    print(f"  {f:<20} {'#' * int(60 * v / imp.max())} {int(v)}")

(ROOT / "reports").mkdir(exist_ok=True)
(ROOT / "reports" / "metrics.json").write_text(json.dumps(results, indent=2))
te[["SEQN", "sex", "age", "bmi", "ethnicity", "bodyfat_pct", "pred", "err"]].to_csv(
    ROOT / "reports" / "test_predictions.csv", index=False)
print("\nwrote reports/metrics.json and reports/test_predictions.csv")
