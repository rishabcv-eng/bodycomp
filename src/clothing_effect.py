"""How much does loose clothing cost?

The silhouette IS the measurement, so any fabric standing off the body is read
as body. This simulates it: dilate only the TORSO band of a ground-truth
silhouette (a loose top does not pad your ankles), by a known number of
centimetres of standoff, then push it through the trained Stage 1 and Stage 2
models and measure the damage in cm and in body-fat points.

Standoff is converted to pixels per subject using their own height, so "1 cm of
fabric" means the same thing on every body.
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
S2 = pickle.load(open(ROOT / "models" / "stage2_bodycomp.pkl", "rb"))
N = 400
AGE = 30
STANDOFFS = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0]      # cm of fabric off the skin

# a loose top covers roughly shoulders to hips
TORSO_TOP, TORSO_BOT = 0.22, 0.62


def clothe(mask: np.ndarray, standoff_cm: float, px_per_cm: float) -> np.ndarray:
    """Pad the torso band outward by standoff_cm, leaving head and legs alone."""
    k = int(round(standoff_cm * px_per_cm))
    if k <= 0:
        return mask
    m = mask.astype(np.uint8) * 255
    fat = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1,) * 2))
    rows = np.where(mask.any(axis=1))[0]
    top, bot = rows[0], rows[-1]
    h = bot - top
    band_lo = int(top + TORSO_TOP * h)
    band_hi = int(top + TORSO_BOT * h)
    out = m.copy()
    out[band_lo:band_hi] = fat[band_lo:band_hi]
    return out > 0


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


def bodyfat(waist, arm, sex, height_cm, weight_kg):
    row = {"sex": sex, "age": AGE, "height_cm": height_cm, "weight_kg": weight_kg,
           "bmi": weight_kg / (height_cm / 100) ** 2, "waist_cm": waist, "arm_circ_cm": arm,
           "arm_len_cm": np.nan, "leg_len_cm": np.nan,
           "waist_to_height": waist / height_cm, "waist_to_weight": waist / weight_kg,
           "arm_to_height": arm / height_cm, "waist_to_arm": waist / arm,
           "ponderal_index": weight_kg / (height_cm / 100) ** 3}
    X = pd.DataFrame([row])[S2["features"]]
    return float(S2["models"]["bodyfat_pct"]["point"].predict(X)[0])


hwg = pd.read_csv(B / "hwg_metadata.csv")
smap = pd.read_csv(B / "subject_to_photo_map.csv")
truth = pd.read_csv(B / "measurements.csv")
m = smap.merge(hwg, on="subject_id").merge(truth, on="subject_id")
m = m[[(B / "mask" / f"{r.photo_id}.png").exists() and (B / "mask_left" / f"{r.photo_id}.png").exists()
       for r in m.itertuples()]].sample(min(N, len(m)), random_state=5)
print(f"{len(m)} photo pairs from {m.subject_id.nunique()} unseen subjects\n")

rows = []
for r in m.itertuples():
    fm = np.array(Image.open(B / "mask" / f"{r.photo_id}.png")) > 0
    sm = np.array(Image.open(B / "mask_left" / f"{r.photo_id}.png")) > 0
    span = np.where(fm.any(axis=1))[0]
    px_per_cm = (span[-1] - span[0] + 1) / r.height_cm
    sex = 1 if r.gender == "male" else 0
    for so in STANDOFFS:
        d = features(clothe(fm, so, px_per_cm), clothe(sm, so, px_per_cm),
                     r.height_cm, r.weight_kg, sex)
        if d is None:
            continue
        X = pd.DataFrame([d])[S1["features"]]
        waist = float(S1["models"]["waist"].predict(X)[0])
        chest = float(S1["models"]["chest"].predict(X)[0])
        arm = float(S1["models"]["bicep"].predict(X)[0])
        rows.append({"standoff": so, "waist_err": waist - r.waist, "chest_err": chest - r.chest,
                     "bf": bodyfat(waist, arm, sex, r.height_cm, r.weight_kg)})

df = pd.DataFrame(rows)
base_bf = df[df.standoff == 0].groupby(level=0).bf   # aligned per-row below
df["row"] = df.index // len(STANDOFFS)
bf0 = df[df.standoff == 0].set_index("row").bf
df["bf_shift"] = df.bf - df.row.map(bf0)

print(f"{'standoff':>9} {'waist bias':>12} {'waist MAE':>11} {'chest bias':>12} {'body fat shift':>16}")
print("-" * 64)
summary = []
for so in STANDOFFS:
    g = df[df.standoff == so]
    row = {"standoff_cm": so, "waist_bias": g.waist_err.mean(), "waist_mae": g.waist_err.abs().mean(),
           "chest_bias": g.chest_err.mean(), "bodyfat_shift": g.bf_shift.mean()}
    summary.append(row)
    print(f"{so:>8.1f}c {row['waist_bias']:>+11.2f} {row['waist_mae']:>11.2f} "
          f"{row['chest_bias']:>+12.2f} {row['bodyfat_shift']:>+15.2f}")

pd.DataFrame(summary).to_csv(ROOT / "reports" / "clothing_effect.csv", index=False)

s = pd.DataFrame(summary).set_index("standoff_cm")
print(f"\n{'='*64}\nWHAT THIS MEANS\n{'='*64}")
print(f"  Skin-tight (0 cm) ............ waist MAE {s.loc[0.0,'waist_mae']:.2f} cm")
print(f"  A fitted t-shirt (~0.5 cm) ... waist bias {s.loc[0.5,'waist_bias']:+.2f} cm, "
      f"body fat {s.loc[0.5,'bodyfat_shift']:+.2f} pts")
print(f"  A normal t-shirt (~1 cm) ..... waist bias {s.loc[1.0,'waist_bias']:+.2f} cm, "
      f"body fat {s.loc[1.0,'bodyfat_shift']:+.2f} pts")
print(f"  A loose hoodie (~2-3 cm) ..... waist bias {s.loc[2.0,'waist_bias']:+.2f} to "
      f"{s.loc[3.0,'waist_bias']:+.2f} cm, body fat {s.loc[2.0,'bodyfat_shift']:+.2f} to "
      f"{s.loc[3.0,'bodyfat_shift']:+.2f} pts")
per_cm = (s.loc[1.0, 'bodyfat_shift'] - s.loc[0.0, 'bodyfat_shift'])
print(f"\n  Roughly {per_cm:+.2f} body-fat points per cm of fabric standing off the waist.")
print("\nwrote reports/clothing_effect.csv")
