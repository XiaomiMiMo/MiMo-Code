---
feature: tool-fifo-gate
status: delivered
updated: 2026-09-21
branch: feat/tool-fifo-gate
---

# Tool FIFO Gate

## Report

**What is built** — Each agent's assistant step owns an independent FIFO gate
for its model-facing tool calls. Only `read`/`grep`/`glob` may overlap. All other
calls, including `actor`/`exec`/`workflow`/`session`, custom tools, and MCP tools,
are serial within that batch. Different agents and sessions never share a gate,
even in the same directory. Exec scripts retain their own `await`/`Promise.all`
semantics for guest calls.

There is no directory registry, filesystem resource identity, hook snapshot,
or orchestration bypass list. Queued cancellation removes the waiter; admitted
calls release after execution and cleanup. This gate does not change the
cancellation behavior of existing tool implementations.

**Verification** — 225 retained relevant tests passed from `packages/opencode`:
33 gate/session cases, 160 tool/agent/question/GPT cases, and 32 filtered
MCP/exec/Codex/GPT session cases. After restoring the original question/plan
implementation, the 21 affected cancellation and question/plan tests were rerun
and passed. Other verified scheduling code is unchanged. Package typecheck
passed; changed-file lint reported zero errors; full-range diff checks passed.
The cancellation regression explicitly releases the old question after stop,
waits for its original gate to drain, then verifies the queued write never ran.
Independent review of the complete corrected scope and this reduction passed
spec compliance, correctness, and consistency with no remaining findings.
The two custom-tool isolation tests were removed: custom tools use the same
execute wrapper, and their fixtures added unrelated npm installation waits.
The remaining 33 gate/session cases passed again after removal, including
independent gates, child-session joins, cancellation, and exec guest calls.

## [S1] Problem

A model can emit multiple tool calls in one assistant step even when the calls
have sequential meaning: edit a file, commit it, then push. Executing these
calls concurrently can omit changes or push before the commit finishes.

The objective is to preserve this one agent's call order, not to coordinate all
agents that happen to use the same workspace or to guarantee filesystem safety
against concurrent actors. Each agent must remain independently runnable.

## [S2] Design

### Ownership and compatibility

`resolveTools` creates a fresh `ToolGate` for one assistant message. Every local,
custom, and MCP model-facing execute wrapper in that resolved map captures that
same gate. The next assistant step gets a new gate. A child agent, another actor
inside the same session, or another session resolves its own tool map and gate.
No global map or directory/agent-name key is involved in batch scheduling.

The pre-existing `edit` mutex remains unchanged: its module-level map uses
`AppFileSystem.resolve(filePath)` and therefore still coordinates edits to the
same resolved path across agents. This PR neither removes that behavior nor
adds new cross-agent filesystem protection. Question/plan cancellation cleanup
is also outside this PR: the `ask` interface and its callers remain unchanged.

```text
agent A, assistant step → gate A → its model-facing calls
agent B, assistant step → gate B → its model-facing calls
```

```text
compatible(a, b) ⇔
  a.tool ∈ {read, grep, glob} ∧ b.tool ∈ {read, grep, glob}
```

All remaining tool names are exclusive against other calls in the same batch.
Classification does not inspect tool arguments, paths, descriptions, skills,
or custom scheduling declarations.

| Surface | Admission |
|---|---|
| Model-facing `read` / `grep` / `glob` | Parallel with each other in this batch |
| Other local/custom/MCP calls | FIFO, one at a time in this batch |
| Top-level `actor` / `exec` / `workflow` / `session` | Same serial rule; no exceptions |
| Child agents' model-facing calls | Their own independent gates |
| Exec builtin/MCP guest calls | Script-controlled `await` / `Promise.all` |

A custom `talk_to_session` may wait for agent B while holding agent A's gate:
B can still execute its own tools. No custom orchestration flag is needed.
The same applies to a parent's synchronous actor/workflow/session wait. The
script calls inside `exec` do not reenter the enclosing top-level gate.

### FIFO and lifecycle

```text
enter(tool, callID, {signal}) → Promise<token>:
  mint a unique token (provider call IDs may collide)
  enqueue and tryAdmit()
  abort before admission → remove waiter, reject, tryAdmit()
  admission → detach queue abort listener

tryAdmit():
  consider only the FIFO head
  stop if it conflicts with any running request
  otherwise move it to running before resolving its promise
  continue while the next head is compatible

leave(token):
  remove/reject that queued waiter, or remove that running slot
  tryAdmit()
```

A queued serial call prevents later reads from jumping ahead. Double leave is
idempotent. Cancelling a queued serial call permits compatible followers to run.
The gate lives with its tool-map closures and has no process-wide registry.

`gate.run` uses `Effect.acquireUseRelease`: register synchronously, install
release, await admission in the interruptible use phase, check the abort signal
before starting the body, and release after the body and cleanup exit. Persisting
a failed tool status alone does not prove that execution or cleanup ended.

