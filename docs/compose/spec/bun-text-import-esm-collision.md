---
feature: bun-text-import-esm-collision
status: delivered
updated: 2026-08-03
branch: fix/workflow-script-ext
commits: 09d03d67..09122450
---

# Built-in workflow scripts collide with the ESM parser under `bun test`

## Report

**What was built** — The four built-in workflow scripts are no longer imported. A Bun macro
reads them from disk at build time and their source is inlined into the bundle, so the files
never enter the module graph at all and no loader can attempt to parse them. They keep their
`.js` names, so nothing else in the repository moves and they stay within reach of JavaScript
tooling. The four `@ts-expect-error` suppressions the text imports needed are gone, because
the macro is an ordinary typed function.

This fixes the cause rather than the symptom. An earlier iteration renamed the files to
`.js.fn` so that no loader would try; that worked, but it treated the extension as the problem
when module-graph membership was the problem, and it cost the files their lint coverage and
editor highlighting. The macro form was already the house pattern for shipping files inside
the binary — `skill/builtin/bundle.macro.ts` and `skill/compose/bundle.macro.ts` — so this
follows precedent instead of inventing an extension.

**Verification** — All from `packages/opencode`.

| Check | Before | After |
| --- | --- | --- |
| `bun test test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts` | 3 tests ran, 1 fail, 1 error | 4 pass, 0 fail, 0 error |
| `bun test test/cli/tui test/cli/cmd/tui` | 261 pass, 1 fail, 1 error | 262 pass, 0 fail, 0 error |
| `bun test test/workflow` | — | 194 pass, 5 skip, 0 fail |
| `bun typecheck` | passes with 4 suppressions | passes with none |

The test counts rise by one because the test that previously failed to load now runs.

Runtime and packaging were checked separately. In development, `BuiltinWorkflow.list()`
returns all four entries with their meta parsed and script text intact. `bun run build:local`
compiles a standalone binary whose smoke test passes; verbatim body text from the scripts is
present in the binary while no `src/workflow/builtin/` source path occurs in it, so the macro
expanded and the content is inlined rather than read from disk — the dev fallback described in
[S2.2] is dead code in a shipped binary, which is the property that matters, since a
standalone binary has no filesystem to read from. Running `mimo debug agent build` from that
binary lists the `workflow` tool, which means `tool/registry.ts` and therefore `builtin.ts`
loaded; `builtin.ts` throws at module init on a missing script or a malformed meta, so a
successful load is positive evidence. `bun.lock` was not modified.

**Journey log**

- Renaming the files to `.js.fn` did fix the failure, and was still the wrong shape. It
  treated the extension as the problem when the problem was that the scripts were in the
  module graph at all. Asking "what is the smallest thing that makes this impossible rather
  than unlikely" produced a better answer than iterating on the first one that worked.
- The macro form was already in the codebase twice for the same job. Searching for precedent
  before inventing an extension would have found it immediately; the earlier design document
  proposed `.js.fn` without ever looking.
- Two Bun macro constraints only surfaced by running into them, in this order: macros are not
  expanded in every transpile path — under `bun test` the import is stripped without the call
  being replaced, giving `ReferenceError: script is not defined` — and macro arguments must be
  statically known, so the per-filename signature that made a typo a build error could not be
  wrapped in the fallback that the first constraint requires. The published pattern in
  `skill/builtin/extract.ts` already encodes both, which is why it takes no arguments and
  imports itself twice. Reading the precedent properly, rather than assuming its shape,
  would have skipped two failed builds.
- Verifying "the text is embedded" needed two observations, not one: the content being
  present in the binary, and no source path being present. Either alone is consistent with
  the wrong outcome.
- Review caught that the abandoned rename would have dropped these files out of oxlint's
  `src/**/*.js` coverage — a cost that design had not stated, and one of the reasons for
  preferring the macro. A rename that moves a file off a language's conventional extension
  takes it out of that language's tooling, which is easy to miss when the motivation is a
  loader problem.

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

### [S2.1] Take the scripts out of the module graph

Nothing imports the scripts any more. `builtin.macro.ts` reads the directory with
`fs.readdirSync` / `fs.readFileSync` and returns a `Record<filename, source>`; `builtin.ts`
consumes it through `with { type: "macro" }`, so the call is evaluated at transpile and the
sources are inlined into the bundle as string literals.

