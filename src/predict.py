"""Inference interface for Stage 2 - the function Stage 1 (photo model) will call.

Input is exactly what a front/side photo pair plus a user profile can supply:
height, weight, age, sex and a handful of circumferences.
"""
import pickle
import numpy as np
import pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_B = pickle.load(open(ROOT / "models" / "stage2_bodycomp.pkl", "rb"))


def _row(sex, age, height_cm, weight_kg, waist_cm, arm_circ_cm,
         arm_len_cm=np.nan, leg_len_cm=np.nan):
    bmi = weight_kg / (height_cm / 100) ** 2
    return pd.DataFrame([{
        "sex": sex, "age": age, "height_cm": height_cm, "weight_kg": weight_kg,
        "bmi": bmi, "waist_cm": waist_cm, "arm_circ_cm": arm_circ_cm,
        "arm_len_cm": arm_len_cm, "leg_len_cm": leg_len_cm,
        "waist_to_height": waist_cm / height_cm,
        "waist_to_weight": waist_cm / weight_kg,
        "arm_to_height": arm_circ_cm / height_cm,
        "waist_to_arm": waist_cm / arm_circ_cm,
        "ponderal_index": weight_kg / (height_cm / 100) ** 3,
    }])[_B["features"]]


def predict(**kw):
    """sex: 1=male 0=female. Returns estimates with calibrated 80% intervals."""
    X = _row(**kw)
    out = {}
    for target in ["bodyfat_pct", "alm_kg"]:
        m = _B["models"][target]
        p = float(m["point"].predict(X)[0])
        out[target] = {
            "estimate": round(p, 1),
            "low": round(float(m["lo"].predict(X)[0]) - m["q"], 1),
            "high": round(float(m["hi"].predict(X)[0]) + m["q"], 1),
        }
    w, h = kw["weight_kg"], kw["height_cm"] / 100
    bf = out["bodyfat_pct"]["estimate"]
    alm = out["alm_kg"]["estimate"]
    out["derived"] = {
        "fat_mass_kg": round(w * bf / 100, 1),
        "fat_free_mass_kg": round(w * (1 - bf / 100), 1),
        "almi": round(alm / h ** 2, 2),          # appendicular lean mass index
        "muscle_pct_of_weight": round(100 * alm / w, 1),
    }
    return out


if __name__ == "__main__":
    cases = [
        ("Lean active male, 24",   dict(sex=1, age=24, height_cm=178, weight_kg=70, waist_cm=78, arm_circ_cm=31)),
        ("Average male, 35",       dict(sex=1, age=35, height_cm=175, weight_kg=85, waist_cm=95, arm_circ_cm=33)),
        ("Average female, 30",     dict(sex=0, age=30, height_cm=163, weight_kg=65, waist_cm=80, arm_circ_cm=29)),
        ("Higher-BMI female, 45",  dict(sex=0, age=45, height_cm=160, weight_kg=88, waist_cm=104, arm_circ_cm=36)),
    ]
    for name, kw in cases:
        r = predict(**kw)
        bf, alm, d = r["bodyfat_pct"], r["alm_kg"], r["derived"]
        print(f"\n{name}")
        print(f"  body fat        {bf['estimate']:>5.1f} %   (80% CI {bf['low']:.1f} - {bf['high']:.1f})")
        print(f"  limb muscle     {alm['estimate']:>5.1f} kg  (80% CI {alm['low']:.1f} - {alm['high']:.1f})")
        print(f"  fat mass        {d['fat_mass_kg']:>5.1f} kg      fat-free mass {d['fat_free_mass_kg']:.1f} kg")
        print(f"  ALMI            {d['almi']:>5.2f} kg/m2   muscle {d['muscle_pct_of_weight']:.1f}% of body weight")