Cancelling a batch must remove queued calls so they cannot execute later, even
if an already-running tool completes after the model turn has stopped. Existing
question/plan waiting and UI cleanup behavior is unchanged; the next assistant
step owns a different gate and is not held by a previous step's unfinished tool.

### Integration and prompts

Local and MCP model-facing wrappers hold admission across their existing
execute pipelines, including hooks and permission checks. Hooks retain their
live loading behavior. Direct MCP and exec guest surfaces share the pipeline
body; only the direct model-facing surface uses the batch's gate.

No provider or AI SDK execution changes. Max-mode replay is already sequential.
Ordinary prompts omit cross-tool parallel/serial teaching. Advice for shell
commands inside one `bash` call remains valid.

## [S3] Out of Scope

- Adding coordination or filesystem exclusion across agents, sessions, assistant
  steps, processes, or external editors. Existing tool-local locks are preserved.
- Inferring semantic dependencies, filesystem aliases, or custom tool behavior.
- Changing concurrency inside exec scripts or workflow execution.
- Expanding GPT/Codex safety beyond the same top-level scheduling rule and
  regression checks for guest execution.
- Provider stream reordering or bash command classification.

## [S4] Previous Designs and Why They Were Replaced

### Directory-wide scheduling

The previous design stored one gate per `Instance.directory`. This expanded a
single model batch's ordering requirement into cross-agent exclusion. A custom
session-chat tool could hold A's gate while waiting for B, but B's read/write
would need the same gate. The desktop's timeout eventually broke the wait with
an error. Adding actor/workflow/session bypasses only handled known tool names;
it could not correct the ownership mistake or account for all custom tools.

The replacement owns the gate in one agent's assistant step. B therefore never
needs A's gate. All top-level orchestration bypasses are removed, and third-party
tools need no new scheduling metadata. Different agents remain concurrent.

### Path-based write parallelism

The earlier design also allowed `edit`/`write` to overlap when their canonical
file resource keys differed. Relative paths used the session directory; existing
files used realpath, and new files attempted to canonicalize their parent.
Reads still formed their own parallel class, and other tools were barriers.

Review and real-session/filesystem reproductions exposed these boundaries:

| Corner case | Why path-based admission was insufficient |
|---|---|
| Session directory differs from process cwd | A key can identify a different file from the one the tool actually accesses. |
| Earlier command retargets a symlink | Keys computed while queueing become stale before the writes start. |
| New-file aliases | A missing file has no final realpath; different spellings can later refer to one file. |
| Case-insensitive and Unicode names | ASCII lowercasing is insufficient: Greek sigma/final sigma and micro sign/Greek mu can alias on real filesystems. |
| Parent traversal and other filesystem aliases | Lexical path normalization can disagree with actual filesystem traversal; hardlinks add another identity dimension. |
| Before hooks rewrite `file_path` | Distinct original paths can become the same destination after admission; asynchronous hooks can reverse write completion order. |

We explored admission-time realpath refresh, conservative handling of unresolved
paths, and freezing before-hook callbacks with exclusive hooked writes. Those
approaches required additional identity rules and changes to hook refresh
semantics. They made a small scheduling optimization harder to reason about and
verify across supported filesystems.

The chosen emergency tradeoff is to serialize all ordinary writes and other
non-read tools. File edits are usually short compared with model token generation,
so the expected benefit of overlapping them is limited; formatters, LSP work,
and large independent write batches can make the difference larger. This is a
qualitative tradeoff, not a benchmark claim. Read/search parallelism is retained,
while the runtime no longer needs to prove that two writes target different files
or predict how hooks will rewrite them.

## Tasks

- [x] T1: Implement FIFO admission and unique tokens — acceptance: read/search concurrency, exclusive ordinary tools and FIFO head-of-line tests pass (covers: S2)
- [x] T2: Wrap local and MCP execute pipelines — acceptance: real-session ordering and cancellation regressions pass (covers: S2)
- [x] T3: Export the gate from the tool module — acceptance: consumers import the stable tool module path (covers: S2)
- [x] T4: Verify supported paths — acceptance: relevant tests, package typecheck and lint finish successfully (covers: S2, S3)
- [x] T5: Remove ordinary prompt scheduling instructions — acceptance: prompt tests pass and the live checkpoint writer follows the same contract (covers: S2)
- [x] T6: Simplify to read/search parallelism only — acceptance: edit/write serialize without resource keys or hook snapshots (covers: S2)
- [x] T8: Preserve the previous design and decision rationale — acceptance: S4 records reproduced corner cases and the performance tradeoff (covers: S4)
- [x] T9: Scope each gate to one agent's assistant step — acceptance: separate gates admit independently, and a parent session join does not block its child's tools in the same directory (covers: S1, S2)
- [x] T10: Remove all top-level bypasses — acceptance: actor/exec/workflow/session obey the same serial rule, while exec guest calls retain script-owned concurrency (covers: S2)
