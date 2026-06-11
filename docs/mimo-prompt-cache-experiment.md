# MiMo Prompt Cache Experiment

Date: 2026-06-12

## Purpose

Measure MiMo prompt-cache behavior before changing the request prefix, then
decide whether a cache-oriented refactor is justified.

The experiment focused on these questions:

1. Does MiMo return usable prompt-cache metrics?
2. How much prefix is reused within the same session?
3. How much prefix is reused across fresh sessions in the same project?
4. How much prefix is reused when the project directory changes?

## Current Implementation

MiMoCode already parses the provider's cached-token count and stores it as
`tokens.cache.read`.

Relevant code:

- `packages/opencode/src/session/session.ts`: normalizes provider cache-read
  tokens.
- `packages/opencode/src/session/processor.ts`: emits per-model-call cache and
  latency metrics.
- `packages/opencode/src/session/system.ts`: places working directory, workspace
  root, git status, platform, and date in the environment system prompt.
- `packages/opencode/src/session/llm.ts`: appends memory instructions containing
  project- and session-specific absolute paths.
- `packages/opencode/src/session/prompt.ts`: assembles environment, skills, and
  instruction-file content before building the final LLM prefix.

## Method

The controlled probe used:

- Model: `xiaomi/mimo-v2.5-pro`
- Agent: `plan`
- Prompt behavior: no tools, short `OK` response
- Same model, agent, and project configuration for comparable calls
- Calls made within a short interval to remain inside the likely cache TTL

For each call:

```text
cache hit rate = cache_read / (input + cache_read)
```

The following groups were measured:

1. Warm-up request in a new project.
2. Four additional requests in the same session.
3. Four forked sessions from the warmed parent.
4. Four fresh sessions in the warmed project.
5. First and second fresh sessions in a different project directory.
6. A smaller `mimo/mimo-auto` probe.

## Results

### Xiaomi MiMo v2.5 Pro

| Condition | Cache hit rate | Avg uncached input | Avg cache read | Avg cost |
|---|---:|---:|---:|---:|
| Same session, after warm-up | 99.57% | 92 | 21,408 | $0.00446 |
| Fresh session, warmed project | 76.72% | 4,971 | 16,384 | $0.00841 |
| First request, different project | 9.59% | 19,304 | 2,048 | $0.01979 |

Observed cache boundaries:

```text
Globally reusable prefix:       approximately 2K tokens
Project-reusable prefix:        approximately 16K tokens
Same-session reusable prefix:   approximately 21K tokens
```

Detailed observations:

- Same-session requests consistently reused nearly the entire prior prefix.
- Fresh sessions in a warmed project consistently reused exactly 16,384
  tokens, leaving approximately 5K tokens uncached.
- The first request in another project reused only 2,048 tokens.
- The second fresh session in that new project reused 16,384 tokens.
- Forked sessions initially reused 4,096 tokens, then stabilized at 16,384
  tokens. They did not match the parent session's near-total reuse.

### MiMo Auto

`mimo/mimo-auto` also returned cache metrics and eventually reused large
prefixes, but its behavior was less immediate:

- Initial same-session calls reused only 2,048 tokens.
- A later fresh session reused 16,384 tokens.
- A later call in the original session reused approximately 20,800 tokens.

This suggests cache propagation delay or backend-routing variability in the
Auto channel. A pinned model is preferable for deterministic cache experiments.

## Interpretation

The experiment confirms that MiMo prompt caching is active and measurable.

Same-session caching is already effective and should not be redesigned. The
main opportunity is cross-project reuse:

- A new project currently causes approximately 19K uncached input tokens.
- Once that project is warmed, fresh sessions reuse approximately 16K tokens.
- Therefore, project-specific data appears early enough in the prefix to break
  reuse after the first approximately 2K tokens.

Fresh sessions within the same project still leave approximately 5K tokens
uncached. That is likely caused by session-specific content, including memory
paths and session identifiers, but it should be addressed separately because it
touches memory behavior.

## Recommended PR Split

### PR 1: Improve Cross-Project Prefix Reuse

Goal:

- Move project-specific environment context after the large stable prefix.
- Preserve all current environment information and model behavior.
- Avoid changing session memory semantics.

Proposed scope:

- Split `SystemPrompt.environment()` into stable and project-specific parts.
- Keep stable agent/model/language instructions early.
- Place working directory, workspace root, git status, platform, and date after
  skills and project instruction-file content.
- Add tests proving the stable portion is identical across projects and dynamic
  context remains present at the end.

Expected outcome:

- Improve the first request in a new project from approximately 2K cached tokens
  toward the approximately 16K warmed-project boundary.

### PR 2: Improve Fresh-Session Prefix Reuse

Goal:

- Reduce the approximately 5K uncached input observed in fresh sessions within
  the same project.

Potential scope:

- Move session-specific memory paths and identifiers later in the prefix.
- Consider symbolic memory path aliases.
- Add memory, resume, fork, and checkpoint regression coverage.

This should remain separate because it has a higher behavioral risk.

## Acceptance Criteria for PR 1

After implementation, rerun the same controlled probe.

The change is considered useful if the first request in a different project:

- Reuses materially more than 2,048 cached tokens, ideally near 16,384.
- Reduces uncached input by at least 4K tokens.
- Does not reduce same-session cache hit rate.
- Preserves environment information and existing tests.

## Current Work Status

- Experiment completed.
- Results recorded in the LLM-Wiki lab notebook.
- Branch created: `perf/project-prefix-cache`.
- No source-code changes have been applied.
- No commit or pull request has been created.

