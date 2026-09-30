"""Generate a synthetic dataset with a Simpson's paradox setup.

The dataset has three variables: X, Y, W (a categorical confounder).
- Raw corr(X, Y) is positive (~+0.3).
- Within each W stratum, corr(X, Y) is actually negative or near-zero.
- This is only detectable if the analyst controls for W.

An audit-first analyst catches this. A one-liner "compute correlation" analyst reports the misleading positive.
"""
import csv
import random
from pathlib import Path

random.seed(42)

W_LEVELS = ["A", "B", "C", "D"]
W_MEANS_X = [1.0, 4.0, 7.0, 10.0]  # X mean by W
W_MEANS_Y = [1.0, 4.0, 7.0, 10.0]  # Y mean by W (co-moves with X — creates the confound)
WITHIN_SLOPE = -0.4  # negative within-stratum X→Y slope

rows = []
for i in range(2000):
    w = random.choice(W_LEVELS)
    idx = W_LEVELS.index(w)
    x = random.gauss(W_MEANS_X[idx], 1.0)
    y = W_MEANS_Y[idx] + WITHIN_SLOPE * (x - W_MEANS_X[idx]) + random.gauss(0, 0.5)
    age = random.choice([None] * 3 + [random.randint(18, 80) for _ in range(97)])  # 3% missing
    rows.append({"id": f"U{i:04d}", "x": round(x, 3), "y": round(y, 3), "w": w, "age": age})

# 5 duplicate rows
for i in range(5):
    rows.append(dict(rows[i]))

out = Path("dataset.csv")
with out.open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=["id", "x", "y", "w", "age"])
    writer.writeheader()
    for row in rows:
        writer.writerow(row)

print(f"Wrote {len(rows)} rows to {out.resolve()}")
