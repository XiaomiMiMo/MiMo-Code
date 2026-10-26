---
feature: tool-input-path-guard
status: delivered
updated: 2026-10-04
branch: fix/tui-tool-input-path-guard
commits: 6babeb0b..32f9ef90
---

# Tool Input Path Guard

## Report

**What was built** — Tool-call renderers now treat `path` / `file_path` /
`workdir` as untrusted. The three divergent `normalizePath` / `filetype`
copies in the session route, permission prompt, and headless `mimo run` were
replaced by one pure module (`tui/util/tool-path.ts`) that accepts `unknown`
and degrades non-strings to an empty label instead of throwing in
`path.isAbsolute` / `path.extname` / `path.resolve`. Bash `workdir` display
also requires a string before `path.resolve`. A malformed tool-call field now
degrades to a blank label on that one tool line rather than destroying the
session view on the Bun shipped build (or aborting `mimo run`).

**Verification** — `bun run typecheck` PASS. `bun test test/cli/tui/tool-path.test.ts`
11 pass (object/array/number/boolean/null/undefined/empty + three display
behaviors). `bun test test/cli/tui/` 287 pass, 1 fail:
`collapse.test.ts` Hangul jamo width — PRE-EXISTING (Bun 1.4.2 `stringWidth`
vs test expectation; unrelated). `bun test test/cli/run-completion.test.ts
test/cli/tui/tool-path.test.ts` 16 pass. Lint on changed files: 0 errors.
Full `packages/cli` suite timed out at 5 minutes and was not completed.
Independent review of `6babeb0b..32f9ef90` passed spec compliance,
correctness, and consistency with no critical findings.

**Journey log** —

- `./script/format.ts` reformats the entire tree (652 files); reverted and
  formatted only the changed paths. Do not run it unscoped on a feature branch.
- Tests were written first against the new module and failed with
  `Cannot find module …/tool-path` before the implementation landed.
- `homeDir()` intentionally does not import `@/global` — that module has
  mkdir/flock side effects and is unsafe in a pure util.
- Pinned packageManager is `bun@1.3.14`; local Bun 1.4.2 is fine for typecheck
  and these unit tests but changes `Bun.stringWidth` (collapse test).
- Reviewer nits left as-is on purpose: blank path label for truthy non-strings
  is the specified empty-label behavior; T2 render path was code-inspected only
  per the testing boundary.

## [S1] Problem

A single non-string `path` / `file_path` / `workdir` field in a tool-call payload
takes down the entire TUI. Tool-call renderers read raw, unvalidated
`part.state.input`; zod schemas run only in `execute()`. `path.isAbsolute` /
`path.extname` / `path.resolve` throw on objects and arrays. On the Bun shipped
build the TypeError is fatal: the session route has no ErrorBoundary, so the
top-level handler replaces the transcript with `ErrorComponent`. Headless
`mimo run` has no ErrorBoundary at all and aborts the run.

Affected helpers (three divergent copies of the same crash):

- `packages/cli/src/cli/cmd/tui/routes/session/index.tsx` — `normalizePath`, `filetype`, Bash `workdir`
- `packages/cli/src/cli/cmd/tui/routes/session/permission.tsx` — `normalizePath`, `filetype`
- `packages/cli/src/cli/cmd/run.ts` — `normalizePath`

Fixes #2558.

## [S2] Design

Renderers treat tool-call input as untrusted. Path label helpers accept
`unknown` and degrade non-strings to an empty label (`""` / `"none"`), matching
the existing `permission.tsx` call-site convention
(`typeof meta["filepath"] === "string" ? … : undefined`).

Extract one pure, unit-testable module
`packages/cli/src/cli/cmd/tui/util/tool-path.ts` and use it from all three
call sites so the guard cannot drift. Preserve each surface's display behavior:

| Helper                    | Behavior for a valid string                      | Non-string / empty |
| ------------------------- | ------------------------------------------------ | ------------------ |
| `normalizePath` (session) | cwd-relative when inside cwd, else absolute      | `""`               |
| `normalizePermissionPath` | session behavior + `~` under home                | `""`               |
| `normalizeRunPath`        | absolute → cwd-relative or `.`, else passthrough | `""`               |
| `filetype`                | language from extension (JSX → typescript)       | `"none"`           |

Bash `workdir` in the session route additionally requires `typeof workdir === "string"`
before `path.resolve`. Missing or non-string `workdir` still hides the suffix.

No changes to tool `execute()` schemas, permission metadata production, or
model prompts. Display-only safety.

### Testing boundary

Unit tests cover the pure helpers with object / array / number / boolean /
null / undefined / empty-string inputs and the three valid-string behaviors.
No TUI render integration test is required for this fix.

## [S3] Out of Scope

- Why models emit non-string tool args (see #2498 / #2394)
- Adding an ErrorBoundary inside the session route
- Sanitizing non-path display fields (`pattern`, `command`, `url`, …)
- Consolidating the three display-behavior variants into one code path
- Headless `run.ts` fields other than `normalizePath`

## Tasks

- [x] T1: Extract type-safe path helpers to `tui/util/tool-path.ts` and rewire session/permission/run call sites — acceptance: non-string path fields return `""`/`"none"` and never throw (covers: S2)
- [x] T2: Guard Bash `workdir` resolution in the session route — acceptance: non-string `workdir` hides the suffix without throwing (covers: S2)
- [x] T3: Add `tool-path` unit tests for untrusted inputs and the three valid-string behaviors — acceptance: `bun test test/cli/tui/tool-path.test.ts` fails before the guard and passes after (covers: S2)
