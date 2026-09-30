# Mode: Paper reproduction / 复现论文

Use when the user hands you a paper (arXiv id, DOI, PDF, or URL) and asks for a working code implementation — "复现这篇论文", "paper to code", "implement this method", "reproduce the main table of X".

The failure mode this mode is designed against: producing a repo that *looks* like an implementation of the paper but silently deviates from it — hard-coded numbers, unstated hyperparameters filled in from imagination, or a "reproduction" that never actually reruns the paper's experiment. Every ambiguity must be a **logged decision**, not an invisible guess. Every reported number must come from an actual run of your code, not from the paper.

## Contract fields

1. **Paper**: arXiv id / DOI / URL. Also: does an official reference implementation exist? (Search GitHub via WebFetch before committing to reproduction-from-scratch — the user may only want you to run their code.)
2. **Scope**: Which experiments to reproduce. Almost never "all of them". Usually the main result table + one or two ablations the user cares about. A scoped reproduction that hits the numbers is worth ten started-but-abandoned full reproductions.
3. **Compute realism**: If the paper's full training run is infeasible in this environment (multi-node, weeks of TPU, etc.), agree up front on a **scaled-down verification path**: smaller model, data subset, fewer steps. The final report will say what was full vs scaled — never silently pretend.
4. **Deliverables**: A `paper/<tag>/` directory containing `plan.md`, `analysis.md`, the code repo, `config.yaml`, `results.tsv`, and `REPORT.md`.
5. **Frozen inputs**: The paper text is the spec. If an official repo exists and contradicts the paper, flag the discrepancy in the log — do NOT silently follow either without recording the choice.
6. **Stopping condition**: Numbers within the agreed tolerance of the paper's reported values, or a documented gap with a plausible cause (less compute, unstated hyperparameter, data version), or the compute budget runs out.

## Baseline — the paper artifacts on disk

Before writing a single line of implementation code, produce these artifacts. They are your baseline; if they can't be produced, reproduction is not yet feasible.

```bash
# LaTeX source — preferred: exact equations, tables, hyperparameters
python3 scripts/fetch_paper.py <arxiv_id_or_url> --latex --out-dir paper/<tag>/src/
# Fallback (some e-prints are PDF-only): readable text via ar5iv
python3 scripts/fetch_paper.py <arxiv_id_or_url> --out paper/<tag>/paper.txt
```

Then write:

- **`plan.md`** — method summary in your own words (with section/equation numbers), scope decision (which experiments), repo skeleton (file tree with one-line responsibility per file), dependency graph.
- **`analysis.md`** — for each file in the skeleton, before writing any code: inputs/outputs, the paper equations it implements, edge cases, and **every place where the paper is ambiguous**. The ambiguity list is the reproduction risk register.
- **`config.yaml`** — every hyperparameter mentioned in the paper, with the paper's value and the section reference. Unstated ones marked `# [uncertain: not specified in paper, using common default of X]`.

If the paper doesn't survive contact with `analysis.md` — the ambiguity list is so long that most numbers would be guesses — stop and report that instead of proceeding.

## The reproduction log

`results.tsv` (tab-separated), one row per attempted run of any experiment. Same schema as experiment-loop, extended with a `target` column:

```
commit	experiment	target	metric	resource	status	description
a1b2c3d	main_table_row1	0.312	0	0	crash	shape mismatch in attention block — see run.log
b2c3d4e	main_table_row1	0.312	0.415	1.2	discard	fixed shape bug; runs but 30% off paper — investigate
c3d4e5f	main_table_row1	0.312	0.318	1.2	keep	set warmup steps to 500 per §4.2; within tolerance
c3d4e5f	main_table_row2	0.287	0.291	1.3	keep	same config generalizes to row 2
```

- **experiment** — which paper result this row targets (e.g. `main_table_row1`, `ablation_no_dropout`).
- **target** — the paper's reported number for this experiment. Filled in once from the paper, never edited afterwards.
- **metric / status** — as in experiment-loop (`keep` / `discard` / `crash`).

A separate `ambiguities.tsv` (or a section in `analysis.md`) logs every ambiguity resolution: which paper location, what the ambiguity was, what you chose, why. These are the decisions a reviewer will read first.

## The loop

Implement in dependency order (from `plan.md`'s dependency graph). For each module:

1. Note current branch/commit — fallback point.
2. Implement the smallest usable version of the module. One module per commit.
3. Unit-level smoke test: does it produce shapes/types the next module expects? If yes, move on; if no, fix.
4. Once enough modules exist to run the scoped experiment end-to-end, run it: `<run command> > run.log 2>&1`.
5. Extract the metric mechanically. Append a row to `results.tsv`.
6. Compare against `target`:
   - Within tolerance → mark `keep`, continue to next experiment or ablation.
   - Far off → this is the interesting case. Do NOT tune against the paper's test numbers (that's overfitting to the target — a known way to fool yourself and the user). Instead: re-read `analysis.md`, revisit ambiguities, check the log for a hyperparameter you filled in with a guess.
   - Crash → `tail -n 50 run.log`; fix or log a dead end.
7. Log every ambiguity resolution as it happens.

**Never edit the paper.** The paper text is the spec; if the paper is wrong or contradictory, note it and pick a resolution — don't rewrite what the paper says to match what you did.

## Judgment

**Full training vs scaled verification: say which, always.** If you ran 100 steps on a subset because 100k steps on the full dataset is infeasible, the report says so up front. A "reproduction" that silently used 1% of the compute is a lie by omission.

**Gaps are normal — explain them.** Reproductions rarely nail the paper's numbers exactly (different compute, unstated hyperparameters, dataset versions, framework numerics). A 3% gap with a documented plausible cause is a valid outcome. A 30% gap with "close enough" is not.

**Don't fine-tune your way to the paper's number.** If you find yourself sweeping hyperparameters until a specific test-set number appears, stop. That is overfitting to the target and produces a repo that memorizes the paper's table rather than reproducing its method. If the user explicitly asks for a target-matching sweep, note it prominently in the report.

**Config over code.** Every hyperparameter lives in `config.yaml`, never hardcoded in the module. Reviewers check the config first — burying an unstated default deep in the code hides the ambiguity that most matters.

**Official-repo divergence is a finding.** If the paper says one thing and the released code does another, that's paper 1 vs implementation 1 — you have to pick one and log which. Do not treat "the code says so" as automatic ground truth over the paper.

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **Reproduction summary** — one paragraph: paper cited, scope of what was reproduced, compute path (full vs scaled).
- **Numbers table** — `experiment | paper | ours | gap | note`. This IS the report; everything else supports it.
- **Ambiguities resolved** — list of paper ambiguities and how each was decided. This is what a reviewer verifies against the paper text.
- **Known deviations** — where and why you departed from the paper (or the official repo), and expected impact on numbers.
- **Reproduce command** — the exact shell command that regenerates the numbers table from scratch.
- **Where to look**: `plan.md`, `analysis.md`, `config.yaml`, `results.tsv`, `ambiguities.tsv`, the code repo, `paper/<tag>/`.
