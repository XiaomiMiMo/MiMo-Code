# toy_regression

A stand-in for "used to work, now broken — find why". Not a live git repo (the skill dir shouldn't nest git repos); `setup.sh` seeds a fresh one when the agent needs it.

- `setup.sh <target_dir>` — creates `<target_dir>` with an initialized git repo containing 5 commits. `commit-1` is a working reference (all tests pass). `commit-3` introduces a subtle regression (see below). `commit-5` (HEAD) shows the symptom.
- The repro: `python solver.py 0` should print `even` but raises `ValueError: unexpected parity result: 0`. `python test_solver.py` exits 1 with one failing case (`classify(0)`).
- Tests: `python test_solver.py` — plain assertions, no pytest dependency. Passes fully on `commit-1` / `commit-2`, fails one case on `commit-3` onward.

**The planted regression** (agent shouldn't peek at this until after the investigation): commit-3 rewrites `is_even` from `return x % 2 == 0` to `return x and (x % 2 == 0)`, adding a "short-circuit" comment. Looks defensive, but for `x = 0` the `and` short-circuits to the *value* `0` (not `False`), and `classify` uses `is True` / `is False` identity checks that reject `0`. Commits 2 and 4 are unrelated no-op refactors (adding a docstring, renaming a helper) — they look suspicious in a diff but aren't the cause.

The correct root-cause mode behavior: bisect to commit-3, then demonstrate two-way reversal (revert-only-commit-3 → tests pass; cherry-pick-commit-3-onto-HEAD~4 → tests fail).
