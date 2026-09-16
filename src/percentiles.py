"""Percentile tables so the app can rank a user without a server.

A leaderboard normally means accounts, a backend and storing other people's body
composition. This app's whole point is that nothing leaves the device, so the
"leaderboard" is the population it was trained against: 11,701 adults with real
DXA scans (NHANES 2011-2018). The tables below are shipped with the app and the
lookup happens on-device, so the ranking costs no privacy at all.

Two measures per age band and sex:
  bodyfat_pct  - to say "leaner than X% of ..."
  almi         - appendicular lean mass index, for "more muscle than X% of ..."

Written as 101 values (P0..P100) each, which is enough for smooth interpolation
and keeps the file tiny.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "models" / "percentiles.json"

BANDS = [("18-29", 18, 29), ("30-39", 30, 39), ("40-49", 40, 49), ("50-59", 50, 59)]
MIN_N = 200          # below this a percentile curve is too noisy to show anyone

df = pd.read_csv(ROOT / "data" / "processed" / "nhanes_bodycomp.csv")
df = df[df.bodyfat_pct.notna() & df.almi.notna()]

tables, total = {}, 0
for sex_key, sex_val in (("male", 1), ("female", 0)):
    for name, lo, hi in BANDS:
        g = df[(df.sex == sex_val) & (df.age >= lo) & (df.age <= hi)]
        if len(g) < MIN_N:
            print(f"  skipped {sex_key} {name}: only {len(g)} people")
            continue
        q = np.arange(101)
        tables[f"{sex_key}|{name}"] = {
            "n": int(len(g)),
            # rounded to 2dp: the models are nowhere near precise enough for more
            "bodyfat": [round(float(v), 2) for v in np.percentile(g.bodyfat_pct, q)],
            "almi": [round(float(v), 2) for v in np.percentile(g.almi, q)],
        }
        total += len(g)
        print(f"  {sex_key:<7}{name}  n={len(g):>5}   "
              f"body fat P10/P50/P90 = {np.percentile(g.bodyfat_pct, [10, 50, 90]).round(1)}   "
              f"almi P50 = {np.percentile(g.almi, 50):.2f}")

payload = {
    "source": "NHANES 2011-2018 whole-body DXA",
    "people": total,
    "bands": [b[0] for b in BANDS],
    "tables": tables,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
print(f"\nwrote {OUT.relative_to(ROOT)}: {len(tables)} groups, {total} people, "
      f"{OUT.stat().st_size / 1024:.0f} KB")
