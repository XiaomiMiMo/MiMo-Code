# Conclusion Writing Guide

## Goal

Close the paper with clear takeaways and credible limitations.

## Structure

1. Restate solved problem and core technical idea.
2. Summarize strongest evidence from experiments.
3. State practical impact or new insight.
4. Add limitation paragraph.
5. End with concrete future direction.

## Limitation Guidance

Prefer limitations tied to task goal/setting boundaries, for example:

1. Data regime limitation (e.g., only short sequences).
2. Assumption limitation (e.g., controlled viewpoints only).
3. Deployment scope limitation (e.g., specific sensor setup).

Avoid framing conclusion around fixable implementation flaws unless they critically define your method's scope.

## Distinguish Limitation Types

1. Technical defect: underperforms strong baselines on key metrics or causes unacceptable tradeoff.
2. Scope limitation: bounded by current task setting and still competitive vs. current SOTA.

## Template

1. This paper addresses [problem] by proposing [method].
2. The key idea is [core insight], which enables [main benefit].
3. Experiments show [main gains] across [datasets/settings].
4. A current limitation is [scope boundary], and extending to [future setting] is an important next step.
