"""Bland-Altman and error-distribution plots for the body fat model."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np, pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
te = pd.read_csv(ROOT / "reports" / "test_predictions.csv")
d, mean = te.err, (te.pred + te.bodyfat_pct) / 2
bias, sd = d.mean(), d.std()

fig, ax = plt.subplots(1, 3, figsize=(16, 4.6))

ax[0].scatter(mean, d, s=6, alpha=.25, c="#2563eb", edgecolors="none")
for y, lab, c in [(bias, f"bias {bias:+.2f}", "#dc2626"),
                  (bias + 1.96*sd, f"+1.96 SD  {bias+1.96*sd:+.2f}", "#6b7280"),
                  (bias - 1.96*sd, f"-1.96 SD  {bias-1.96*sd:+.2f}", "#6b7280")]:
    ax[0].axhline(y, color=c, ls="--", lw=1.2)
    ax[0].text(ax[0].get_xlim()[1], y, f" {lab}", va="center", fontsize=8, color=c)
ax[0].set(xlabel="mean of predicted and DXA body fat %", ylabel="predicted - DXA (%)",
          title="Bland-Altman: agreement with DXA")

ax[1].scatter(te.bodyfat_pct, te.pred, s=6, alpha=.25, c="#059669", edgecolors="none")
lim = [te.bodyfat_pct.min()-2, te.bodyfat_pct.max()+2]
ax[1].plot(lim, lim, "k--", lw=1, label="perfect agreement")
ax[1].set(xlim=lim, ylim=lim, xlabel="DXA body fat %", ylabel="predicted body fat %",
          title=f"Predicted vs DXA  (MAE {d.abs().mean():.2f}%)")
ax[1].legend(fontsize=8)

ax[2].hist(d, bins=50, color="#7c3aed", alpha=.8)
ax[2].axvline(0, color="k", lw=1)
for t in (3, -3):
    ax[2].axvline(t, color="#dc2626", ls="--", lw=1)
ax[2].set(xlabel="error (percentage points)", ylabel="subjects",
          title=f"Error distribution  ({(d.abs()<=3).mean()*100:.0f}% within +/-3 pts)")

for a in ax:
    a.grid(alpha=.2)
    a.spines[["top", "right"]].set_visible(False)
fig.suptitle("Body fat model vs DXA - held-out NHANES 2017-2018 cycle (n=%d)" % len(te),
             fontsize=12, y=1.02)
fig.tight_layout()
fig.savefig(ROOT / "reports" / "evaluation.png", dpi=140, bbox_inches="tight")
print("wrote reports/evaluation.png")
