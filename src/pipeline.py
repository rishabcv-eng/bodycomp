"""Full pipeline: photos (or silhouettes) -> body fat % and lean mass.

    photo pair ─▶ segmentation ─▶ Stage 1 (BodyM) ─▶ circumferences ─▶ Stage 2 (NHANES/DXA) ─▶ body composition

`analyse()` takes ready-made silhouettes; `analyse_photos()` takes ordinary camera
photos and runs MediaPipe segmentation with capture quality control first. The
photo path refuses to return a number when quality control fails - a silent
failure would hand the user a confidently wrong body fat reading.
"""
import pickle
import numpy as np, pandas as pd
from pathlib import Path
from extract_silhouette import profile, ellipse_circumference, LEVELS

ROOT = Path(__file__).resolve().parent.parent
S1 = pickle.load(open(ROOT / "models" / "stage1_measurements.pkl", "rb"))
S2 = pickle.load(open(ROOT / "models" / "stage2_bodycomp.pkl", "rb"))


def silhouette_features(front_png, side_png, height_cm):
    f, s = profile(Path(front_png), height_cm), profile(Path(side_png), height_cm)
    if f is None or s is None:
        raise ValueError("could not read a silhouette - is the whole body in frame?")
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


def analyse(front_png, side_png, height_cm, weight_kg, age, sex):
    """sex: 1 = male, 0 = female."""
    d = silhouette_features(front_png, side_png, height_cm)
    d.update(sex=sex, height_cm=height_cm, weight_kg=weight_kg,
             bmi=weight_kg / (height_cm / 100) ** 2)
    X1 = pd.DataFrame([d])[S1["features"]]
    meas = {k: float(m.predict(X1)[0]) for k, m in S1["models"].items()}

    waist, arm = meas["waist"], meas["bicep"]
    row = {"sex": sex, "age": age, "height_cm": height_cm, "weight_kg": weight_kg,
           "bmi": d["bmi"], "waist_cm": waist, "arm_circ_cm": arm,
           "arm_len_cm": np.nan, "leg_len_cm": np.nan,
           "waist_to_height": waist / height_cm, "waist_to_weight": waist / weight_kg,
           "arm_to_height": arm / height_cm, "waist_to_arm": waist / arm,
           "ponderal_index": weight_kg / (height_cm / 100) ** 3}
    X2 = pd.DataFrame([row])[S2["features"]]

    out = {"measurements_cm": {k: round(v, 1) for k, v in meas.items()}}
    for target in ["bodyfat_pct", "alm_kg"]:
        m = S2["models"][target]
        out[target] = {"estimate": round(float(m["point"].predict(X2)[0]), 1),
                       "low": round(float(m["lo"].predict(X2)[0]) - m["q"], 1),
                       "high": round(float(m["hi"].predict(X2)[0]) + m["q"], 1)}
    bf, alm = out["bodyfat_pct"]["estimate"], out["alm_kg"]["estimate"]
    out["derived"] = {"fat_mass_kg": round(weight_kg * bf / 100, 1),
                      "fat_free_mass_kg": round(weight_kg * (1 - bf / 100), 1),
                      "almi": round(alm / (height_cm / 100) ** 2, 2)}
    return out


def analyse_photos(front_photo, side_photo, height_cm, weight_kg, age, sex,
                   force=False):
    """Same as analyse(), starting from ordinary camera photos.

    Returns {"ok": False, "qc": ...} when a photo fails capture quality control,
    unless force=True. Segmentation errors propagate into every measurement, so
    a rejected photo must not silently produce a body composition estimate.
    """
    from segment import segment, save_mask
    import tempfile

    qc_all = {}
    masks = {}
    for label, path in [("front", front_photo), ("side", side_photo)]:
        r = segment(path)
        qc_all[label] = r["qc"]
        masks[label] = r["mask"]
    blocked = [f"{k}: {i}" for k, q in qc_all.items() for i in q["issues"]]
    if blocked and not force:
        return {"ok": False, "qc": qc_all, "issues": blocked}

    tmp = Path(tempfile.mkdtemp())
    fp, sp = save_mask(masks["front"], tmp / "f.png"), save_mask(masks["side"], tmp / "s.png")
    out = analyse(fp, sp, height_cm, weight_kg, age, sex)
    out["ok"] = True
    out["qc"] = qc_all
    return out


if __name__ == "__main__":
    B = ROOT / "data" / "raw" / "bodym" / "testA"
    hwg = pd.read_csv(B / "hwg_metadata.csv")
    smap = pd.read_csv(B / "subject_to_photo_map.csv")
    truth = pd.read_csv(B / "measurements.csv")
    m = smap.merge(hwg, on="subject_id").merge(truth, on="subject_id").drop_duplicates("subject_id")

    print("End-to-end on real BodyM test photos (subjects unseen in training)\n")
    for r in m.sample(4, random_state=7).itertuples():
        fp, sp = B / "mask" / f"{r.photo_id}.png", B / "mask_left" / f"{r.photo_id}.png"
        if not (fp.exists() and sp.exists()):
            continue
        res = analyse(fp, sp, r.height_cm, r.weight_kg, 30, 1 if r.gender == "male" else 0)
        p, bf = res["measurements_cm"], res["bodyfat_pct"]
        print(f"  {r.gender}, {r.height_cm:.0f} cm, {r.weight_kg:.1f} kg")
        print(f"    waist   predicted {p['waist']:>5.1f} cm   actual {r.waist:>5.1f} cm   "
              f"err {p['waist']-r.waist:+.1f}")
        print(f"    hip     predicted {p['hip']:>5.1f} cm   actual {r.hip:>5.1f} cm   "
              f"err {p['hip']-r.hip:+.1f}")
        print(f"    chest   predicted {p['chest']:>5.1f} cm   actual {r.chest:>5.1f} cm   "
              f"err {p['chest']-r.chest:+.1f}")
        print(f"    -> body fat {bf['estimate']:.1f}%  (80% CI {bf['low']:.1f}-{bf['high']:.1f}), "
              f"lean {res['alm_kg']['estimate']:.1f} kg, ALMI {res['derived']['almi']:.2f}\n")
