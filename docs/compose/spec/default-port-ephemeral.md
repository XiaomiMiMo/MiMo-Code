---
feature: default-port-ephemeral
status: in-progress
updated: 2026-09-12
branch: feat/default-port-ephemeral
commits: 
---

# Default Listen Port Ephemeral

## Report

## [S1] Problem

`Server.listen({ port: 0 })` used to prefer a conventional serve port (4096), then fall back to `start(0)`. That port collides with other local tools (MiMo Desktop embeds the engine in-process; OpenCode/CLI users also bind 4096). Port `0` is the OS standard “any free port” and should mean exactly that.

## [S2] Design

- **Adapter (node + bun)**: `port: 0` → `start(0)` (OS-assigned ephemeral). No intermediate bind of a conventional port. Explicit `port: N` binds only `N`.
- **CLI**: yargs default remains `0`, so an unspecified `--port` now means ephemeral. Fixed ports require an explicit flag or `config.server.port`.
- **Docs**: network flags and skill/README examples that need a **known** port must pass it explicitly (e.g. `--port 4096`). Example strings may keep 4096; runtime code must not hardcode it as the listen target.
- **In-process plugin client**: dummy `baseUrl` / `serverUrl` fallback must not use `http://localhost:4096`. Use a non-listening placeholder origin; real traffic uses `Server.url` after listen or in-process `app.fetch`.
- **Generated SDK default** `baseUrl: http://localhost:4096` is a client template, not a listen path; left as generated (docs/examples domain).

## [S3] Out of Scope

- Desktop-side engine-pin bump (downstream).
- Changing `config.server.port` schema (still optional and `> 0`).
- Rewriting all multilingual web docs beyond note-level consistency where they state “default port”.

## Tasks

- [x] T1: node+bun adapter `0 → start(0)` — acceptance: source has no `start(4096)` preference (covers: S2)
- [x] T2: plugin client no localhost:4096 hardcode — acceptance: plugin/index.ts uses non-4096 placeholder (covers: S2)
- [x] T3: CLI/network + server.listen contract comments — acceptance: describe `0` as ephemeral (covers: S2)
- [x] T4: unit test port 0 does not prefer 4096 when free/bound — acceptance: `bun test` green on new/updated suite (covers: S2)
- [x] T5: docs/skill keep explicit-port examples; no new “default is 4096” claims — acceptance: capability-api/guide/README still show explicit `--port` (covers: S2)
