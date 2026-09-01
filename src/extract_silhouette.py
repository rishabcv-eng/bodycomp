"""Stage 1 feature extraction: front + side silhouette -> body shape descriptors.

Core idea: sample the body at N normalised heights (0 = crown, 1 = feet) and at
each level measure the torso chord width in the front view and the side view.
Treating that cross-section as an ellipse with semi-axes a = front/2, b = side/2
gives a physically-motivated circumference estimate via Ramanujan's formula.
That single feature family is what actually predicts waist and hip; the model
only has to learn the correction from ellipse to true tape measurement.

Scale comes from user-entered height: pixels_per_cm = silhouette height / height_cm.
Arms in A-pose show up as separate runs, so each row uses the run containing the
body's central column rather than the full left-right extent.
"""
import numpy as np, pandas as pd
from PIL import Image
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor

ROOT = Path(__file__).resolve().parent.parent
BODYM = ROOT / "data" / "raw" / "bodym"
OUT = ROOT / "data" / "processed"
LEVELS = 48                      # vertical sampling resolution


def profile(mask_path: Path, height_cm: float):
    """Return (central-run widths, total-foreground widths) in cm at LEVELS heights."""
    return profile_array(np.array(Image.open(mask_path)) > 0, height_cm)


def profile_array(a: np.ndarray, height_cm: float):
    """Same, for an in-memory boolean mask (used by the robustness study)."""
    rows = np.where(a.any(axis=1))[0]
    cols = np.where(a.any(axis=0))[0]
    if len(rows) < 20 or len(cols) < 5:
        return None
    top, bot = rows[0], rows[-1]
    px_per_cm = (bot - top + 1) / height_cm
    centre = int(np.median(np.where(a[top:bot + 1].any(axis=0))[0]))

    central = np.zeros(LEVELS)
    total = np.zeros(LEVELS)
    ys = np.linspace(top, bot, LEVELS).astype(int)
    for i, y in enumerate(ys):
        row = a[y]
        total[i] = row.sum() / px_per_cm
        idx = np.where(row)[0]
        if len(idx) == 0:
            continue
        # split into contiguous runs; keep the one nearest the body centreline
        breaks = np.where(np.diff(idx) > 1)[0]
        runs = np.split(idx, breaks + 1)
        best = min(runs, key=lambda r: 0 if r[0] <= centre <= r[-1]
                   else min(abs(r[0] - centre), abs(r[-1] - centre)))
        central[i] = (best[-1] - best[0] + 1) / px_per_cm
    return central, total


def ellipse_circumference(a_semi, b_semi):
    """Ramanujan's approximation - accurate to ~1e-5 for human aspect ratios."""
    a, b = np.maximum(a_semi, 1e-6), np.maximum(b_semi, 1e-6)
    return np.pi * (3 * (a + b) - np.sqrt((3 * a + b) * (a + 3 * b)))


def process(args):
    split, photo_id, height_cm = args
    f = profile(BODYM / split / "mask" / f"{photo_id}.png", height_cm)
    s = profile(BODYM / split / "mask_left" / f"{photo_id}.png", height_cm)
    if f is None or s is None:
        return None
    fc, ft = f
    sc, st = s
    circ = ellipse_circumference(fc / 2, sc / 2)
    d = {"photo_id": photo_id}
    for i in range(LEVELS):
        d[f"front_w{i:02d}"] = fc[i]
        d[f"side_w{i:02d}"] = sc[i]
        d[f"circ{i:02d}"] = circ[i]
    d["front_area"] = ft.sum()
    d["side_area"] = st.sum()
    d["front_max_w"] = fc.max()
    d["side_max_w"] = sc.max()
    # torso band aggregates: robust summaries of the region that matters most
    torso = slice(int(LEVELS * 0.25), int(LEVELS * 0.60))
    d["torso_circ_min"] = circ[torso].min()
    d["torso_circ_max"] = circ[torso].max()
    d["torso_circ_mean"] = circ[torso].mean()
    return d


if __name__ == "__main__":
    jobs, meta = [], []
    for split in ["train", "testA", "testB"]:
        hwg = pd.read_csv(BODYM / split / "hwg_metadata.csv")
        smap = pd.read_csv(BODYM / split / "subject_to_photo_map.csv")
        m = smap.merge(hwg, on="subject_id")
        for r in m.itertuples():
            if (BODYM / split / "mask" / f"{r.photo_id}.png").exists() and \
               (BODYM / split / "mask_left" / f"{r.photo_id}.png").exists():
                jobs.append((split, r.photo_id, r.height_cm))
                meta.append({"split": split, "subject_id": r.subject_id,
                             "photo_id": r.photo_id, "gender": r.gender,
                             "height_cm": r.height_cm, "weight_kg": r.weight_kg})
    print(f"processing {len(jobs)} photo pairs ...")

    with ProcessPoolExecutor() as ex:
        rows = [r for r in ex.map(process, jobs, chunksize=64) if r is not None]
    print(f"extracted {len(rows)}")

    feats = pd.DataFrame(rows).merge(pd.DataFrame(meta), on="photo_id", how="left")
    OUT.mkdir(parents=True, exist_ok=True)
    feats.to_csv(OUT / "bodym_silhouette_features.csv", index=False)
    print(f"-> data/processed/bodym_silhouette_features.csv  {feats.shape}")
    print(feats.groupby("split").size())
