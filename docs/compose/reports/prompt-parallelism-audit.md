# Default Tool Prompt Audit

Audited base: `4489fe50`.

## Scope and change

This change addresses excessive tool-call batching within one step on the default
model path. It removes one sentence from `tool/glob.txt`:

> It is always better to speculatively perform multiple searches as a batch that are potentially useful.

The remaining description still explains file matching and routes open-ended
investigations to actor. Parallel actor delegation is valid and remains unchanged.
GPT/exec, other model-specific prompts, plan-mode subagent guidance, and bundled
research/Compose/sales workflows are outside this change's scope.

## Default-path findings

| Source | Finding | Action |
| --- | --- | --- |
| `session/prompt/default.txt` | “Prefer 1–3 tool calls per step. Avoid more than 8 calls in a single step.” | Preserve the count guidance. It no longer recommends parallel calls. |
| `tool/glob.txt` | Claims speculative batched searches are always better. | Remove this sentence. It encourages searches without an identified need. |
| `tool/grep.txt` | Does not contain the speculative-batching sentence. | No change. |
| `tool/read.txt` | Allows several reads when the required files are already known. | Preserve permission for known targets. |
| `tool/bash.txt` | Earlier parallel-call and repeated git batching advice was already removed by #2456. | No change. Preserve dependency ordering. |
| `tool/actor.txt` and `tool/actor.shell.txt` | Describe parallel background delegation. | Preserve. Parallel actors are distinct from speculative search-tool batches within one step. |
| `agent/prompt/explore.txt` and `agent/prompt/general.txt` | Repeat the existing 1–3/eight-call guidance. | Preserve. |

The screenshot included older wording already changed by #2456 (`4101b3d4`).
The flooding guard added in #2463 uses a separate runtime threshold at call 17;
this prompt-only change does not alter scheduling, execution, or that threshold.

## Verification

- Reviewed the final diff against the audited base: the only product change is
  deleting the speculative-batching sentence from glob's description.
- Confirmed the default, explore, and general prompts retain their call-count
  guidance and actor delegation descriptions are unchanged.
- PASS: `bun test test/tool/glob.test.ts` from `packages/opencode`: two tests,
  five assertions, zero failures.
- PASS: `git diff --check`.
