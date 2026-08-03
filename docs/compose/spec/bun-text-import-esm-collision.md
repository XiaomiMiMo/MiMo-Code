---
feature: bun-text-import-esm-collision
status: delivered
updated: 2026-08-03
branch: fix/workflow-script-ext
commits: 09d03d67..09122450
---

# Built-in workflow scripts collide with the ESM parser under `bun test`

## Report

**What was built** — The four built-in workflow scripts are renamed from `.js` to `.js.fn`
so that no loader can mistake a function body for a module, and `builtin.ts` is updated to
match. An ambient declaration for the extension replaces the four `@ts-expect-error`
suppressions the old `.js` imports needed, so the imports now carry a real `string` type
instead of a silenced error.

The rename removes the failure rather than hiding it. Both open questions from the original
design were resolved by measurement, and one changed the design: a suppression would still
have been required after the rename — the diagnostic merely changes from TS1192 to TS2307 —
which is what motivated declaring the extension instead.

**Verification** — All from `packages/opencode`.

| Check | Before | After |
| --- | --- | --- |
| `bun test test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts` | 3 tests ran, 1 fail, 1 error | 4 pass, 0 fail, 0 error |
| `bun test test/cli/tui test/cli/cmd/tui` | 261 pass, 1 fail, 1 error | 262 pass, 0 fail, 0 error |
| `bun test test/workflow` | — | 194 pass, 5 skip, 0 fail |
| `bun typecheck` | passes with 4 suppressions | passes with none |

The test counts rise by one because the test that previously failed to load now runs.

Runtime and packaging were checked separately. In development,
`BuiltinWorkflow.list()` returns all four entries with their meta parsed and script text
intact. `bun run build:local` compiles a standalone binary whose smoke test passes; the
scripts' text is present in the binary while no `src/workflow/builtin/` source path occurs in
it, so the content is inlined rather than read from disk at runtime, which is the property the
text import exists for. The bare filenames do appear, as the `file:` labels in the `SCRIPTS`
table, which is expected. Running `mimo debug agent build` from that binary lists the
`workflow` tool, which means
`tool/registry.ts` and therefore `builtin.ts` loaded — `builtin.ts` parses every script's
meta at module init and throws on failure, so a successful load is positive evidence the text
imports resolved inside the compiled binary. `bun.lock` was not modified.

**Journey log**

- The `.js` extension was the whole defect surface. Renaming the files fixed a failure that
  three separate hypotheses about test isolation, import routes, and cache exhaustion had all
  failed to explain — the ambiguity itself was the bug, not any particular trigger for it.
- Confirming a suppression is still needed, just with a different code, is what turned a
  mechanical rename into a small improvement. Had the rename been committed without checking
  the diagnostic, the four `@ts-expect-error` lines would have silently kept working while
  masking a different error than the comment claimed.
- Verifying "the text is embedded" needed two observations, not one: the content being
  present in the binary, and no source path being present. Either alone is consistent with
  the wrong outcome.
- Review caught that the rename silently drops these files out of oxlint's `src/**/*.js`
  coverage — a cost the design had not stated. The fix is still right, but a rename that
  moves a file off a language's conventional extension takes it out of that language's
  tooling, which is easy to miss when the motivation is a loader problem.

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

### [S2.1] Rename the scripts so nothing can mistake them for modules

The ambiguity is the root of the problem: a `.js` file containing a top-level `return` is a
trap for loaders, readers and tooling alike. The four scripts take the extension `.js.fn`,
which names what they are — the content is a function body, and the top-level `return` is
the proof. `fact-check.js` becomes `fact-check.js.fn`.

Scope:

- the four import specifiers in `builtin.ts`;
- the four `file:` values in the `SCRIPTS` table.

The `file:` field is only used to name the offending script when `parseMeta` rejects it
(thrown at `builtin.ts:48`). It does not participate in matching a user-supplied override,
so changing those strings is safe.

User-authored workflows keep the `.js` convention documented in `README.md`. They are read
from disk at runtime rather than through an import attribute, so they were never exposed to
this and are not part of the rename.

### [S2.2] Declare the extension instead of suppressing the diagnostic

The old imports each carried `@ts-expect-error TS1192`, because tsgo resolved the `.js` as a
real module and complained it had no default export. After the rename tsgo instead reports
TS2307, "cannot find module" — so the suppressions would still have been load-bearing, but
for a different reason than their comment stated.

Rather than update four comments, `src/workflow/script.d.ts` declares the extension:

```ts
declare module "*.js.fn" {
  const source: string
  export default source
}
```

That removes all four suppressions and gives the imports the `string` type they actually
have, so a future mistake in this area surfaces as a type error rather than being absorbed
by a blanket `@ts-expect-error`.

### [S2.3] Accepted cost

The scripts leave JS tooling's reach. oxlint currently lints `src/**/*.js` and tolerates
their top-level `return`; under `.js.fn` it no longer sees them, and editors lose JavaScript
highlighting unless configured for the extension. That is roughly 1500 lines of sandbox
script losing static checking it did have. Accepted, because the lint pass reported nothing
on these files and the extension is what removes the failure — but it is a real reduction,
not a neutral rename, and anyone reconsidering the extension should weigh it.

### [S2.4] Rejected alternative

Making `plugin-toggle.test.ts:9` a static import would give the process one resolution
route. It addresses a symptom of unclear provenance rather than the ambiguity, and would
leave the next test file that re-evaluates `builtin.ts` free to reintroduce the fault.

## [S3] Out of Scope

- Any change to the four scripts' contents.
- Reporting upstream. The rename removes this repository's exposure but not the underlying
  loader behaviour. No minimal standalone reproduction was isolated, which makes a useful
  report hard to write; the in-repository reproduction and the measurements above are
  recorded so one can be assembled later without repeating the investigation.
- The `thread.test.ts` re-evaluation itself. Why one test file loads `builtin.ts` on the
  order of a hundred times was not investigated and may be worth its own look — it is the
  condition that made the collision likely, and it presumably still holds.

## Tasks
- [x] T1: Rename the four scripts to `.js.fn` and update `builtin.ts` — acceptance: the two-file reproduction runs all four tests with no failure or error (covers: S2.1)
- [x] T2: Replace the `@ts-expect-error` suppressions with an ambient declaration for the extension — acceptance: `bun typecheck` passes with no suppression on those imports (covers: S2.2)
- [x] T3: Confirm the text import still reaches a compiled standalone binary — acceptance: the scripts' text is present in the binary, their paths are not, and a command that loads the tool registry runs without the module-init throw (covers: S2.1)
