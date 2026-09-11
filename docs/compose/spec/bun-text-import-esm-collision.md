---
feature: bun-text-import-esm-collision
status: delivered
updated: 2026-08-03
branch: fix/workflow-script-ext
commits: 09d03d67..e8f1a8d1
---

# Built-in workflow scripts collide with the ESM parser

## Report

**What was built** — The four built-in workflow scripts are no longer imported. A Bun macro
reads the directory at build time and their sources are inlined into the bundle, so the files
never enter the module graph and nothing can attempt to parse them.

**Verification** — From `packages/opencode`.

| Check                                                                     | Before                        | After                     |
| ------------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| `bun test test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts` | 3 tests ran, 1 fail, 1 error  | 4 pass, 0 fail, 0 error   |
| `bun test test/cli/tui test/cli/cmd/tui`                                  | 261 pass, 1 fail, 1 error     | 262 pass, 0 fail, 0 error |
| `bun test test/workflow`                                                  | —                             | 194 pass, 5 skip, 0 fail  |
| `bun typecheck`                                                           | passes with four suppressions | passes with none          |

The counts rise by one because the test that previously failed to load now runs.
`bun run build:local` compiles; `bun build --target=bun src/workflow/builtin.ts` shows the macro
call site replaced by an object literal, so the development fallback below is unreachable in a
bundle; `mimo debug agent build` from the compiled binary, run in an empty directory, loads the
workflow registry. `bun.lock` is unmodified.

**Journey log**

- The first fix renamed the files to `.js.fn` so no loader would try. It worked, and it was the
  wrong shape: the defect was that the scripts were reachable as modules, not that they were
  named `.js`. Renaming also took them out of oxlint and editor highlighting, and touched every
  reference to them. Asking what makes the failure impossible rather than unlikely gave a
  better answer than iterating on the first one that worked.
- The macro form was already in this codebase twice for the same job. Searching for precedent
  before inventing an extension would have found it immediately.
- Two Bun constraints only surfaced by running into them, and the published pattern in
  `skill/builtin/extract.ts` already encodes both — reading it properly instead of assuming its
  shape would have saved two failed builds.
- An explicit list of the four filenames survived into the first macro version out of habit.
  Nothing outside this module references those filenames, so it was pure ceremony from the era
  when static imports forced it.

## [S1] Problem

The four scripts in `src/workflow/builtin/` are workflow **function bodies**, not modules: each
ends in a top-level `return`, because the sandbox evaluates them inside a function wrapper.
They were imported as raw text via `with { type: "text" }` so that they would embed into the
compiled binary, which has no source tree to read at runtime.

That left them reachable as modules, and under `bun test` one was occasionally loaded through
the ECMAScript parser instead of the text loader, where a top-level `return` is a syntax error:

```
# Unhandled error between tests
error: Top-level return cannot be used inside an ECMAScript module
    at .../src/workflow/builtin/fact-check.js:1:1
```

No assertion produced it. Bun counts the event once as a failure and once as an error, and one
test never starts, so a test file silently loses coverage. Reproducible with two files, in
either order, each of which passes alone:

```
bun test test/cli/tui/plugin-toggle.test.ts test/cli/tui/thread.test.ts
```

Continuous integration missed it because `test.yml` shards test files across four processes, so
the two files that collide are usually not in the same one.

Two measurements pinned it down. An `onResolve` hook showed the importer was always
`builtin.ts` itself — the legitimate text import, with no second importer anywhere — and that
`thread.test.ts` alone re-evaluates `builtin.ts` on the order of a hundred times in one
process, of which a handful took the ESM path. Three explanations were tried and falsified:
leaked test state (both files restore their spies), a static-plus-dynamic import race, and
cache exhaustion under concurrent re-imports; neither of the latter two reproduces standalone.

This reads as a Bun defect — a static import carrying `with { type: "text" }` should reach the
text loader every time — but no minimal standalone reproduction was isolated, so the trigger
for the re-evaluation remains unexplained.

## [S2] Design

`builtin.macro.ts` reads `builtin/*.js` with `fs.readdirSync` / `fs.readFileSync` and returns
`{ file, script }[]`. `builtin.ts` consumes it through `with { type: "macro" }`, so the call is
evaluated at transpile and the sources are inlined as string literals. A file read at build time
is never in the module graph, whatever it is named, which is why this fixes the cause rather
than the symptom — and why the scripts keep their `.js` names, stay inside oxlint's coverage,
and need no changes anywhere else.

The directory is the registry, as it is for built-in skills in `skill/builtin/bundle.macro.ts`.
Nothing outside this module refers to the filenames; consumers look workflows up by `meta.name`,
which each script declares itself.

Three consequences follow from that, all accepted because the directory is curated. Losing a
script is no longer a boot failure — it simply stops registering, and callers get the existing
unknown-workflow error — so `builtin.test.ts` asserts the registered set to make a deletion
loud. A stray `.js` dropped there becomes a shipped workflow rather than being inert, and a
malformed meta in it fails app boot. Two scripts declaring the same `meta.name` silently
last-wins, unchanged from before.

Two Bun constraints shape the call site, both already encoded in the pattern
`skill/builtin/extract.ts` established:

- Macros are not expanded in every transpile path. Under `bun test` the macro import is stripped
  without the call being replaced, surfacing as a `ReferenceError`, so the macro module is also
  imported normally and the macro form falls back to it. A `try`/`catch` is warranted here
  against the repository's general preference because a non-expanded macro is not otherwise
  detectable.
- Macro arguments must be statically known. A per-filename signature would make a misspelled
  name a build error, but it cannot pass through the fallback wrapper — the argument stops being
  static and the build fails with `Cannot convert identifier to JS`.

## [S3] Out of Scope

- Reporting upstream. This removes the repository's exposure, not the loader behaviour. The
  reproduction and measurements are recorded above so a report can be assembled without
  repeating the work.
- Why `thread.test.ts` re-evaluates `builtin.ts` a hundred times. It is the condition that made
  the collision likely and it presumably still holds.
- Rejected: renaming to `.js.fn` or `.txt` (treats the extension as the defect, costs lint
  coverage; `.txt` would also collide with `session/prompt/compose.txt`), and making the scripts
  valid ESM (the top-level `return` is the sandbox contract that user-authored workflows depend
  on).

## Tasks

- [x] T1: Read the scripts through a build-time macro instead of importing them — acceptance: the two-file reproduction runs all four tests with no failure or error (covers: S2)
- [x] T2: Add the dev fallback the macro pattern requires — acceptance: `bun test` loads the registry rather than throwing `ReferenceError`, and `bun typecheck` passes with no suppressions (covers: S2)
- [x] T3: Confirm the sources still reach a compiled standalone binary — acceptance: the bundler output shows the macro call site replaced by a literal, and a command that loads the registry runs from the binary in an empty directory (covers: S2)
