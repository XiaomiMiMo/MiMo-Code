"""Synthetic pipeline for ablation-mode testing.

Toy fixture: each component contributes a *controlled* additive delta to the score,
so the leave-one-out ground truth is easy to verify. Real pipelines are messier; the
point of this fixture is to exercise the ablation methodology, not to be realistic.

Set the ENABLED_* flags to False to ablate a component.

Design intent (verify with a leave-one-out run + noise-floor comparison):
- ENABLED_NORMALIZE:    critical  — its absence raises, run exits non-zero.
- ENABLED_DEDUPE:       load-bearing (+0.08). Removing it drops the score.
- ENABLED_WEIGHT_BOOST: load-bearing (+0.05). Removing it drops the score.
- ENABLED_SMOOTH:       inert (0.0). Removing it changes nothing measurable.
- ENABLED_GUARD:        hurts (-0.03). Removing it *raises* the score — the
                        "surprising positive" the mode file warns about.
"""
import random
import sys

# ------------- component switches (ablatable) -------------
ENABLED_NORMALIZE    = True
ENABLED_DEDUPE       = True
ENABLED_WEIGHT_BOOST = True
ENABLED_SMOOTH       = True
ENABLED_GUARD        = True

SEED = 0

# --------------------- do not edit below -----------------------
_BASE_SCORE = 0.72  # what the pipeline would produce with all components disabled (except normalize).


def run():
    if not ENABLED_NORMALIZE:
        # Downstream stages assume normalized inputs; without this the module refuses to score.
        raise ValueError("normalization stage is required; inputs are unnormalized")

    score = _BASE_SCORE

    if ENABLED_DEDUPE:
        # In a real pipeline this drops noisy duplicates and improves the score.
        score += 0.08

    if ENABLED_WEIGHT_BOOST:
        # In a real pipeline this reweights good samples up.
        score += 0.05

    if ENABLED_SMOOTH:
        # In a real pipeline this is a self-averaging pass — mathematically a no-op.
        score += 0.0

    if ENABLED_GUARD:
        # In a real pipeline this is a "safety" clamp that also zeroes legitimate signal.
        score -= 0.03

    # Small seed-controlled measurement noise so a noise floor is observable.
    score += random.Random(SEED + 100).gauss(0, 0.003)

    print(f"score: {score:.6f}")
    print(f"seed: {SEED}")


if __name__ == "__main__":
    run()
