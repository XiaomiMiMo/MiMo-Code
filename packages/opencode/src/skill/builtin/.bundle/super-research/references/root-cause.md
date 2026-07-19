# Mode: Root-cause investigation / 根因排查

Use when the user reports a **broken observation and wants to know why** — a regression ("this used to work"), an intermittent failure ("flaky, ~1 in 20"), a performance degradation ("2× slower since Friday"), a suspicious metric ("conversion dropped 8% overnight"), a mysterious behavior ("only fails in prod"). Triggers include "why is X broken", "root cause this", "debug this regression", "排查", "定位", "复盘", "find why the tests are flaky".

The failure mode this mode is designed against: **stopping at the first plausible-sounding explanation.** Almost every regression has multiple correlates; the first one you find is rarely the cause. Root cause requires a demonstration — the ability to turn the symptom on and off by touching one thing.

## Contract fields

1. **Symptom**: A crisp, reproducible statement of what's broken. Concrete example — command / input / URL / test name / metric threshold. If the user says "it's slow", negotiate to "endpoint /X p95 latency > 800ms on payload P (was ~150ms two weeks ago)". Vague symptoms produce vague investigations.
2. **Repro**: A single command or script that reproduces the symptom on demand. If it's flaky, note the reproduction rate ("~1 in 20 runs"). If you cannot reproduce it at all, the first phase of the loop is *reproduction*, not root-cause — say so in the contract, don't skip ahead.
3. **Known-good reference**: A commit, environment, config, or time window where the symptom was NOT observed. This is what makes bisection possible. If none is known, negotiate one — often the user knows "it worked on Monday" or "it works in staging".
4. **Blast-radius rules**: What are you allowed to touch during investigation? Production reads are usually fine; production writes and destructive actions are not without explicit sign-off. Note these in the contract so you don't have to ask mid-loop.
5. **Stopping criterion**: The default is "cause identified and demonstrated by a targeted fix or a targeted reintroduction". A weaker "here are the top-3 suspects, ranked" is acceptable only when the contract explicitly allows it (e.g. non-reproducible in the environment you have access to).
6. **Working directory**: A dedicated `investigation/<tag>/` folder — the repro script, log, evidence, any patches.

## Baseline — quantify the symptom

Your baseline is not "the code before my changes"; it's the **symptom made measurable**. Before any hypothesizing:

- Run the repro N times (10–30 for flakes) and record: pass/fail rate, timing distribution, error messages verbatim. Save this to `baseline.md`. This is what you're going to move.
- Run the same repro against the known-good reference and record the same numbers. The gap between these two is the size of the effect you're trying to explain.
- Any hypothesis that doesn't predict a change of the right sign and rough magnitude in this gap is a distraction. Later, this baseline is also how you'll verify the fix.

## The hypothesis log

`hypotheses.tsv` (tab-separated), one row per hypothesis considered — including ones you rule out early:

```
id	hypothesis	prediction	test	result	status	notes
H01	env var X was unset in prod after Fri deploy	symptom reproduces locally when X is unset	unset X; run repro 20×	20/20 pass — X does NOT reproduce it	ruled-out	
H02	commit abc123 (retry-loop change) is the trigger	git bisect between last-good and HEAD lands on it	bisect 12 commits, ~4 steps	landed on abc123	suspect	
H03	abc123's off-by-one causes double-close on retry	reverting abc123 alone fixes the symptom AND replaying the diff onto known-good REINTRODUCES the symptom	revert + rerun 30×; cherry-pick onto old + rerun 30×	revert: 30/30 pass. cherry-pick: 28/30 fail (matches baseline rate)	confirmed	both directions match — this is the cause
H04	load balancer stickiness change same day	drops out under H03 if we can reintroduce symptom on isolated node	—	—	unexplored	deprioritized after H03 confirmed
```

- **prediction** — what you'd expect to see if the hypothesis were true, before you run the test. Fill this in *before* the result column. If you can only articulate the prediction after seeing the result, you're pattern-matching, not testing.
- **status** — `unexplored` / `testing` / `ruled-out` / `suspect` / `confirmed`. A `suspect` becomes `confirmed` only when both directions of the causal test agree.

**Log ruled-out hypotheses.** They are the evidence that you actually tried to falsify your favorite theory instead of just confirming it. A log with one entry and status=confirmed is not investigation, it's a guess written down.

## The loop

LOOP UNTIL a hypothesis is `confirmed` OR the stopping criterion is otherwise met:

1. **If the repro is flaky or absent, fix that first.** Investigation on top of an unreliable baseline is folly — you cannot tell whether your intervention worked. Adjust seeds, isolate the failing case, run more iterations, until the repro rate is stable enough to distinguish signal from noise.
2. Pick the most informative next hypothesis — the one whose test result would split the remaining space of causes fastest.
   - **Prefer bisection over guessing.** If a bad commit exists between last-good and HEAD, `git bisect` finds it in log₂(N) steps and doesn't rely on cleverness. Do this before elaborate theorizing.
   - **Prefer diffing environments.** For "works here, fails there" problems, systematically diff env vars, versions, config, hardware, timing — the two environments are the two conditions of a natural experiment.
3. Write the prediction *before* running the test. Then run it.
4. Log the result. Update the status.
5. **Never stop at `suspect`.** A hypothesis is confirmed only when the causal test passes in both directions: (a) removing the suspect eliminates the symptom, AND (b) reintroducing the suspect (or its critical part) brings the symptom back at the baseline rate. One direction can pass for confounded reasons. Two directions rarely both agree by accident.
6. Loop.

## Judgment

**Correlation is not cause; two-way reversal is cause.** The bisected commit, the changed env var, the newly deployed dependency — all are suspects, not conclusions. Until you have shown "remove it → symptom gone, put it back → symptom returns", you have a lead, not a root cause. This distinction is the difference between real debugging and confident hand-waving.

**Beware the fix that "just makes it work".** Sprinkling a `try/except`, adding a retry, bumping a timeout — these can silence a symptom without touching the cause. If the mechanism you can articulate does not predict the exact symptom you observed, keep going. "It works now" is the second-easiest way to fool yourself, right after "I found something suspicious in the diff".

**Prefer disproof to proof.** Ask "what test result would prove me wrong?" — if you can't articulate one, the hypothesis isn't scientific yet, it's a story. Design tests to falsify your leading candidate, not to reconfirm it.

**Contributing factors vs root cause.** Sometimes the honest answer is "A is the trigger but only because B was already there" — e.g. a race that had always been possible was exposed by a scheduler change. Report both. Naming only the trigger leaves the vulnerability; naming only the latent bug leaves the reader wondering why now.

**When you can't confirm, say what you narrowed it to.** An investigation that ends with "confirmed in {A, B}, ruled out {C, D, E, F}" is far more useful than one that ends with a guess dressed up as an answer.

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **Root cause** — one sentence naming the cause, with the demonstrated two-way reversal ("reverting X fixes; reapplying X breaks").
- **Symptom → cause chain** — the mechanism, one paragraph. Include contributing factors.
- **Evidence** — pointer to `hypotheses.tsv` and the specific H-IDs that carried the demonstration.
- **Ruled out** — the top alternatives you eliminated, with the tests that eliminated them. This is what distinguishes a diagnosis from a guess.
- **Fix / mitigation** — the minimal change that addresses the root cause (if in scope), and any latent-bug follow-ups worth filing.
- **Where to look**: `hypotheses.tsv`, `baseline.md`, the repro script, `investigation/<tag>/`.
