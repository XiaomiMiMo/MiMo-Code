---
feature: workflow-auto-dag
status: in-progress
updated: 2026-07-29
branch: feat/workflow-auto-dag
commits: 57ff02ed5ea76b448893b7c80faaf3a8de4d19ff..<head-sha>
---

# Workflow Auto DAG

## Report

## [S1] Problem

The dynamic Workflow Runtime can run JavaScript agents concurrently and resume them from its persisted journal, but users must currently author the orchestration script themselves or choose a fixed built-in workflow. There is no `/workflow <task>` entry point that asks the primary agent to turn a natural-language task into a customizable, validated task DAG with an independent acceptance gate and bounded rework.

## [S2] Design

### Slash-command contract

Add the experimental `/workflow <task>` command beside `/deep-research`. Its expanded prompt instructs the current primary agent to:

1. interpret `$ARGUMENTS` as natural language, optionally containing a JSON object that overrides node roles, prompts, models, tools, dependencies, verifier behavior, or the rework bound;
2. generate one self-contained inline JavaScript workflow whose static `meta` describes the run;
3. express implementation work as nodes passed to the sandbox `dag()` primitive, with each node carrying a stable ID, role, prompt, model, tools, and `dependsOn` list as needed;
4. launch each node through `agent()`, passing dependency results into its prompt and preserving the node's explicit role/model/tool choices;
5. run a fresh verifier agent only after the implementation DAG settles; the verifier judges the original task and concrete outputs independently, returns structured acceptance evidence, and cannot be the same call as an implementer;
6. perform at most the requested number of rework rounds (default 2, hard prompt-level cap 3), re-running the verifier after every round; return an honest non-accepted result when the bound is exhausted;
7. invoke `workflow({ operation: "run", script, args })` and relay its terminal result and run ID without claiming acceptance unless the verifier accepted it.

The command remains behind `MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL`, because its required tool is behind the same flag. Invalid or empty user input is handled by the primary agent through one concise clarification rather than launching a guessed workflow.

### Standard DAG primitive

Expose `dag(nodes, run)` in every Workflow Sandbox alongside `parallel()` and `pipeline()`.

- Each node is an object with a non-empty, unique string `id` and optional `dependsOn: string[]`.
- Validate the complete graph before invoking `run`: reject malformed nodes, duplicate IDs, duplicate dependencies, self-dependencies, unknown dependency IDs, and cycles with actionable `dag:` errors.
- Use Kahn topological sorting to produce deterministic ready batches in declaration order.
- Execute every ready batch concurrently with `Promise.all`; begin a node only after all dependencies completed.
- Invoke `run(node, dependencies)`, where `dependencies` is an ordered array of `{ id, result }` following the node's `dependsOn` order.
- Resolve to an array of `{ id, result }` in original node declaration order. The primitive does not interpret `null` or domain-specific verifier output; workflow scripts own those policies.

Concurrency remains bounded by the Runtime's existing process-wide and per-run semaphores because DAG nodes call the existing `agent()` host hook. Persistence and recovery remain content-journal based: completed `agent()` calls replay on `resume`, while unfinished DAG nodes execute again. No new database schema is required.

### Safety and failure behavior

Graph validation runs entirely before node execution, so an invalid DAG launches zero agents. Script logic errors, including DAG structural errors, fail the workflow loudly through the existing sandbox error path. Agent transport failures retain the existing `agent() => null` and bounded transport retry contract; generated scripts must treat a required node's `null` result as a failed deliverable and must not report verifier acceptance.

The existing nested-workflow lineage guard remains unchanged. It detects recursion between workflow scripts; `dag()` separately detects cycles between task nodes within one script.

## [S3] Out of Scope

- A visual DAG editor or new TUI detail layout.
- A new persisted DAG/node database schema; recovery continues to use the existing script and agent-result journal.
- Executing arbitrary JavaScript supplied directly by the user without primary-agent mediation.
- Automatically merging branches, opening pull requests, or approving destructive operations.
- Replacing `/compose-next` or the legacy built-in `compose` workflow.
- Treating a verifier verdict as a security boundary; it is an independent quality gate within the workflow.

## Tasks

- [ ] T1: add and test the sandbox `dag(nodes, run)` primitive — acceptance: valid dependency graphs execute in deterministic concurrent batches and return declaration-ordered results; every malformed-reference and cycle case rejects before any callback runs (covers: S2)
- [ ] T2: register and test `/workflow <task>` behind the workflow feature flag — acceptance: command autocomplete/listing exposes `workflow` only when the tool is enabled, and its expanded prompt requires inline DAG generation, role/prompt/model/dependency customization, independent verifier evidence, and bounded rework (covers: S2)
- [ ] T3: update model-facing workflow documentation — acceptance: the workflow tool contract names `dag()` and explains how scheduling, persistence recovery, task-cycle detection, verifier separation, and rework bounds compose (covers: S2)
- [ ] T4: run focused tests, workflow regression tests, typecheck, and diff checks — acceptance: all relevant commands pass from `packages/opencode` (covers: S2)
