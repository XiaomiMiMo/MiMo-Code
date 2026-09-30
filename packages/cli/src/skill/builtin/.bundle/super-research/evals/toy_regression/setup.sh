#!/usr/bin/env bash
# Seed a fresh git repo with a 5-commit history where commit-3 introduces a regression.
# Usage: setup.sh <target_dir>
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 <target_dir>" >&2
  exit 2
fi
if [ -e "$TARGET" ]; then
  echo "refuse to overwrite: $TARGET already exists" >&2
  exit 2
fi

mkdir -p "$TARGET"
cd "$TARGET"
git init -q
git config user.email "toy@example.com"
git config user.name  "toy"
git config commit.gpgsign false

# ---------- commit-1: working reference ----------
cat > solver.py <<'PY'
"""Tiny parity solver. Deliberately unrealistic — for testing autonomous debug loops."""


def is_even(x):
    return x % 2 == 0


def classify(x):
    even_result = is_even(x)
    # downstream code assumes even_result is exactly True or False (not numpy.bool_ or int)
    if even_result is True:
        return "even"
    if even_result is False:
        return "odd"
    raise ValueError(f"unexpected parity result: {even_result!r}")


if __name__ == "__main__":
    import sys
    print(classify(int(sys.argv[1])))
PY

cat > test_solver.py <<'PY'
"""Plain script — no pytest dep. Prints PASS/FAIL and exits non-zero on failure."""
import sys
from solver import classify

CASES = [(0, "even"), (4, "even"), (3, "odd"), (-2, "even")]

failed = 0
for x, want in CASES:
    try:
        got = classify(x)
    except Exception as e:
        print(f"FAIL classify({x}): raised {type(e).__name__}: {e}")
        failed += 1
        continue
    if got != want:
        print(f"FAIL classify({x}): got {got!r}, want {want!r}")
        failed += 1
    else:
        print(f"pass classify({x}) = {got}")

print(f"--- {len(CASES) - failed}/{len(CASES)} passed ---")
sys.exit(0 if failed == 0 else 1)
PY

git add solver.py test_solver.py
git commit -q -m "commit-1: initial parity solver (working reference)"

# ---------- commit-2: unrelated no-op refactor ----------
python3 - <<'PY'
import pathlib
p = pathlib.Path("solver.py")
t = p.read_text()
t = t.replace(
    '"""Tiny parity solver. Deliberately unrealistic — for testing autonomous debug loops."""',
    '"""Tiny parity solver.\n\nDeliberately unrealistic — for testing autonomous debug loops.\nExpanded docstring: this module exposes is_even() and classify()."""'
)
p.write_text(t)
PY
git commit -q -am "commit-2: expand module docstring (no functional change)"

# ---------- commit-3: the regression ----------
python3 - <<'PY'
import pathlib
p = pathlib.Path("solver.py")
t = p.read_text()
# Replace is_even body — looks like a bitwise-style refactor. Introduces the bug.
t = t.replace(
    "def is_even(x):\n    return x % 2 == 0",
    "def is_even(x):\n    # short-circuit non-truthy inputs early\n    return x and (x % 2 == 0)",
)
p.write_text(t)
PY
git commit -q -am "commit-3: rewrite is_even with defensive short-circuit"

# ---------- commit-4: unrelated rename ----------
python3 - <<'PY'
import pathlib
p = pathlib.Path("solver.py")
t = p.read_text()
t = t.replace(
    "def classify(x):\n    even_result = is_even(x)",
    "def classify(x):\n    parity = is_even(x)\n    even_result = parity",
)
p.write_text(t)
PY
git commit -q -am "commit-4: introduce parity local (rename step, no functional change)"

# ---------- commit-5: readme touch, HEAD ----------
cat > README.md <<'MD'
# toy_regression instance
Run: `pytest -q`  or  `python solver.py 0`
MD
git add README.md
git commit -q -m "commit-5: add README"

echo "seeded $TARGET (5 commits, HEAD = commit-5)"
git log --oneline
