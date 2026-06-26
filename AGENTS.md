---
> **/init rules active** — Rules below are loaded by `/init` and enforced in all interactions.
> Language config: I18N — auto-match language based on context
---

## 0. Language Rules (/init activated, permanently enforced)

1. **I18N mode**: Reply language should match the user's language. Reply in Chinese when the user writes in Chinese, reply in English when the user writes in English.
2. **Code/identifier exception**: Programming language keywords, function/class names, open source project names, common abbreviations (API/SDK/CLI/CI/etc.), and in-code identifiers always remain in English.
3. **Code comments**: Use the language that matches the code audience. Use English comments for international projects, Chinese comments for Chinese team projects.
4. **Error messages/guidance text**: Follow the target audience's language. End-user-facing copy must match the UI language.
5. **Reply structure**:
   - Start with a conclusion summary
   - Expand details in bullet points
   - Add notes/action steps as needed
   - Use Markdown formatting; code block comments explain logic

## 0.2 Command Reference

- **`/init`**: Reload all AGENTS.md rules, reset session context constraints.
- **`/review`**: Review uncommitted changes, commits, branches, or PRs; extract repeated workflows from recent work into reusable skills.
- **`/distill`**: Set explicit stop-condition goals, run continuously until the evaluation mechanism determines the goal is met, then auto-clear the goal.

## Quick Reference

| Command | Scope | Description |
|---------|-------|-------------|
| `bun install` | root | Install deps (postinstall runs fix-node-pty) |
| `bun dev` | root | Run opencode CLI in dev mode |
| `bun lint` | root | oxlint (repo-wide) |
| `bun typecheck` | root | turbo typecheck (all packages) |
| `bun test` | packages/opencode | Run tests (timeout 30s) |
| `bun run build` | packages/opencode | Build standalone executable |
| `./script/generate.ts` | root | Regenerate SDK from OpenAPI |

## Repo structure

- `packages/opencode`: Core CLI, server, and all business logic. Entry: `src/index.ts` (yargs CLI, script name `mimo`). Has its own `AGENTS.md` with detailed Effect/module conventions.
- `packages/app`: Web UI, SolidJS + Vite. Has its own `AGENTS.md`.
- `packages/desktop`: Native desktop app, Electron (wraps `packages/app`). Has its own `AGENTS.md`.
- `packages/ui`: Shared UI components, SolidJS.
- `packages/shared`: `@mimo-ai/shared` — utilities shared across packages.
- `packages/sdk/js`: `@mimo-ai/sdk` — generated JS client from OpenAPI.
- `packages/console`: Console sub-app (multi-service: `console/app`, `console/core`, `console/function`, `console/mail`, `console/resource`).
- `packages/plugin`: `@mimo-ai/plugin` — plugin API definitions (tool/tui).
- `packages/script`: `@mimo-ai/script` — build/release scripts.
- `packages/function`: `@mimo-ai/function` — Cloudflare Workers functions (GitHub integration).
- `packages/storybook`: UI component Storybook.
- `packages/slack`: Slack integration.
- `packages/identity`: Logo assets (non-code package).
- `packages/enterprise`: Enterprise features.
- `packages/extensions`: Extension features.
- `infra/`: SST infrastructure (Cloudflare + Stripe + PlanetScale).
- `script/`: Repo-level scripts (generate, release, changelog, etc.).

## Commands

### From repo root

```bash
bun install                  # Install deps (postinstall runs fix-node-pty)
bun dev                      # Run opencode CLI in dev mode (from packages/opencode)
bun dev <directory>          # Run against a specific directory
bun lint                     # oxlint (repo-wide)
bun typecheck                # turbo typecheck (all packages)
```

> **Bun version**: `packageManager` requires `bun@1.3.11`; pre-push hook enforces the version range. Push will be rejected if version mismatches.
> **Environment variable**: `bun dev` sets `MIMOCODE_HOME=$PWD/.dev-home` to isolate runtime data within the project.

### From packages/opencode

```bash
bun run build                # Build standalone executable
bun run build:dev            # Build single-platform prod binary
bun test                     # Run tests (bun test --timeout 30000)
bun typecheck                # tsgo --noEmit (NOT tsc)
bun run db generate --name <slug>  # Generate Drizzle migration
```

### From packages/app

```bash
bun run dev                  # Vite dev server
bun run test:unit            # bun test --preload ./happydom.ts ./src
bun run test:e2e             # Playwright tests
```

### From packages/desktop

```bash
bun run dev                  # Electron dev (web only)
```

**Never run `tsc` directly.** Always use `bun typecheck` from a package directory.
**Never run tests from repo root** (guard: `do-not-run-tests-from-root`).

## Testing

- Tests live in `packages/opencode/test/` mirroring `src/` structure.
- **Test fixtures**: Use `tmpdir()` from `test/fixture/fixture.ts` for temp dirs with auto-cleanup.
- **Effect tests**: Use `testEffect(...)` from `test/lib/effect.ts`. Use `it.live(...)` for tests needing real OS behavior (most integration tests).
- `test/preload.ts` sets up isolated env (in-memory SQLite, temp XDG dirs, clean API keys). Import order matters — env vars must be set before any `src/` imports.
- Avoid mocks. Test actual implementation.
- Effect test fixtures: `provideTmpdirInstance(...)` for single temp instance, `tmpdirScoped()` + `provideInstance(...)` for multi-directory tests.

