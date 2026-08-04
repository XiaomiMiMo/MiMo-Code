# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

- Use MiMoCode Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on both `main` and `dev` branches.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- Install deps with `bun ci` (= `bun install --frozen-lockfile`) — install per `bun.lock`, don't mutate the lockfile. ⛔ Do NOT use `bun install`/`npm install`.

## Core Focus (as of 2025-06-18)

Our core development focus is the **TUI** (terminal UI) implementation in `packages/opencode/src/cli/cmd/tui/`. We do not currently provide support for Web or App interfaces. All operations should default to checking the TUI implementation first.

## Repository layout

This is a Bun monorepo (Bun 1.3+) wired with Turbo and npm workspaces.

- `packages/opencode` (`@mimo-ai/cli`, binary `mimo`) — core business logic, headless server, CLI commands, TUI. Source in `src/`. This is the package the README and CONTRIBUTING call "opencode".
- `packages/sdk/js` (`@mimo-ai/sdk`) — generated TypeScript SDK. v2 lives in `src/v2/`. Generated from the server's OpenAPI spec.
- `packages/app` — shared SolidJS web UI (legacy / web target).
- `packages/desktop` — Tauri desktop shell that wraps `packages/app`.
- `packages/console` — hosted control-plane web app (sub-workspaces under `packages/console/*`).
- `packages/plugin` (`@mimo-ai/plugin`) — plugin authoring SDK and TUI extension contracts.
- `packages/script`, `packages/shared` — build helpers and cross-package utilities (`@mimo-ai/script`, `@mimo-ai/shared`).
- `packages/identity`, `packages/slack`, `packages/containers`, `packages/function`, `packages/enterprise`, `packages/extensions`, `packages/ui`, `packages/storybook` — auxiliary services / surface targets.
- `sdks/`, `infra/`, `script/`, `nix/`, `patches/` — repo-level build / deployment / tooling.

## Development commands

All run from the repo root unless noted.

```bash
bun install                              # install all workspaces
bun dev                                  # run opencode TUI (defaults to packages/opencode)
bun dev <directory>                      # run TUI against a different project
bun dev .                                # run TUI inside this repo
bun dev serve                            # start the headless server (default :4096)
bun dev serve --port 8080                # start the headless server on another port
bun dev generate                        # emit OpenAPI spec to packages/sdk/openapi.json
./packages/sdk/js/script/build.ts        # regenerate JS SDK from the spec

bun run --cwd packages/app dev           # web UI dev server (requires `bun dev serve`)
bun run --cwd packages/desktop dev       # Tauri web dev server (no native shell)
bun run --cwd packages/desktop tauri dev # native desktop app
bun run --cwd packages/desktop tauri build
bun run --cwd packages/storybook storybook
bun run --cwd packages/console/app dev

bun lint                                 # oxlint across the repo
bun typecheck                            # bun turbo typecheck (per-package tsgo --noEmit)

# Single-package tasks (run from the package dir, NOT repo root)
cd packages/opencode
bun test                                 # runs `bun test --timeout 30000`
bun test:ci                              # junit output under .artifacts/unit/
bun run typecheck                        # tsgo --noEmit
bun run build                            # bundles via script/build.ts
bun run build:dev                        # single-binary dev build
bun run db                               # drizzle-kit

# Build a standalone binary
./packages/opencode/script/build.ts --single
./packages/opencode/dist/opencode-<platform>/bin/opencode
```

## Debugging

- `bun dev` runs the server in a worker thread — breakpoints in server code may not fire. Use `bun dev spawn` (or run the server in one process and `opencode attach http://localhost:4096` from another) to make breakpoints reliable.
- `BUN_OPTIONS=--inspect=ws://localhost:6499/` is the conventional way to enable the inspector for every invocation.
- See `.vscode/settings.example.json` and `.vscode/launch.example.json` for working VSCode configurations.
- `Bun.file()` is preferred over `node:fs`; runtime-specific modules are abstracted via `imports` aliases (`#db`, `#read-sqlite`, `#pty`, `#hono`) that resolve to `.bun.ts` / `.node.ts` variants per runtime.

## High-level architecture

### Runtime model: TUI → RPC → Server

