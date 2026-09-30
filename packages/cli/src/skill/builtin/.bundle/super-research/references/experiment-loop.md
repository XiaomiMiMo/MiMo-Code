# Mode: Experiment loop

Use when the user wants to iteratively improve a measurable outcome by editing code — "optimize", "tune", "run experiments overnight", "hill-climb this metric", any code-in-repo goal with a single number.

## Contract fields

Establish these six before starting. Infer as much as you can from the repo, confirm the rest in one turn.

1. **Metric**: One number, one direction. E.g. `val_bpb` (lower better), tokens/sec (higher), test pass rate (higher). If the user offers multiple goals, make them pick a single primary metric — multi-objective loops stall because "keep or revert" becomes ambiguous. Secondary quantities (memory, wall time) become logged soft constraints.
2. **Run command**: A single shell command that runs one experiment end-to-end and prints the metric, e.g. `uv run train.py`. Establish how to extract the metric (e.g. `grep "^val_bpb:" run.log`).
3. **Budget per experiment**: A fixed wall-clock budget makes experiments directly comparable regardless of what changed (model size, batch, algorithm). If the run doesn't self-limit, agree on a timeout. Aim for ≤10 min/experiment; kill runs exceeding ~2× the budget.
4. **Mutable vs frozen files**: Ideally ONE mutable file (keeps diffs reviewable). The evaluation/metric code is ALWAYS frozen — an agent that edits its own judge produces meaningless numbers. Data prep and dependency manifests default to frozen. No new packages unless the user explicitly allows it.
5. **Stopping condition**: Default is "loop until the human interrupts". User may specify N iterations or a time limit — honor exactly.
6. **Branch**: Fresh `research/<tag>` (tag from today's date, e.g. `research/jul7`). Must not already exist. All experiment commits go here; master stays untouched.

## Baseline

The first run is always the unmodified code. No exceptions — without a baseline, "improved" means nothing, and the baseline verifies the harness works before you start attributing crashes to your ideas.

Create `results.tsv` (tab-separated) with this header and log the baseline as row 1:

```
commit	metric	resource	status	description
a1b2c3d	0.997900	44.0	keep	baseline
```

- **commit** — short git hash (7 chars). Row for a crash gets the commit before the crashed change was rolled back.
- **metric** — the number. Use `0` for crashes.
- **resource** — one secondary number worth tracking (peak memory GB, wall time, etc.). `0` for crashes.
- **status** — `keep` / `discard` / `crash`.
- **description** — short plain-text hypothesis for this experiment.

Keep `results.tsv` untracked by git.

## The loop

LOOP FOREVER (or until stopping condition):

1. Note current branch/commit — this is your fallback point.
2. Form ONE hypothesis and edit the mutable file. One idea per experiment: if you change three things and the metric moves, you've learned nothing about which one did it.
3. `git commit` the change (message = the hypothesis).
4. Run: `<run command> > run.log 2>&1`. **Always redirect** — training output will flood your context and drown the signal you need for the next fifty experiments.
5. Extract the metric from `run.log`.
6. If extraction is empty, the run crashed. `tail -n 50 run.log` for the trace. Dumb bug (typo, missing import, shape mismatch) — fix and re-run. Fundamentally broken idea — log `crash`, revert, move on. Give up on a single idea after a few fix attempts.
7. Append the row to `results.tsv`.
8. **Keep or revert**: metric improved → keep the commit, advance. Equal or worse → `git reset --hard` back to the fallback point. Ties go to simpler code.
9. Go to 1.

## Judgment

**Simplicity criterion.** All else equal, simpler wins. A 0.001 improvement that adds 20 lines of hacky code is usually not worth it. An equal result from *deleting* code is a clear win.

**Resource constraints are soft.** Some increase in memory/cost is fine for real gains, but don't let it blow up quietly.

**Out of ideas → think harder, don't stop.** Re-read in-scope files for new angles. Combine previous near-misses (two individually-neutral changes sometimes compose). Revisit discarded ideas with different magnitudes. Try more radical structural changes once incremental ones plateau. Rewinding the branch is allowed but should be very rare.

**When the well is really dry — mine the literature.** If several consecutive experiments cluster around the same failure mode, treat that as a signal that you're out of local ideas, not that the metric is optimal. Use the shared toolbox to import approaches from published work:

```bash
python3 scripts/paper_search.py "<technique> improve <metric>" --sources arxiv,s2 --limit 15 --out papers.json
python3 scripts/fetch_paper.py <arxiv_id> --out /tmp/paper.txt
```

Read abstracts (not summaries — the abstracts) and pull the most testable idea into the next hypothesis. Log the paper id in the `description` column so a reviewer can trace an experiment back to its inspiration. Don't let this become a full survey — the loop is the primary work; this is 15 minutes to escape a plateau, not a new mode.

## Final report

See the "Reporting" section in SKILL.md. Extras specific to this mode:

- **Baseline metric vs best metric**, plus the delta.
- **# experiments** (kept / discarded / crashed).
- Point to `results.tsv` and the `research/<tag>` branch.