## SDK generation

When you change the API or SDK (e.g. `packages/opencode/src/server/server.ts`):

```bash
./script/generate.ts
```

This regenerates `packages/sdk/js` from OpenAPI and reformats.

## Key architecture notes

### Effect v4 beta

This codebase uses **Effect v4 beta** (`effect@4.0.0-beta.48`). Key differences from v3:

- `Effect.fork` / `Effect.forkDaemon` do not exist. Use `Effect.forkIn(scope)`.
- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects.

### Instance vs global state

- `Instance` (ALS-based) provides per-project context: `Instance.directory`, `Instance.worktree`, `Instance.project`.
- `InstanceState` (from `src/effect/instance-state.ts`) for per-directory service state that needs cleanup. Uses `ScopedCache` keyed by directory.
- `makeRuntime` (from `src/effect/run-service.ts`) for all services — returns `{ runPromise, runFork, runCallback }`.

### Module shape

Do NOT use `export namespace Foo { ... }`. Use flat top-level exports + self-reexport:

```ts
// src/foo/foo.ts
export const thing = ...
export * as Foo from "./foo"
```

Consumers: `import { Foo } from "@/foo/foo"`.

### Config modules

In `src/config`, follow the self-export pattern in `index.ts` when adding a new config module.

### Database

- Schema: `src/**/*.sql.ts` (snake_case field names, `<entity>_id` joins).
- Migrations: `bun run db generate --name <slug>` → `migration/<timestamp>_<slug>/`.
- Drizzle config: `packages/opencode/drizzle.config.ts`.

### CLI entry

`packages/opencode/src/index.ts` — yargs CLI with script name `mimo`. Commands: `run`, `serve`, `web`, `generate`, `models`, `providers`, `agent`, `upgrade`, `debug`, `stats`, `mcp`, `github`, `export`, `import`, `session`, `db`, `plug`, `acp`, `pr`.

## Style Guide

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible; avoid `any` type
- Use Bun APIs when possible (e.g. `Bun.file()`)
- Prefer type inference over explicit annotations
- Prefer functional array methods (`flatMap`, `filter`, `map`) over loops
- Prefer `const` over `let`; use ternaries or early returns instead of reassignment
- Avoid `else` statements — use early returns
- Avoid unnecessary destructuring — use dot notation to preserve context
- Inline single-use values to reduce variable count
- Drizzle schema fields: use `snake_case` (e.g. `project_id`, not `projectID`)
- In `src/config`, follow the existing self-export pattern when adding a new config module

## Effect code conventions

- Use `Schema.Class` for multi-field data, `Schema.brand` for single-value types, `Schema.TaggedErrorClass` for typed errors.
- Prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure.
- Use `Effect.callback` for callback-based APIs.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`.
- For background loops: `Effect.repeat` / `Effect.schedule` with `Effect.forkScoped`.
- Use `Effect.cached` for deduplication of concurrent computations.
- `Instance.bind(fn)` for native addon callbacks that need Instance context. Not needed for `setTimeout`, `Promise.then`, or Effect fibers.
- Prefer Effect services over raw platform APIs: `FileSystem`, `HttpClient`, `Path`, `ChildProcessSpawner`, etc.

## Lint

- Linter: oxlint with type-aware rules (`oxlint-tsgolint`).
- Config: `.oxlintrc.json` at repo root.
- Key disabled rules: `require-yield` (Effect generators), `no-shadow` (Effect closures), `no-new` (intentional side-effectful constructors).
- Formatter: Prettier (semi: false, printWidth: 120).

## Turbo task dependencies

- `typecheck`: no build dependencies, runs independently.
- `build`: no explicit `dependsOn`, outputs `dist/**`.
- `opencode#test` / `@mimo-ai/app#test`: depend on `^build` (upstream packages must build first).

## CI

- Typecheck workflow: `.github/workflows/typecheck.yml` — runs `bun typecheck` on push/PR to `dev`.
- Pre-push hook: `.husky/pre-push` — validates bun version + runs `bun typecheck`.

## Sub-package AGENTS.md

Each sub-package has its own `AGENTS.md` with more granular constraints. Key takeaways:

- **app** (`packages/app/AGENTS.md`): Never try to restart the app or server process. Local dev runs backend on port 4096, app on port 4444, verify UI changes at `http://localhost:4444`.
- **desktop** (`packages/desktop/AGENTS.md`): Renderer process can only call `window.api` exported from `src/preload`; main process registers IPC handlers in `src/main/ipc.ts`.
- **opencode** (`packages/opencode/AGENTS.md`): Detailed Effect/InstanceState/Runtime constraints, module shape, database schema conventions.

When modifying sub-package code, always read the corresponding `AGENTS.md`.