The TUI is a separate process from the headless server. The TUI boots a `worker.ts` via `thread.ts`; the worker boots the actual `Server` (Hono) and exposes two RPCs back to the TUI: a `fetch` proxy (so the TUI's `@mimo-ai/sdk` client can call server routes) and a `global.event` stream (forwarded from `GlobalBus`).

- Entry: `packages/opencode/src/index.ts` parses argv with yargs and dispatches to commands under `src/cli/cmd/`.
- TUI entry: `src/cli/cmd/tui/thread.ts` spawns the worker; `src/cli/cmd/tui/app.tsx` renders via `@opentui/solid`.
- Worker: `src/cli/cmd/tui/worker.ts` starts the server inside the worker thread and bridges global events over RPC.
- Headless server: `src/cli/cmd/serve.ts` → `src/server/server.ts` (Hono app, MDNS, hono-openapi spec).

### Server (`packages/opencode/src/server/`)

- `server.ts` — Hono app composition, MDNS, lazy default instance, `Server.openapi()` for spec generation. Per-runtime HTTP adapter selected via the `#hono` import alias (`adapter.bun.ts` / `adapter.node.ts`).
- `routes/global.ts`, `routes/control/`, `routes/instance.ts`, `routes/ui.ts` — top-level Hono routers. With `MIMOCODE_WORKSPACE_ID` set, the server is locked to a single workspace; otherwise the control plane + workspace router pattern is used.
- `workspace.ts`, `control-plane/workspace.ts` — workspace lifecycle, control plane is the "remote" mode used by the hosted console.
- `middleware.ts` (`AuthMiddleware`, `CorsMiddleware`, `CompressionMiddleware`, `ErrorMiddleware`, `LoggerMiddleware`), `fence.ts`, `rate-limit.ts`, `mdns.ts`, `pty-ticket.ts`, `proxy.ts`, `projectors.ts`.
- `auth.ts` — provider OAuth / API-key flows.

Routes are documented with `hono-openapi`. `Server.openapi()` is consumed by `packages/opencode/src/cli/cmd/generate.ts` (the `bun dev generate` command), which writes `packages/sdk/openapi.json`; `./packages/sdk/js/script/build.ts` then runs `@hey-api/openapi-ts` to emit `packages/sdk/js/src/v2/gen/`.

### Session / agent loop (`packages/opencode/src/session/`)

- `session.ts` (re-exported as `Session` from `index.ts`) is the public surface for session lifecycle, persistence, and status.
- `message-v2.ts` / `message.ts` — the two message schemas. v2 is the active shape; v1 is retained for migrations and imports.
- `processor.ts` — the agent loop. Wires `Agent`, `LLM`, `Bus`, `Permission`, `Question`, `Snapshot`, `Plugin`, `Metrics`, plus retry / overflow / doom-loop detection (`text-ngram-detection`).
- `llm.ts`, `compaction.ts`, `prune.ts`, `overflow.ts`, `summary.ts`, `checkpoint*.ts`, `auto-dream.ts`, `goal.ts`, `max-mode.ts`, `boundary.ts` — the context-management pipeline. Checkpoints, dream (memory distillation), and the goal/stop-condition judge all plug in here.
- `prompt.ts` and `prompt/` — prompt assembly (system + tools + budgeted context injection).
- `claude-import.ts`, `codex-import.ts`, `opencode-import.ts` — importers for other agents' session logs.
- `trajectory.ts`, `todo.ts`, `system.ts`, `instruction.ts`, `run-state.ts`, `status.ts` — supporting state.
- Persisted state lives in `session.sql.ts`, `checkpoint-progress-reconcile.ts`, etc.; read by both Bun and Node via `#read-sqlite`.

### Agent / tool system (`packages/opencode/src/agent/`, `packages/opencode/src/tool/`)

- `agent/agent.ts` — the `Agent.Info` schema and the streaming agent entry points (uses the Vercel `ai` SDK's `streamObject` / `generateObject`). Prompts live in `agent/prompt/*.txt` and `generate.txt`.
- `agent/config.ts` — built-in agent catalog (`build`, `plan`, `compose`, etc.) and the `SYSTEM_SPAWNED_AGENT_TYPES` allowlist referenced by the processor.
- `tool/` — one file per tool (each with a paired `.txt` description for the system prompt): `bash`, `read`, `write`, `edit`, `multiedit`, `glob`, `grep`, `codesearch`, `webfetch`, `websearch`, `lsp`, `task` (subagent), `actor` (PTY), `skill`, `question`, `apply_patch`, `workflow`, `notebook-edit`, plus helpers (`registry.ts`, `truncate.ts`, `truncation-dir.ts`, `schema.ts`, `tool.ts`, `recoverable.ts`).
- Bash token-efficient pipeline lives at `tool/bash_token_efficient_pipeline.ts`; PTY-backed shell in `bash-interactive.ts`; shell parsing helpers in `shell-tokenize.ts` / `shell-wrap.ts`.
- The tool registry is built in `run.ts` (`run command` and TUI startup) and registered against the SDK so the model can invoke them.

### Providers (`packages/opencode/src/provider/`)

- `provider.ts` — provider registry, model resolution, and `ProviderTransform`.
- `models.ts` — pulls model metadata from `models.dev`.
- `schema.ts` — `ProviderID` / `ModelID` zod brands.
- `auth.ts` — per-provider auth (OAuth, API keys).
- `sdk/`, `transform.ts` — provider-specific request/response transforms; the streaming layer plugs into the Vercel `ai` SDK.

### Config (`packages/opencode/src/config/`)

A single `Config` barrel re-exports per-domain submodules via the self-export pattern (e.g. `export * as ConfigAgent from "./agent"`). New config domains must follow this pattern. Domains include: `agent`, `command`, `compose`, `formatter`, `history`, `keybinds`, `layout`, `lsp`, `mcp`, `model-id`, `parse`, `paths`, `permission`, `plugin`, `provider`, `server`, `skills`, `variable`, `markdown`, `console-state`, `managed`, `entry-name`. `index.ts` is the barrel; `config.ts` is the loader.

### Storage (`packages/opencode/src/storage/`)

- `db.ts` + `schema.ts` + `schema.sql.ts` — Drizzle schema (snake_case columns; see Style Guide).
- `db.bun.ts` / `db.node.ts` — runtime-split driver selection via the `#db` import alias.
- `read-sqlite.bun.ts` / `read-sqlite.node.ts` — read-only helpers (`#read-sqlite`).
- `storage.ts` — high-level storage API (memory, journals, etc.).
- `json-migration.ts` — legacy JSON store → SQLite migration.

### Memory (`packages/opencode/src/memory/`)

- `service.ts` — public Memory service (project memory, session checkpoint, scratch notes, task progress).
- `fts-query.ts`, `fts.sql.ts` — SQLite FTS5 full-text search.
- `reconcile.ts` — merge / conflict resolution.
- `paths.ts` — on-disk layout (`MEMORY.md`, `checkpoint.md`, `notes.md`, `tasks/<id>/progress.md`).

### Project / instance (`packages/opencode/src/project/`)

- `instance.ts` — the per-directory `InstanceContext` (directory, worktree, project). Each opencode invocation pins to one instance.
- `bootstrap.ts` — instance bootstrap pipeline.
- `project.ts` / `project.sql.ts` / `project-id.ts` / `schema.ts` — project persistence.
- `workspace-trust.ts` — first-run trust prompt (consumed by the TUI's `thread.ts`).
- `vcs.ts` — git integration helpers.

### Effect / observability layer (`packages/opencode/src/effect/`)

Effect-TS is used pervasively for service composition, retries, and observability. Key modules: `runtime.ts`, `app-runtime.ts`, `bootstrap-runtime.ts`, `run-service.ts`, `instance-registry.ts`, `instance-state.ts`, `bridge.ts`, `runner.ts`, `observability.ts`, `logger.ts`, `memo-map.ts`, `cross-spawn-spawner.ts`. `InstanceState` is the cross-cutting context used by bus, provider, and control plane.

### Bus / events (`packages/opencode/src/bus/`)

- `bus-event.ts` — zod-typed event definitions.
- `global.ts` — `GlobalBus` (process-wide, forwarded to the TUI worker via RPC).
- `index.ts` — per-instance `Bus` (PubSub streams over Effect).

### Control plane / sync (`packages/opencode/src/control-plane/`, `packages/opencode/src/sync/`)

- `workspace.ts` — workspace lifecycle, restoration, and connection status.
- `adaptors/` — workspace source adaptors.
- `sse.ts` — SSE parsing.
- `projectors.ts` (server) and `sync/` — event projection into the database and SSE stream to clients.

### Plugin system (`packages/opencode/src/plugin/`, `packages/plugin`)

- `plugin/loader.ts`, `plugin/install.ts`, `plugin/meta.ts`, `plugin/shared.ts` — plugin lifecycle, manifest, install, package/theme discovery.
- `packages/plugin` exports the TUI extension contract: `TuiPlugin`, `TuiPluginApi`, `TuiRouteDefinition`, `TuiSlotPlugin`, `TuiTheme`, `TuiDialogSelectOption`, `TuiSlotProps`, `TuiDispose`, `TuiPluginModule`, `TuiPluginMeta`, `TuiPluginStatus`, `TuiPluginInstallResult`. Consumed by `cli/cmd/tui/plugin/{api,runtime,internal,slots}.tsx`.
- `cli/cmd/tui/feature-plugins/{home,sidebar,system}` — built-in feature plugins the TUI ships with.

### TUI (`packages/opencode/src/cli/cmd/tui/`)

Built with SolidJS rendered through `@opentui/solid`.

- `app.tsx` — root component. Sets up the renderer (`createCliRenderer` from `@opentui/core`) and wires global providers: `RouteProvider`, `ThemeProvider`, `LanguageProvider`, `KeybindProvider`, `ProjectProvider`, `SDKProvider`, `SyncProvider`, `LocalProvider`, `KVProvider`, `ArgsProvider`, `PromptRefProvider`, `PromptHistoryProvider`, `FrecencyProvider`, `PromptStashProvider`, `ToastProvider`, `ExitProvider`, `TuiConfigProvider`, `DialogProvider`, `CommandProvider`, plugin slot providers.
- `routes/home.tsx`, `routes/session/index.tsx` — top-level routes. Session route owns `dialog-message.tsx`, `dialog-fork-from-timeline.tsx`, `dialog-timeline.tsx`, `dialog-subagent.tsx`, `permission.tsx`, `question.tsx`, `sidebar.tsx`, `footer.tsx`, `subagent-footer.tsx`.
- `context/` — Solid contexts: `sdk.tsx` (HTTP client + event source over RPC), `sync.tsx` (Solid store hydrated from SSE), `event.ts`, `project.tsx`, `keybind.tsx`, `theme.tsx`, `language.tsx`, `args.tsx`, `prompt.tsx`, `route.tsx`, `kv.tsx`, `local.tsx`, `exit.tsx`, `directory.ts`, `helper.tsx`, `tui-config.tsx`, `plugin-keybinds.ts`, `thinking.ts`.
- `component/` — presentational + dialog components. `prompt/` holds the chat input (history, frecency, stash). `dialog-*.tsx` are modal dialogs.
- `ui/` — primitive widgets: `dialog.tsx`, `dialog-select.tsx`, `dialog-prompt.tsx`, `dialog-confirm.tsx`, `dialog-alert.tsx`, `dialog-help.tsx`, `dialog-export-options.tsx`, `toast.tsx`, `link.tsx`, `spinner.ts`.
- `plugin/` — TUI-side plugin runtime (`api.tsx`, `runtime.ts`, `internal.ts`, `slots.tsx`); loaded plugin routes are merged into `RouteMap`.
- `feature-plugins/` — built-in feature plugins (home / sidebar / system).
- `routes/session/index.tsx` is the heaviest file — when changing session UX, start there.

### Other subsystems worth knowing

- `auth/` — provider login flows (OAuth callbacks live here).
- `account/`, `acp/` — user account + Agent Communication Protocol.
- `mcp/` — Model Context Protocol client/server.
- `lsp/` — LSP client (one process per server).
- `npm/` — npm registry / package resolution; uses `@npmcli/arborist`.
- `git/` — git plumbing for VCS-aware features.
- `file/`, `format/`, `shell/`, `snapshot/`, `permission/`, `question/`, `flag/`, `util/`, `workflow/`, `worktree/`, `team/`, `task/`, `inbox/`, `ide/`, `global/`, `history/`, `id/`, `installation/`, `metrics/`, `patch/`, `share/`, `skill/`, `effect/` — domain modules. `skill/builtin/` and `skill/compose/` ship baked-in skills; `skill/discovery.ts` finds user skills.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

### Reading a nullable column

Two independent absences meet in one expression, and only one of them is
`undefined`. `.get()` yields `undefined` when no row matches — Drizzle normalises
the driver's `null` there — while a nullable column's SQL `NULL` arrives as
`null`. So `row?.some_column` is `T | null | undefined`.

When a caller only asks "is there a value", flatten to `undefined`, and write the
flattening as an annotation rather than an `as` cast:

```ts
// Good — the compiler enforces it; deleting the `?? undefined` is a type error
const boundary: MessageID | undefined = row?.last_checkpoint_message_id ?? undefined

// Bad — the cast removes `null` from the union without converting anything,
// so the declared type is untrue at runtime
return row?.last_checkpoint_message_id as MessageID | undefined
```

Discriminate a possibly-absent value with truthiness or `== null`, never with
`=== undefined` / `!== undefined`. Because `null !== undefined` is `true`, such a
guard typechecks, reads correctly in review, and does nothing.

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode` via `bun test`. Use `bun test:ci` to emit JUnit XML for CI.
- For a single file: `cd packages/opencode && bun test test/path/to/file.test.ts`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly. The `typecheck` script in `packages/opencode` is `tsgo --noEmit`.
