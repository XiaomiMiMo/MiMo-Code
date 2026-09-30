# toy_repo

A tiny stand-in for a real training script. Used for testing autonomous research loops without spending minutes per experiment.

- `run.py` — the mutable file. Contains a handful of tunable constants at the top (LEARNING_RATE, HIDDEN_DIM, DEPTH, DROPOUT, MOMENTUM). Prints `val_loss: X.YYYYYY` (lower is better) and `peak_memory_gb: Z.ZZ`. Runs in about 0.5 s.
- Run with: `python run.py`
- Extract metric: `grep "^val_loss:" run.log`
