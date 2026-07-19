# Mode: Benchmark comparison / 对比评测

Use when the user wants to **pick among N candidates** — libraries, models, algorithms, prompts, configs — "compare X vs Y", "which of these is best for us", "benchmark these", "选型", "对比评测". The goal is selection, not improvement: you do not hill-climb any candidate, you measure all of them under identical conditions.

The failure mode this mode is designed against: an unfair comparison — candidates run under different conditions, tuned unevenly, or judged on cherry-picked cases — and a "winner" declared without the trade-offs that would change the decision.

## Contract fields

1. **Candidates**: An explicit, frozen list. Adding a candidate mid-run is allowed only if you rerun the *entire* matrix for it under identical conditions — partial coverage silently biases the ranking. If the user has an incumbent ("what we use today"), include it as a candidate; it's the most meaningful reference point.
2. **Task matrix**: The fixed set of test cases / workloads / inputs every candidate will run on. Defined BEFORE the first measured run. Choosing cases after seeing results is the benchmark version of p-hacking.
3. **Metrics**: One primary metric (one number, one direction) that decides the ranking, plus secondaries (latency, memory, cost, setup complexity) that go in the log and inform trade-offs. All measured by the SAME harness code for every candidate — never by each candidate's own self-reported number.
4. **Fairness budget**: Equal effort per candidate — e.g. "default config only" or "≤15 min of tuning each", and a fixed number of repetitions per cell for variance. If one candidate needs special-casing to run at all (an adapter, a format conversion), that's allowed but logged; it is itself a finding about integration cost.
5. **Environment**: Pinned versions, hardware, seeds. Note anything that could drift between runs (thermal throttling, network, API rate limits).
6. **Working directory**: A dedicated `benchmark/<tag>/` folder — harness, matrix log, per-run outputs all go there.

## Baseline — validate the harness

Before any measured runs, smoke-test the harness on ONE candidate and ONE case, and eyeball the output. A broken harness measured 60 times produces 60 confident wrong numbers. If a trivial reference exists (no-op, random guess, the incumbent), run it first — it calibrates what "good" means on your matrix.

## The matrix log

`matrix.tsv` (tab-separated), one row per (candidate × case × repetition):

```
candidate	case	rep	metric	resource	status	notes
lib_a	case01	1	0.912	1.2	done	
lib_a	case01	2	0.909	1.2	done	
lib_b	case01	1	0.877	0.4	done	
lib_b	case07	1	0	0	error	throws on unicode input — see run logs
lib_c	case07	1	0	0	timeout	killed at 2× budget
```

- **status** — `done` / `error` / `timeout` / `unsupported`. Every planned cell gets a row; an empty cell means the comparison is incomplete and the ranking untrustworthy.
- **Failures are findings, not exclusions.** A candidate that errors on 20% of cases is critical decision data. Never drop a candidate's bad cells to "clean up" its average — score failures as worst-case or report coverage separately, and say which you did.

## The loop

1. Smoke-test the harness (baseline above).
2. Run the matrix. **Interleave repetitions across candidates** (A,B,C,A,B,C…) rather than running each candidate in a block — time-varying noise (thermal, network, caches) then spreads evenly instead of biasing whichever ran first.
3. Log every cell as it completes, including failures. Redirect run output to files; extract the metric by grep/script, not by eye.
4. When the matrix is complete, aggregate: per-candidate mean ± std on the primary metric, per case and overall rank.
5. **Stability check**: recompute the ranking dropping one case at a time. If the winner flips depending on a single case, the result is fragile — report that, don't hide it.
6. Optional phase 2 (only if the contract allows it): equal-budget tuning per candidate, then rerun the matrix. Keep phase 1 and 2 results clearly separated in the log — mixing tuned and untuned numbers is the fastest way to make the report unreadable.

## Judgment

**Don't tune the favorite.** The most common way benchmarks lie is unequal effort: hours polishing the candidate you expect to win, defaults for the rest. Equal budget, mechanically enforced.

**A trade-off frontier is a valid answer.** "A is 3× faster, B is 4 points more accurate, C is the only one that handles your unicode cases" is often more useful than a forced single winner. Declare a single winner only when one candidate dominates or the user's priority makes the choice clear.

**Watch for matrix-candidate mismatch.** If a candidate loses only on cases that are marginal to the user's real workload, say so. The matrix approximates reality; note where the approximation is thin.

**Variance before verdicts.** If per-cell repetitions show std comparable to the between-candidate gaps, more reps — not conclusions — are what's needed next.

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **Recommendation** — the winner, or the trade-off frontier with a decision rule ("pick A unless you need X").
- **Ranking table** — per-candidate primary metric mean ± std, key secondaries, failure/coverage rate.
- **Stability** — does the ranking survive drop-one-case? Where is it fragile?
- **Integration notes** — special-casing any candidate needed, from the log.
- **Where to look**: `matrix.tsv`, the harness script, per-run logs in `benchmark/<tag>/`.
