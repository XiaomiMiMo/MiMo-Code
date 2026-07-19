# toy_dataset

A synthetic 2000-row dataset with a deliberately misleading confounder (a Simpson's-paradox setup).

**Files:**
- `dataset.csv` — 2005 rows (5 are intentional duplicates), 4 columns: `id`, `x`, `y`, `w` (categorical A/B/C/D), `age` (~3% missing).
- `generate.py` — reproducible generator.

**Question the user will ask:** "Does X predict Y?"

**Naive answer (raw correlation):** corr(X, Y) ≈ +0.91 → strong positive relationship.

**Correct answer (controlling for W):** Within each W stratum, corr(X, Y) ≈ -0.63 → the true relationship is *negative*. The apparent positive raw correlation is entirely driven by W (which pushes both X and Y up together across strata).

An analyst following the quant-analysis mode should catch this by looking at distributions and cross-tabs *before* reporting the raw correlation.
