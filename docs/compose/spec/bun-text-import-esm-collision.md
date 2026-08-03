---
feature: bun-text-import-esm-collision
status: designed
updated: 2026-08-03
branch: fix/workflow-script-ext
commits: <base-sha>..<head-sha>
---

# Built-in workflow scripts collide with the ESM parser under `bun test`

## Report

## [S1] Problem

`bun test test/cli/tui` in `packages/opencode` reports one failure and one error that no
assertion produced:

```
test/cli/tui/thread.test.ts:

# Unhandled error between tests
-------------------------------
1 | export const meta = {
    ^
error: Top-level return cannot be used inside an ECMAScript module
    at .../packages/opencode/src/workflow/builtin/fact-check.js:1:1
```

No named test is ever marked as failing. The same event is counted once as `1 fail` and
once as `1 error`, and the run executes one test fewer than the same files executed
separately, so the loss is a module that failed to load rather than an assertion that
failed.

### [S1.1] Why the scripts are not modules

The four files under `src/workflow/builtin/` are workflow **function bodies**, not ES
modules. Each ends in a top-level `return` — `compose.js:731`, `deep-research.js:221`,
`fact-check.js:381`, `research-experiment.js:173` — because the runtime evaluates them
inside a function wrapper.

They therefore reach the program as raw text, through import attributes in
`src/workflow/builtin.ts:13-19`:

```ts
// @ts-expect-error TS1192: import-attribute text loader, resolved by Bun not tsgo
import FACT_CHECK_SCRIPT from "./builtin/fact-check.js" with { type: "text" }
```

The comment above those imports records why a `Bun.file(...).text()` fallback is not used:
it would read the real filesystem at runtime, which does not exist inside a compiled
standalone binary. The text loader also embeds the script into that binary.

Nothing in this repository asks for those files as modules. The error means one of the
loads took the ESM path anyway, and a top-level `return` is a syntax error there.

### [S1.2] What was measured

Bun 1.3.14.

**Minimal reproduction — two files, either order:**

```
cd packages/opencode
bun test test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts
```

Three tests run where the two files run four separately; one fails, one error. Each file
passes alone. Reversing the argument order changes nothing, so it is not an ordering
artifact.

**Resolution counts.** A `Bun.plugin` `onResolve` hook over
`/builtin\/[a-z-]+\.js$/`, loaded with `--preload`, logged every resolution and its
importer:

| Command | Resolutions of the builtin scripts | Result |
| --- | --- | --- |
| `plugin-toggle.test.ts` alone | 0 | pass |
| `thread.test.ts` alone | 116 | pass |
| both files | ~29-30 per script | 1 fail, 1 error |

Two conclusions follow. `thread.test.ts` re-evaluates `builtin.ts` on the order of a
hundred times in one process; `plugin-toggle.test.ts` never loads it at all, so its
contribution is to perturb the other file's loads rather than to import anything. And the
counts are uneven — `deep-research.js` resolved 30 times against `fact-check.js`'s 29 —
which matches a round that aborted between the two, `deep-research.js` being imported first
at `builtin.ts:13` and `fact-check.js` second at `:15`.

**Importer.** Every logged resolution named the same importer,
`packages/opencode/src/workflow/builtin.ts` — the legitimate text import. It is the only
importer of these paths in the repository; the other places that mention a built-in script
by name are prose about user-authored workflows, not imports.

### [S1.3] Hypotheses that were falsified

Recorded so the next person does not re-spend the time.

- **Missing test teardown.** `plugin-toggle.test.ts` installs
  `spyOn(TuiConfig, "waitForDependencies")` and `spyOn(process, "cwd")`, which looked like
  leaked process-global state. It restores both in a `finally` block and disposes the
  plugin runtime; `thread.test.ts` additionally runs `afterEach(() => mock.restore())`.
  Teardown is present in both files.
