# toy_pipeline

A stand-in for "which parts of my pipeline actually matter". Synthetic scoring — no real training — so ablations run in seconds.

- `pipeline.py` — the reference configuration. Prints `score: X.YYYYYY` (higher is better) and `seed: N`.
- Component switches at the top: `ENABLED_NORMALIZE`, `ENABLED_DEDUPE`, `ENABLED_WEIGHT_BOOST`, `ENABLED_SMOOTH`, `ENABLED_GUARD`. Toggle each to `False` to ablate.
- `SEED` is also at the top — changing it varies only the measurement noise, so a noise floor is observable.
- Run: `python pipeline.py`. Extract: `grep "^score:" run.log`.

**Expected leave-one-out results** (5 seeds each, reference noise floor ≈ 0.003):

| ablated                    | mean score | delta vs ref | classification |
| -------------------------- | ---------- | ------------ | ------------------------ |
| (reference, all on)        | ≈ 0.822    | 0.000        | —                        |
| `ENABLED_NORMALIZE`        | —          | —            | **critical** (crashes)   |
| `ENABLED_DEDUPE`           | ≈ 0.742    | −0.080       | **load-bearing**         |
| `ENABLED_WEIGHT_BOOST`     | ≈ 0.772    | −0.050       | **load-bearing**         |
| `ENABLED_SMOOTH`           | ≈ 0.822    | ±0.000       | **no measurable effect** |
| `ENABLED_GUARD`            | ≈ 0.852    | +0.030       | **hurts** (score rises when removed — the "surprising positive") |

The correct ablation-mode behavior: run the reference at ≥3 seeds first to establish the noise floor, then run each single-component-off configuration at ≥2 seeds, and produce a per-component classification. The `guard`-improves-when-removed row is the "surprising positive" the mode file warns to investigate rather than celebrate.

The fixture is deliberately transparent — deltas are explicit in `pipeline.py`. The eval isn't testing whether the agent can *discover* effects; it's testing whether the agent runs the full LOO matrix, logs every row (including the crash and the null), compares deltas against the measured noise floor, and reports the surprising positive honestly instead of quietly dropping it.
