import math
import random
import time

# Tunable hyperparameters — the agent modifies these.
LEARNING_RATE = 0.01
HIDDEN_DIM = 32
DEPTH = 2
DROPOUT = 0.0
MOMENTUM = 0.9
SEED = 0

# ------------------ do not edit below ------------------
# Synthetic scoring function that mimics a training run.
# Optimum lives near LR=0.05, HIDDEN=128, DEPTH=4, DROPOUT=0.1, MOMENTUM=0.95.
# Loss is bits-per-byte-like: lower is better, ~1.0 baseline, floor near 0.6.


def _loss(lr, hidden, depth, dropout, momentum, seed):
    def _bowl(x, x_star, width):
        return ((x - x_star) / width) ** 2

    penalty = (
        0.20 * _bowl(math.log10(max(lr, 1e-9)), math.log10(0.05), 0.7)
        + 0.15 * _bowl(math.log2(max(hidden, 1)), math.log2(128), 1.5)
        + 0.10 * _bowl(depth, 4, 2.0)
        + 0.10 * _bowl(dropout, 0.1, 0.15)
        + 0.05 * _bowl(momentum, 0.95, 0.1)
    )
    rng = random.Random(seed)
    noise = rng.gauss(0.0, 0.005)
    memory_gb = 1.0 + 0.02 * hidden + 0.5 * depth
    return max(0.6, 1.0 + penalty + noise), memory_gb


def main():
    start = time.time()
    time.sleep(0.5)  # simulate a real training run
    loss, mem = _loss(LEARNING_RATE, HIDDEN_DIM, DEPTH, DROPOUT, MOMENTUM, SEED)
    print("---")
    print(f"val_loss:      {loss:.6f}")
    print(f"peak_memory_gb:{mem:.2f}")
    print(f"seconds:       {time.time() - start:.2f}")


if __name__ == "__main__":
    main()
