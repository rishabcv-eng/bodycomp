"""Merge NHANES demographics, body measures and whole-body DXA into a modelling table.

Stage 2 of the body-composition pipeline learns
    anthropometry (+ age, sex) -> body fat %, appendicular lean mass
using DXA as ground truth. NHANES is the only large public source that pairs
real DXA scans with tape-measure anthropometry.

Note: race/ethnicity is carried through for FAIRNESS EVALUATION ONLY and is
deliberately excluded from the model features (see FEATURES in train.py).
"""
import pandas as pd
import numpy as np
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
OUT = Path(__file__).resolve().parent.parent / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)

CYCLES = {"G": "2011-2012", "H": "2013-2014", "I": "2015-2016", "J": "2017-2018"}

DEMO_COLS = ["SEQN", "RIAGENDR", "RIDAGEYR", "RIDRETH3", "RIDEXPRG", "SDDSRVYR"]
BMX_COLS = ["SEQN", "BMXWT", "BMXHT", "BMXBMI", "BMXWAIST", "BMXHIP",
            "BMXARMC", "BMXARML", "BMXLEG"]
# DXDTOPF total body fat %; DXDTOFAT/DXDTOLE grams; limb lean -> appendicular lean mass
DXX_COLS = ["SEQN", "DXDTOPF", "DXDTOFAT", "DXDTOLE", "DXDTOBMC", "DXAEXSTS",
            "DXDLALE", "DXDRALE", "DXDLLLE", "DXDRLLE"]


def load(prefix: str, letter: str, cols: list[str]) -> pd.DataFrame:
    df = pd.read_sas(RAW / f"{prefix}_{letter}.XPT")
    present = [c for c in cols if c in df.columns]
    df = df[present].copy()
    for c in cols:                      # keep schema stable across cycles
        if c not in df.columns:
            df[c] = np.nan
    return df[cols]


frames = []
for letter, cycle in CYCLES.items():
    demo = load("DEMO", letter, DEMO_COLS)
    bmx = load("BMX", letter, BMX_COLS)
    dxx = load("DXX", letter, DXX_COLS)
    df = demo.merge(bmx, on="SEQN", how="inner").merge(dxx, on="SEQN", how="inner")
    df["cycle"] = cycle
    frames.append(df)
    print(f"{cycle}: merged {len(df):>5} rows")

raw = pd.concat(frames, ignore_index=True)
print(f"\ncombined: {len(raw)} rows")

df = raw.copy()
steps = []


def keep(mask, label):
    global df
    before = len(df)
    df = df[mask(df)].copy()
    steps.append((label, before, len(df), before - len(df)))


keep(lambda d: d.DXAEXSTS == 1, "DXA scan complete & valid")
keep(lambda d: d.DXDTOPF.notna(), "body fat % present")
keep(lambda d: d.RIDAGEYR.between(18, 59), "adults 18-59 (DXA capped at 59)")
keep(lambda d: d.RIDEXPRG != 1, "not pregnant at exam")
keep(lambda d: d[["BMXWT", "BMXHT", "BMXWAIST", "BMXARMC"]].notna().all(axis=1),
     "core anthropometry complete")
keep(lambda d: d.DXDTOPF.between(3, 65), "body fat % physiologically plausible")

print("\nfiltering:")
for label, before, after, dropped in steps:
    print(f"  {label:<38} {before:>6} -> {after:>6}  (-{dropped})")

# ---- targets -------------------------------------------------------------
df["bodyfat_pct"] = df.DXDTOPF
df["fat_mass_kg"] = df.DXDTOFAT / 1000.0
df["lean_mass_kg"] = df.DXDTOLE / 1000.0
limbs = ["DXDLALE", "DXDRALE", "DXDLLLE", "DXDRLLE"]
df["alm_kg"] = df[limbs].sum(axis=1) / 1000.0          # appendicular lean mass
df.loc[df[limbs].isna().any(axis=1), "alm_kg"] = np.nan
# ALM index normalises muscle for frame size; the basis of sarcopenia cutoffs
df["almi"] = df.alm_kg / (df.BMXHT / 100.0) ** 2
df["muscle_pct"] = 100.0 * df.alm_kg / df.BMXWT

# ---- features ------------------------------------------------------------
df["sex"] = (df.RIAGENDR == 1).astype(int)             # 1 = male
df["age"] = df.RIDAGEYR
df["height_cm"] = df.BMXHT
df["weight_kg"] = df.BMXWT
df["bmi"] = df.BMXBMI.fillna(df.BMXWT / (df.BMXHT / 100.0) ** 2)
df["waist_cm"] = df.BMXWAIST
df["hip_cm"] = df.BMXHIP
df["arm_circ_cm"] = df.BMXARMC
df["arm_len_cm"] = df.BMXARML
df["leg_len_cm"] = df.BMXLEG

# ratios: scale-free shape descriptors, exactly what a silhouette model can recover
df["waist_to_height"] = df.waist_cm / df.height_cm
df["waist_to_weight"] = df.waist_cm / df.weight_kg
df["arm_to_height"] = df.arm_circ_cm / df.height_cm
df["waist_to_arm"] = df.waist_cm / df.arm_circ_cm
df["ponderal_index"] = df.weight_kg / (df.height_cm / 100.0) ** 3
df["waist_to_hip"] = df.waist_cm / df.hip_cm

ETH = {1: "Mexican American", 2: "Other Hispanic", 3: "White", 4: "Black",
       6: "Asian", 7: "Other/Multi"}
df["ethnicity"] = df.RIDRETH3.map(ETH).fillna("Unknown")

cols = ["SEQN", "cycle", "sex", "age", "height_cm", "weight_kg", "bmi",
        "waist_cm", "hip_cm", "arm_circ_cm", "arm_len_cm", "leg_len_cm",
        "waist_to_height", "waist_to_weight", "arm_to_height", "waist_to_arm",
        "ponderal_index", "waist_to_hip", "ethnicity",
        "bodyfat_pct", "fat_mass_kg", "lean_mass_kg", "alm_kg", "almi", "muscle_pct"]
out = df[cols].reset_index(drop=True)
out.to_csv(OUT / "nhanes_bodycomp.csv", index=False)

print(f"\nfinal dataset: {len(out)} subjects -> data/processed/nhanes_bodycomp.csv")
print(f"  male {int((out.sex == 1).sum())} / female {int((out.sex == 0).sum())}")
print(f"  with hip circumference: {int(out.hip_cm.notna().sum())}")
print(f"  with appendicular lean mass: {int(out.alm_kg.notna().sum())}")
print("\nper cycle:")
print(out.groupby("cycle").agg(n=("SEQN", "size"), bodyfat=("bodyfat_pct", "mean")).round(1))
print("\ntargets:")
print(out[["bodyfat_pct", "alm_kg", "almi", "muscle_pct"]].describe().round(2))
