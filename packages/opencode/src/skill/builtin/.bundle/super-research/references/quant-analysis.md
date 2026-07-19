# Mode: Quantitative analysis / 量化分析

Use when the user wants a data-driven answer computed from a dataset — "analyze this data", "量化分析", "test whether X relates to Y", "estimate the effect of Z", "investigate this dataset".

The failure mode this mode is designed against: producing a plausible-looking chart or statistic that the user cannot reproduce, verify, or understand the caveats of. Every reported number must trace back to a script, and every script must run on the raw data end-to-end.

## Contract fields

1. **Question**: A crisp hypothesis or estimation target. Not "look at this data" — "does feature X predict outcome Y after controlling for Z?", or "what's the median time-to-first-response by team?". If the user only has a dataset and no question, negotiate to a specific question in the contract.
2. **Dataset**: Path, format (CSV / parquet / JSON / DB connection), row count if known, schema if known. Note anything the user warns about (known missing values, duplicated columns, sample bias).
3. **Deliverables**: A `report.md` with the finding, `analysis_log.tsv` (one row per analytical step), and a `scripts/` folder with numbered scripts that reproduce every figure and number in the report. Optionally a `figures/` folder.
4. **Constraints**: What's off-limits? (e.g. "don't merge with the internal HR table", "compute must run under 10 min per script", "no ML libraries — keep it interpretable statistics").
5. **Working directory**: A dedicated `analysis/<tag>/` folder. Everything goes there.

## Baseline — the data audit

Before ANY modeling or hypothesis testing, you produce a data audit. This is your baseline artifact; if the audit surfaces something bad enough (wrong schema, wrong units, corrupt file), the analysis stops here and you report that instead.

The audit is a script (`scripts/00_audit.py` or similar) that outputs `audit.md` covering:

- **Shape**: rows, columns.
- **Schema**: column, dtype, non-null count, unique count, min/max or top-3 values.
- **Missingness**: % nulls per column, and whether nulls are systematic (e.g. correlated with another column).
- **Duplicates**: any full-row dupes; any dupes on a natural key.
- **Outliers**: for each numeric column, values at the 1st/99th percentile and clearly out-of-band values.
- **Sanity checks against the question**: does the required column even exist and have enough non-null variance to answer the question?

If the audit reveals a fatal problem (question can't be answered from this data), stop and report. Don't paper over it.

## The analysis log

`analysis_log.tsv` (tab-separated), one row per analytical step:

```
step	script	status	finding	caveat
01	scripts/00_audit.py	done	dataset OK: 42k rows, 3.2% missing in `age`, one obvious duplicate row	age nulls concentrated in the pre-2023 cohort — possible collection bias
02	scripts/01_distributions.py	done	Y is bimodal (peaks at 12 and 34); no obvious transform makes it normal	rules out linear regression as the primary tool
03	scripts/02_correlation.py	done	corr(X, Y) = 0.31, n=41000, p<1e-9	correlation not causation; X and confounder W are also correlated at 0.42
04	scripts/03_effect_of_X_controlling_for_W.py	done	partial correlation 0.09, 95% CI [0.06, 0.12]	effect size much smaller than raw correlation suggested
05	scripts/04_robustness_stratified.py	dead-end	stratifying by W gave inconsistent effect direction across strata (Simpson-flavored)	primary finding is unstable — must caveat in report
06	scripts/05_dependent_variable_check.py	done	Y distribution stable across strata, no measurement artifact	rules out one alternative explanation for step 5
```

- **step** — `01`, `02`… monotonic.
- **script** — filename that produced the finding. If it's not a script, it doesn't happen — no eyeballed numbers.
- **status** — `done` / `dead-end` / `inconclusive` / `error`. Every attempt logged even if it didn't work.
- **finding** — one sentence, quantitative where possible.
- **caveat** — one sentence, what makes this weaker than it looks. Empty caveat is suspicious.

## The scripts folder

- Numbered by step (`00_audit.py`, `01_distributions.py`, …) so a reader can rerun in order.
- Each script: reads the raw data, does one thing, writes any figures to `figures/`, prints its findings (which you copy into the log). No shared mutable state between scripts unless you write an intermediate parquet in between and load it back.
- No hidden globals from a Jupyter kernel — a script that only works in a live notebook is not reproducible.

## The loop

LOOP:

1. Look at the current state of the analysis (log, most recent findings, remaining open sub-questions).
2. Choose the next most informative step. Order of operations for a typical analysis: audit → univariate distributions → bivariate exploration → hypothesis test with the appropriate model → robustness checks (subgroups, alternative specs) → alternative-explanation ruling out.
3. Write the script. Run it, capture printed findings + figures.
4. Append to `analysis_log.tsv`. If it was a dead-end (broken assumption, unusable variable, effect vanishes under a check), log it — dead-ends are how you demonstrate the finding is real.
5. If findings suggest a NEW hypothesis, note it in the log's caveat column and add it to your queue. Do NOT change the primary question mid-analysis unless the data made it unanswerable — in that case, log the change explicitly.
6. Loop until either the question is answered with quantified confidence intervals AND a robustness check confirms it, or the data proves incapable of answering it.

## Judgment

**Effect sizes over p-values.** A p<0.001 with an effect size of 0.02 correlation is a huge sample telling you nothing interesting. Report effect sizes + CIs; treat p-values as tie-breakers.

**Every finding needs at least one attempted alternative explanation.** If X predicts Y, what else predicts X? What confounders did you consider? Which did you rule out with what? If you didn't consider any, you haven't finished.

**Don't p-hack — log every specification you ran.** If you tried 4 regression specs and one is significant, the log must show all 4. Reporting only the significant one is fraud.

**When the answer is "we can't tell from this data", say so.** An honest inconclusive finding is a better outcome than a fake-precise one. The log makes this position defensible.

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **Headline finding** — 1–2 sentences with effect size and confidence.
- **How I got there** — 3–6 bullets pointing at specific `analysis_log.tsv` step IDs.
- **Robustness** — what alternative specs were tried, what survived.
- **Caveats** — the top-3 reasons this finding might be wrong or narrower than it looks.
- **Where to look**: `analysis_log.tsv`, `scripts/`, `figures/`, and the audit.
