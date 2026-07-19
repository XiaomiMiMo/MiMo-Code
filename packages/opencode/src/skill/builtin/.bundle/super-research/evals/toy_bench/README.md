# toy_bench

A tiny stand-in for a real "select among N candidates" comparison. Three implementations of a text-cleaner, five fixed test cases, one correctness metric.

- `candidates/cleaner_a.py`, `cleaner_b.py`, `cleaner_c.py` — the three candidates. Each reads stdin, writes cleaned text to stdout. They differ in how they handle unicode, trailing whitespace, and empty input; none is uniformly best.
- `cases/` — five input files (`case01.in`…`case05.in`) plus their gold outputs (`case01.gold`…). The comparison should hold this set fixed.
- `run_case.sh <candidate> <case>` — runs the candidate on the case and prints a similarity score (0.0–1.0, higher is better) plus a wall-clock time. If the candidate crashes or times out, the harness prints `status=error` and score 0.

The correct benchmark-mode behavior is: run each of the 3 candidates on each of the 5 cases (≥2 reps), log every cell including failures, and produce a ranking with a drop-one-case stability check.
