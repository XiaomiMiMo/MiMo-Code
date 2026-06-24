# Spec Compliance Reviewer Prompt Template

Use this template when dispatching a spec compliance reviewer subagent.

**Purpose:** Verify the implementation matches the spec it claims to cover — nothing
missing, nothing misinterpreted, nothing extra — and return a machine-checkable
verdict the controller can gate on.

This reviewer runs in **two phases**. Dispatch phase 1 first. Dispatch phase 2 only
if phase 1 flags anything (if phase 1 is all-pass there is nothing to downgrade, so
skip phase 2).

## Phase 1 — independent judgment (no implementer report)

Dispatch with the spec section text and the diff ONLY. Do NOT include the
implementer's report — its claims would anchor the reviewer toward confirming what
was reported and away from finding what was silently omitted.

Dispatch a spec-compliance reviewer as a `general` subagent via the `actor` tool,
following the syntax in that tool's own description. Use a title like "Spec
review Task N — phase 1" and give it this prompt:

~~~
You are verifying whether an implementation matches its specification. Judge
INDEPENDENTLY. You are given the spec sections the task must satisfy and the
code diff — nothing else. There is deliberately no implementer report; do not
ask for one.

## Spec sections this task covers

[Controller pastes verbatim text of the covered [Sn] spec sections]

## Git range to review

[If the work was done in an isolated worktree, add a line here: "Run all commands
from `<worktree path>` — `cd` there first." Omit this if there's no separate
worktree; the current checkout is correct by default.]

**Base:** {BASE_SHA}
**Head:** {HEAD_SHA}

```bash
git diff {BASE_SHA}..{HEAD_SHA}
```

## Your job

1. Read each covered spec section and enumerate the distinct, checkable CLAIMS
   inside it (a section usually contains several). A claim is one verifiable
   statement about required behavior.
2. For each claim, decide if it is in scope for THIS task. The task covers a
   subset of the section; claims other tasks own are out of scope here.
3. For each in-scope claim, verify it against the diff. Remember: the diff shows
   what changed, not what is missing. A required behavior with no corresponding
   code is a FAIL even though no diff line points to it — actively look for
   omissions.
4. Evidence is mandatory. A claim's status is backed by a test name, command
   execution output, or a `file:line` reference. A status asserted without such
   evidence is `fail`. Prose like "looks implemented" is NOT evidence.
5. If a claim describes runtime behavior you cannot judge from the diff alone,
   run the relevant test or command and cite the output. If you cannot verify it,
   mark it `unverifiable` — never a silent pass.

## Output format (return EXACTLY this structure)

**Status**: pass | fail
(pass only if every in-scope claim is `pass` with evidence)

**Claims**:
- [Sn · "<short claim text>"] in-scope · status: pass
  evidence: <test name | command output | file:line>
- [Sn · "<short claim text>"] in-scope · status: fail
  evidence: <what's missing or wrong, with file:line if applicable>
- [Sn · "<short claim text>"] out-of-scope-for-this-task
- [Sn · "<short claim text>"] in-scope · status: unverifiable
  evidence: <why it can't be verified from available material>

**Extra work not traced to any covered claim**:
- <file:line — what was built that no covered claim required, or "(none)">
~~~

## Phase 2 — rationale reconciliation (sees the report)

Only if phase 1 flagged any `fail`, `unverifiable`, or extra work. Give the SAME
reviewer its phase-1 verdict plus the implementer's report. The report may explain a
flagged diff ("that odd line is a deliberate decision described in my report").

Dispatch the same reviewer again as a `general` subagent via the `actor` tool,
with a title like "Spec review Task N — phase 2", and this prompt:

~~~
Here is your phase-1 verdict and the implementer's report. Use the report ONLY
to explain items you flagged. You may downgrade a flagged item to a phase-2 note
if the report justifies it. You CANNOT add new passes and CANNOT upgrade a
`fail` to `pass` — a report claim is not evidence. If a fail genuinely needs
re-verification with fresh evidence (test/exec/file:line), that belongs in a new
phase-1 re-review after the implementer acts, not here.

## Your phase-1 verdict
[paste phase-1 output]

## Implementer report
[paste implementer's report]

## Output format
**Status**: pass | fail  (unchanged unless a downgrade clears the last failure)
**Claims**: [same structure as phase 1, with any downgraded items annotated]
**Phase-2 notes**:
- [Sn · "<claim>"] downgraded: <report's justification> — was: <prior status>
~~~

**Placeholders:** `{BASE_SHA}`, `{HEAD_SHA}` — commit range for this task. If an
isolated worktree was used, also add a `cd <worktree path>` instruction (see the
note in the Git range section); otherwise the current checkout is correct.

**Reviewer returns:** structured Status + per-claim verdicts. The controller gates on
this (see `compose:subagent`): the task is not complete while any in-scope claim is
`fail` or `unverifiable`.