- **A static and a dynamic import of the same text-loaded module racing each other.**
  `plugin-toggle.test.ts:9` pulls its subject in through a top-level `await import(...)`
  while `thread.test.ts` uses static imports, which suggested two resolution routes with
  only one carrying the attribute. A standalone four-file reproduction — a `script.js` with
  a top-level `return`, a `mod.ts` importing it `with { type: "text" }`, one test file
  importing `mod.ts` statically and another dynamically — does **not** reproduce, together
  or apart.
- **Concurrent re-imports exhausting a cache.** Two hundred parallel
  `import("./mod.ts?v=N")` calls, alone and paired with both of the above, do **not**
  reproduce.

No minimal standalone reproduction has been isolated. The in-repository one above is
reliable.

### [S1.4] Why continuous integration is green

`.github/workflows/test.yml:40` runs `bun run test:ci --shard ${{ matrix.shard }}` across a
four-way matrix, and `test:ci` in `packages/opencode/package.json` is `bun test` with a
JUnit reporter. Sharding distributes test files over four separate processes, so the two
files that collide are usually not in the same one. The fault is a property of a process
that loads both, not of either file.

### [S1.5] Assessment

This looks like a Bun defect. A static import carrying `with { type: "text" }` must resolve
to the text loader every time; the same specifier from the same importer must not sometimes
reach the ECMAScript parser. The evidence supporting that reading is that the importer is
constant and legitimate across all logged resolutions, that no other importer exists, and
that only a minority of the many loads fail. The evidence against a confident upstream
report is the absent standalone reproduction: the trigger involves a module being
re-evaluated on the order of a hundred times in one test process, and the conditions for
that have not been reduced.

## [S2] Design

No code change is proposed for merge. Continuous integration is green, the failure is
confined to running two specific files in one local process, and the repository's own rule
is that a locally-failing, CI-green test is not a feature branch's work. This document is
the deliverable.

### [S2.1] Recommended workaround, if it is ever worth removing the exposure

Rename the four scripts so that no loader can mistake them for modules — the ambiguity is
the root of the problem, and a `.js` file containing a top-level `return` is itself a trap
for readers and tools alike.

Proposed extension: `.js.fn`, naming what the file is. The content is a function body; the
top-level `return` is the proof. `fact-check.js` becomes `fact-check.js.fn`.

Scope of the change:

- the four import specifiers at `builtin.ts:13-19`;
- the four `file:` values at `builtin.ts:36-39`.

The `file:` field is only used to name the offending script when `parseMeta` rejects it
(`builtin.ts:32` comment, thrown at `:48`). It does not participate in matching a
user-supplied override, so changing those strings is safe.

Two points to confirm before adopting it, neither verified here:

- whether `@ts-expect-error TS1192` remains correct. With a non-module extension, tsgo may
  stop reporting TS1192, at which case the unused suppression becomes an error in its own
  right and the line needs a different treatment.
- whether `bun build --compile` still embeds the text import under the new extension. The
  loader is selected by the import attribute rather than the extension, so it should, but
  the compiled binary is the reason the text import exists and deserves an explicit check.

Note that user-authored workflows keep the `.js` convention documented in `README.md`: they
are read from disk at runtime rather than through an import attribute, so they are not
exposed to this and are not part of the rename.

### [S2.2] Narrower alternative

Make `plugin-toggle.test.ts:9` a static import so the process has one resolution route.
This addresses a symptom of unclear provenance rather than the ambiguity, and would leave
the next test file that re-evaluates `builtin.ts` free to reintroduce the fault.

## [S3] Out of Scope

- Any change to the four scripts' contents.
- Reporting upstream. The absent standalone reproduction makes a useful report hard to
  write; the in-repository reproduction and the measurements above are recorded here so a
  report can be assembled later without repeating the investigation.
- The `thread.test.ts` re-evaluation itself. Why one test file loads `builtin.ts` on the
  order of a hundred times was not investigated and may be worth its own look.

## Tasks

None. This document records an investigation; no implementation is queued.
