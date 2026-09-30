# Paper Review

## Goal

Use an adversarial, reviewer-style checklist to detect reject risks early and revise the paper before submission.

## Core Principle

Pursue perfectionism in paper quality: assume reviewers will probe every weak point and proactively fix them.

## Critical Rule (Do Not Violate)

Every major claim, especially in Abstract and Introduction, must be:

1. technically correct, and
2. explicitly supported by experimental evidence.

If a claim is not supported, either add evidence or weaken/remove the claim.

## What Usually Gets a Paper Accepted

1. Sufficient contribution (for example: novel task, novel pipeline, novel module, novel design choices, new experimental findings, or new insight).
2. Better empirical performance than prior methods under fair comparisons.
3. Sufficient comparison experiments and ablation studies.

## Common Rejection Dimensions

| Rejection Dimension          | Typical Failure Signals                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Insufficient contribution | 1.1 Targeted failure cases are too common.<br /> 1.2 Proposed technique is already well explored; expected gains are predictable/well-known.                                                                                                                                               |
| 2. Unclear writing           | 2.1 Missing technical details; work is not reproducible.<br />2.2 A method module lacks clear motivation.                                                                                                                                                                                  |
| 3. Weak empirical effect     | 3.1 Improvement over prior methods is only marginal.<br /> 3.2 Even if better than previous methods, absolute performance is still not strong enough.                                                                                                                                      |
| 4. Incomplete evaluation     | 4.1 Missing ablation studies.<br />4.2 Missing important baselines or important evaluation metrics.<br /> 4.3 Datasets are too simple to prove the method truly works.                                                                                                                    |
| 5. Problematic method design | 5.1 Experimental setting is unrealistic.<br />5.2 Method has technical flaws and appears unreasonable.<br />5.3 Method is not robust and needs per-scenario hyperparameter tuning. <br /> 5.4 New design introduces stronger limitations than its benefits, leading to negative net value. |

## End-of-Paper Self-Review Question List

Add this checklist near the end of the draft while revising.
Use each question to trigger concrete edits before submission.

### 1. Contribution

1. What new knowledge does this paper give to readers?
2. Are we solving a truly meaningful failure case, not a trivial/common one?
3. Is the technical idea genuinely non-obvious beyond well-explored practice?
4. Is our gain surprising or insightful rather than a predictable improvement?
5. Is there at least one clear novelty type (task/pipeline/module/design finding/insight)?

### 2. Writing Clarity

1. Can a knowledgeable reader reproduce the method from the paper?
2. Did we provide enough technical detail for each key module?
3. Is the motivation of every module explicit and logically connected to a challenge?
4. Are terms and notation consistent across sections?
5. Does each paragraph carry one clear message with smooth transitions?

### 3. Experimental Strength

1. Are improvements over strong baselines meaningful, not just statistically tiny?
2. Is absolute performance competitive enough for the target venue?
3. Are gains consistent across multiple datasets/settings/metrics?
4. Do we report both strengths and failure cases honestly?

### 4. Evaluation Completeness

1. Do we include ablations for all key design choices?
2. Are all strong/recent baselines included under fair settings?
3. Are evaluation metrics standard and sufficient for this task?
4. Are datasets/scenarios challenging enough to validate real effectiveness?
5. Are comparison and ablation protocols clearly documented?

### 5. Method Design Soundness

1. Is the experimental setting realistic for practical use?
2. Does the method have hidden technical defects or unreasonable assumptions?
3. Is the method robust without heavy per-case hyperparameter retuning?
4. Do benefits outweigh added complexity and new limitations?
5. Could reviewers reasonably argue that the net benefit is negative?

## Adversarial Writing Workflow

1. Read the paper as a skeptical reviewer.
2. Answer every question above with explicit evidence from the paper.
3. Mark each item as `pass`, `needs revision`, or `needs new experiment`.
4. Revise claims, writing, experiments, or method scope accordingly.
5. Repeat until no major rejection risk remains.
