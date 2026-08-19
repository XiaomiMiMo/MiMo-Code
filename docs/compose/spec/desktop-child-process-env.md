---
feature: desktop-child-process-env
status: delivered
updated: 2026-08-17
branch: fix/desktop-runtime-boundaries
commits: 17c9cdcb70b27116456f742f2b0d384b76f79108..0d3d0dcadf999cd05cb5ea0ae22e5e43ac1bd305
---

# Desktop Child Process Environment

## Report

**What was built** — MiMoCode now owns a process-level, replaceable child environment baseline. Embedding hosts can set it at startup through `Server.listen({ childEnv })` or refresh it later through the Node entry's `ChildProcessEnv.set(env)`. Hosts that never set a baseline retain existing behavior and read the current `process.env` for each spawn.

All inherited external process paths now resolve through the same boundary, including direct and Effect process wrappers, Bash, PTY, LSP, MCP, ripgrep and remaining native `child_process` calls. Inherited credentials are still scrubbed before explicit per-child environment overrides are applied.

**Verification** — `bun typecheck` passed. The affected regression suite passed 99 tests with 0 failures across child-process environment, credential environment, process, PTY, LSP, MCP, ripgrep and Bash coverage. `git diff --check` passed. Independent review passed spec compliance, correctness and codebase consistency after all critical findings were fixed.

**Journey log** —

- A frozen baseline was rejected because a future Desktop environment-sync action must replace the baseline for new child processes without changing session state.
- The no-host path reads current `process.env` on every spawn; freezing that fallback broke existing CLI runtime environment updates.
- Review found Effect commands with undefined env and native `child_process` calls could still inherit the engine process; both paths now explicitly resolve the shared baseline.
- LSP environment deltas are resolved at each spawn so a baseline refresh affects later commands in the same workflow.
- The structural guard uses the TypeScript AST to validate every native process call; Process wrapper clients pass only env deltas so the final spawn boundary resolves the baseline exactly once.

## [S1] Problem

MiMoCode runs in-process inside MiMo Desktop. Desktop adds engine control variables to the Electron process environment, and external tools currently derive their environment directly from that global state. Bash, PTY, LSP, MCP and shared process spawners can therefore observe Desktop-only values such as engine credentials, permission controls and `NODE_ENV=production` injected by electron-vite.

The existing `Env.Service` is mutable, instance-scoped configuration state, not a child-process boundary: several spawn paths run outside its Effect context and still read `process.env` directly. Session permission is unrelated and must remain persisted session state; this feature does not change permission semantics.

## [S2] Design

The process/spawn infrastructure owns one replaceable child environment baseline. A new foundation module exposes two operations:

```ts
setChildProcessEnv(env: NodeJS.ProcessEnv): void
childProcessEnv(explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
```

The Node embedding entry exports the host-facing setter as `ChildProcessEnv.set(env)`. The resolver remains internal to spawn infrastructure. This gives Desktop one stable startup and future refresh contract without exposing arbitrary environment mutation over HTTP.

`setChildProcessEnv` copies the supplied values and atomically replaces the process-wide baseline. Future child processes use the new snapshot immediately; already-running children keep the environment they were spawned with. The baseline is not tied to a project instance or listener and is not reset when a listener stops. If no host sets a baseline, `childProcessEnv` reads the current `process.env` on each call, preserving existing CLI/TUI/ACP/run behavior when those surfaces intentionally mutate their own process environment.

MiMoCode adds an optional `childEnv?: NodeJS.ProcessEnv` field to the public `Server.listen` module contract only as an embedding adapter. `listen` sets `childEnv` before creating the HTTP runtime or initializing any project instance. Desktop supplies the option; ordinary CLI/TUI/ACP/serve callers omit it. Headless `mimo run`, which does not call `Server.listen`, naturally uses the default current `process.env`. A future Desktop environment-sync action can call the same process foundation setter without changing tool or session contracts.

All external process paths use one helper, `childProcessEnv(explicitEnv?)`, with this order:

```text
configured childEnv (or current process.env when no host set one)
  -> existing inherited-credential scrub
  -> explicit tool/plugin/MCP/LSP env overrides
  -> spawn
```

The foundation does not infer or reconstruct variables. The host-provided baseline is authoritative. Existing cleartext credential protection remains on the inherited half (`MIMOCODE_AUTH_CONTENT` and `MIMOCODE_CONFIG_CONTENT`); explicit per-child environment remains authoritative, so an MCP definition, LSP configuration, plugin hook, or future tool caller can intentionally override any value. `NODE_ENV`, user `MIMO_*` values, proxy variables and bundled runtime variables follow the baseline unchanged.

Every path that currently builds inherited child environment from `process.env` must call `childProcessEnv`: the direct process wrapper, Effect `ChildProcessSpawner`, Bash, PTY, LSP, MCP and ripgrep. Tool-local additions keep their existing order after the baseline, including plugin `shell.env`, Git identity floors, UTF-8 fixes and MCP/LSP explicit env.

MiMo Desktop obtains a complete environment snapshot from the same clean login-shell mechanism used to establish the user's terminal environment, adds bundled runtime variables, and passes the result as `childEnv` to `Server.listen({ childEnv })`. The snapshot is independent from Electron's mutated `process.env`, so Desktop/engine controls added later are absent by construction rather than removed heuristically. `NODE_ENV` is not synthesized or deleted: if the user's clean terminal environment contains it, it remains; if not, Desktop does not add it. Desktop continues to inject `MIMOCODE_PERMISSION` into the engine process; this feature does not move permissions into session storage or change cross-client behavior.

The engine module declaration in Desktop is expanded only for the `childEnv` option. The Desktop engine spec and bundled-runtimes spec remain the source of truth for the baseline construction and public `MIMO_*` runtime variables.

## [S3] Out of Scope

- Changing `MIMOCODE_PERMISSION`, session permission persistence, or permission precedence.
- Adding an HTTP endpoint for arbitrary environment mutation.
- Guessing or overriding `NODE_ENV`; child processes follow the clean terminal environment exactly, including its presence or absence of `NODE_ENV`.
- Adding model-visible per-call environment controls to the Bash schema.
- Reusing `Env.Service` for child-process inheritance or making child environment project-instance mutable.
- Constructing Desktop's clean-terminal environment, updating Desktop's virtual module declaration, adding Desktop E2E coverage, or bumping Desktop's engine pin. Those are downstream consumer work after this MiMoCode foundation lands.

## Tasks

- [x] T1: Add the process-owned replaceable child environment foundation and `Server.listen({ childEnv })` adapter — acceptance: each set replaces the snapshot for future spawns, existing children are unaffected, listener stop does not reset, and no-set callers keep current process.env behavior (covers: S2)
- [x] T2: Route all inherited external process environments through `childProcessEnv(explicit)` — acceptance: direct and Effect spawners plus Bash/PTY/LSP/MCP/ripgrep use the same baseline and explicit env still overrides (covers: S2; depends: T1)
- [x] T3: Add MiMoCode unit and structural regression tests — acceptance: baseline fidelity, credential scrub, replacement lifecycle and all spawn funnels are covered (covers: S2; depends: T2)