That is what makes the failure impossible rather than unlikely. The collision needed the
scripts to be reachable as modules; a file read at build time never is, whatever it is named.
The files therefore keep their `.js` names, which means no other reference in the repository
moves, they stay inside oxlint's `src/**/*.js` coverage, and editors keep highlighting them
as JavaScript.

This mirrors `skill/builtin/bundle.macro.ts` and `skill/compose/bundle.macro.ts`, which solve
the same problem — ship a directory of files inside a compiled binary that has no filesystem
to read from — the same way.

The registry stays a closed set. The bundle carries whatever the directory holds; `builtin.ts`
lists the four filenames that actually register, and throws at module init naming any that is
missing, alongside the pre-existing throw for a malformed meta.

### [S2.2] The dev fallback, and why the macro takes no arguments

Two Bun constraints shape the call site, and the established pattern in
`skill/builtin/extract.ts` already encodes both.

Macros are not expanded in every transpile path. Under `bun test` the macro import is stripped
without the call being replaced, which surfaces at runtime as
`ReferenceError: loadBuiltinScripts is not defined`. The pattern is to import the same module
a second time as an ordinary import and fall back to it when the macro form throws a
`ReferenceError`. A shipped binary never takes that path — verified by the absence of any
`src/workflow/builtin/` path in it — so it exists for development and tests only. This is the
one place a `try`/`catch` is warranted against the repository's general preference, because a
non-expanded macro is not detectable any other way.

Macro arguments must be statically known. A per-filename signature, `script("fact-check.js")`,
is attractive because a misspelled name then fails the build outright; it cannot survive the
fallback, since passing a parameter through a wrapper makes the argument non-static and the
build fails with `Cannot convert identifier to JS`. Taking no arguments and indexing the
returned record is what the fallback requires, at the cost of demoting a missing file from a
build error to a module-init throw.

### [S2.3] Rejected alternatives

**Rename to `.js.fn`.** Implemented and verified first, then abandoned. It worked, but it
treats the extension as the defect rather than module-graph membership, and it moves the files
out of JavaScript tooling: they lose oxlint coverage and editor highlighting, and every
reference to them in specs, comments and docs has to be updated.

**Rename to `.txt`.** Cleaner than `.js.fn` — `.txt` needs no import attribute and no ambient
declaration, and there are 57 such imports in this package already. It still costs lint
coverage and highlighting, and it would put a second `compose.txt` in the codebase alongside
`session/prompt/compose.txt`, which is a model-facing system prompt; the current
`compose.js` versus `compose.txt` distinction is load-bearing vocabulary.

**Make the scripts valid ESM.** The top-level `return` is the workflow sandbox contract, and
user-authored workflows loaded from disk depend on it. Changing it is a breaking change to a
documented user-facing format.

**Make `plugin-toggle.test.ts:9` a static import.** Addresses a trigger of unclear provenance
rather than the cause, and leaves the next test file that re-evaluates `builtin.ts` free to
reintroduce the fault.
## [S3] Out of Scope

- Any change to the four scripts' contents.
- Reporting upstream. Taking the scripts out of the module graph removes this repository's
  exposure but not the underlying loader behaviour. No minimal standalone reproduction was isolated, which makes a useful
  report hard to write; the in-repository reproduction and the measurements above are
  recorded so one can be assembled later without repeating the investigation.
- The `thread.test.ts` re-evaluation itself. Why one test file loads `builtin.ts` on the
  order of a hundred times was not investigated and may be worth its own look — it is the
  condition that made the collision likely, and it presumably still holds.

## Tasks
- [x] T1: Read the scripts through a build-time macro instead of importing them, keeping their `.js` names — acceptance: the two-file reproduction runs all four tests with no failure or error (covers: S2.1)
- [x] T2: Add the dev fallback the macro pattern requires — acceptance: `bun test` loads the registry rather than throwing `ReferenceError`, and `bun typecheck` passes with no suppressions (covers: S2.2)
- [x] T3: Confirm the sources still reach a compiled standalone binary — acceptance: the scripts' text is present in the binary, no source path is, and a command that loads the tool registry runs without the module-init throw (covers: S2.1)
