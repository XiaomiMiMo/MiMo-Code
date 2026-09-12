---
feature: default-port-ephemeral
status: delivered
updated: 2026-09-12
branch: feat/default-port-ephemeral
commits: ecbe6e59c7c9383f99767ca3f755ad032c4dc3cc..98ef287528e9c54fefe0055a90462338adc02f4b
---

# Default Listen Port Ephemeral

## Report

**What was built** — `Server.listen({ port: 0 })` now binds an OS-assigned ephemeral port on both node and bun adapters; the conventional 4096 preference is removed so embedders (MiMo Desktop) and other local tools no longer collide by default. Fixed ports require an explicit `port` / `--port` / `config.server.port`. Runtime hardcodes of `localhost:4096` were removed from the plugin client placeholder and CLI help; documentation examples may still show `--port 4096` when a known URL is required.

**Verification** — `packages/opencode`: `bun test test/cli/cmd/server-port-ephemeral.test.ts test/cli/cmd/serve-advertise.test.ts` PASS 8/8; `bun test test/skill/mimocode-docs.test.ts test/plugin/mimo.test.ts test/plugin/codex.test.ts` PASS 44/44; `bun typecheck` PASS. Independent review: no critical findings.

**Journey log** — Prefer `start(opts.port)` over a special-case `port===0 → 4096` branch; yargs default `0` therefore means ephemeral unless config supplies a port. Downstream Desktop must keep consuming listen-returned `Server.url` / `Listener.port` (already dynamic). Generated SDK default `baseUrl` and unmanaged `packages/app` UI placeholders still mention 4096 (out of runtime listen path). Node adapter is code-symmetric with bun; unit suite exercises the bun path under Bun.

## [S1] Problem

`Server.listen({ port: 0 })` used to prefer a conventional serve port (4096), then fall back to `start(0)`. That port collides with other local tools (MiMo Desktop embeds the engine in-process; OpenCode/CLI users also bind 4096). Port `0` is the OS standard “any free port” and should mean exactly that.

## [S2] Design

- **Adapter (node + bun)**: `port: 0` → `start(0)` (OS-assigned ephemeral). No intermediate bind of a conventional port. Explicit `port: N` binds only `N`.
- **CLI**: yargs default remains `0`, so an unspecified `--port` now means ephemeral. Fixed ports require an explicit flag or `config.server.port`.
- **Docs**: network flags and skill/README examples that need a **known** port must pass it explicitly (e.g. `--port 4096`). Example strings may keep 4096; runtime code must not hardcode it as the listen target.
- **In-process plugin client**: dummy `baseUrl` / `serverUrl` fallback uses `http://mimocode.internal` (not a conventional listen port). Real traffic uses `Server.url` after listen or in-process `app.fetch`.
- **Generated SDK default** `baseUrl: http://localhost:4096` is a client template, not a listen path; left as generated (docs/examples domain).

## [S3] Out of Scope

- Desktop-side engine-pin bump (downstream).
- Changing `config.server.port` schema (still optional and `> 0`).
- Rewriting all multilingual web docs / unmanaged `packages/app` UI placeholders beyond note-level consistency.

## Tasks

- [x] T1: node+bun adapter `0 → start(0)` — acceptance: source has no `start(4096)` preference (covers: S2)
- [x] T2: plugin client no localhost:4096 hardcode — acceptance: plugin/index.ts uses non-4096 placeholder (covers: S2)
- [x] T3: CLI/network + server.listen contract comments — acceptance: describe `0` as ephemeral (covers: S2)
- [x] T4: unit test port 0 does not prefer 4096 when free/bound — acceptance: `bun test` green on new/updated suite (covers: S2)
- [x] T5: docs/skill keep explicit-port examples; no new “default is 4096” claims — acceptance: capability-api/guide/README still show explicit `--port` (covers: S2)
