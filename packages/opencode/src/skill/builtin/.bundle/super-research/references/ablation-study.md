# Mode: Ablation study / 消融实验

Use when the user wants to **attribute an outcome to specific components** — "which parts of X actually matter", "does component Y contribute anything", "ablate the pipeline", "消融实验", "attribution study", "is this feature pulling its weight". The goal is understanding, not improvement: you are decomposing a working system to learn which pieces carry the load.

The failure mode this mode is designed against: (1) declaring a component "important" from a single noisy run that beat the noise floor by coincidence, and (2) stopping at the biggest effect and quietly not testing the rest, which produces an attribution that looks decisive but rests on an incomplete matrix.

Ablation differs from experiment-loop: there, you keep changes that improve the metric and revert the rest. Here, you keep and log **every** removal, whether the metric improved, stayed flat, or dropped — that is the whole point.

## Contract fields

1. **Reference configuration**: The exact "full" system whose components you're attributing to. Frozen and repeatable — one commit, one config, one seed set. Every ablation is measured relative to this.
2. **Components**: An explicit enumerated list of ablatable units — features, layers, loss terms, pipeline stages, prompt sections, tool calls, regularizers. If a component has natural sub-parts (e.g. "attention" = QKV + softmax + output projection), decide at contract time whether to ablate it whole or in parts. Sub-part decisions after seeing results are attribution p-hacking.
3. **Ablation operation**: How each component is "removed" — set to zero, replaced with identity, replaced with a trivial baseline (random / mean / no-op), or hard-deleted. **The choice matters and must be identical across components** — a mix of "zero" and "replace-with-random" produces incomparable deltas. Pick one and stick to it, or run all methods for every component (rarely worth it).
4. **Primary metric**: Same shape as experiment-loop — one number, one direction — since deltas need to be comparable. Secondaries (memory, latency, cost) are logged.
5. **Fairness budget**: Same wall-clock / iteration / data budget for every ablation run. Same eval set. Same seeds — or, if seed-sensitivity matters, the same *set* of seeds for every ablation.
6. **Repetitions**: At least 3 runs of the reference configuration to establish the noise floor before ablating. Then at least 2 seeds per ablation (more if the noise floor is comparable to the effects you expect).
7. **Working directory**: A dedicated `ablation/<tag>/` folder — harness, ablation log, per-run outputs.

## Baseline — measure the noise floor

Before any ablation, run the reference configuration ≥3 times with different seeds. This gives you:

- **Reference mean and std** — what the "no change" metric is, and how much it wanders.
- **The noise floor** — the smallest metric delta that could plausibly be a real effect rather than run-to-run variance. Any ablation whose delta is within this band is "no measurable contribution", not "no contribution" (there is a difference — you cannot resolve it with your current setup).

Log these as the first rows of the ablation log. Everything you claim later is measured against them.

## The ablation log

`ablation.tsv` (tab-separated), one row per (config × seed):

```
config	component_removed	seed	metric	resource	status	delta_vs_ref	notes
reference	—	0	0.812	1.2	done	0.000	
reference	—	1	0.809	1.2	done	-0.003	
reference	—	2	0.815	1.2	done	+0.003	noise floor: ±0.003 (±1σ)
ablate_attention	attention	0	0.740	1.1	done	-0.072	well outside noise band — component carries load
ablate_dropout	dropout	0	0.813	1.2	done	+0.001	inside noise band — no measurable contribution
ablate_dropout	dropout	1	0.808	1.2	done	-0.004	inside noise band
ablate_layernorm	layernorm	0	0	0	crash	NaN	training diverges without layernorm — critical, not merely helpful
ablate_reg_term	reg_term	0	0.816	1.2	done	+0.004	possibly helpful to remove — repeat with more seeds
```

- **delta_vs_ref** — the metric minus the reference mean, in the metric's direction (positive = better if higher-better, negative = worse). Filled in during the aggregation step, not at run time.
- **crashes are attributions too.** A component whose removal causes the system to fail catastrophically is *load-bearing*, and that is one of the strongest attribution results. Do not silently retry with a "fix" — log the crash and move on.

Keep `ablation.tsv` untracked by git.

## The loop

1. Establish the noise floor (baseline above). Log the reference runs.
2. For each component in the frozen list, run the ablation at ≥2 seeds under identical conditions. Redirect run output to files; extract the metric mechanically.
3. Log every run — including crashes and diverged trainings.
4. **Interleave seeds across ablations** (ablate_A seed 0, ablate_B seed 0, ablate_C seed 0, ablate_A seed 1, …). Running each ablation as a consecutive block lets time-varying noise correlate with the ordering.
5. When the matrix is complete, compute mean delta ± std per ablation.
6. **Classify each component** relative to the noise floor:
   - `|Δ|` inside the noise band → *no measurable contribution* (with the given budget/seeds).
   - `Δ` worse than reference by > noise → *carries load* (magnitude in metric units).
   - `Δ` better than reference by > noise → *hurts* — the component is a candidate for removal; investigate before recommending removal (surprising positives sometimes indicate a bug in the ablation).
   - Crash / divergence → *critical* — the component is required for the system to function at all, not merely to reach the metric.
7. **Do not stop early.** Even after finding a large effect, run the rest of the matrix. Selective ablation is how systems accrete cargo-cult components: everyone "knows" X and Y matter (because those were the ablations that were run) and nobody notices that Z has done nothing for six months.

## Judgment

**Deltas are only meaningful relative to the noise floor.** Report every delta with a comparison to the reference std. A 0.02 improvement claim is very different when the noise floor is 0.005 vs 0.03. If they're comparable, the answer is "we can't tell", not "the effect is small".

**Beware of interactions.** Leave-one-out ablation attributes a component's marginal effect *in the presence of everyone else*. It does not tell you about components that only matter together. If the user needs to understand interactions (does A help only when B is present?), that's a second-phase 2×2 or 2^k grid, not something to sneak into the LOO matrix.

**Report the "no measurable contribution" components too.** They're often the actionable finding — candidates for deletion, simplification, or reduced compute. A study that only shows the wins reads like a defense of the reference; a study that shows the null results reads like an audit.

**Crashes deserve their own line in the report.** "Component X, when removed, causes divergence" is a critical piece of documentation and a stronger form of attribution than "removing X hurts the metric by 5 points". Treat it as such.

**When an ablation improves the metric, don't celebrate — investigate.** A better metric under ablation often means either (a) the component was actively hurting, worth confirming with a targeted study, or (b) the ablation accidentally changed something else too. Rule out (b) before recommending (a).

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **Attribution table** — one row per component with mean delta ± std, classification (load-bearing / no measurable contribution / hurts / critical), and one-line interpretation.
- **Reference and noise floor** — the numbers everything is measured against, prominently. Without them the table cannot be interpreted.
- **Surprising findings** — components that turned out to matter less than expected, or ablations that improved the metric, with follow-up notes.
- **Interaction caveats** — LOO limitations, any interactions the user should be aware of before acting on the results.
- **Where to look**: `ablation.tsv`, the harness script, per-run logs in `ablation/<tag>/`.
