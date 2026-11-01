---
feature: project-config-execution
status: delivered
updated: 2026-10-29
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2737
commits: ebd06ee2f..53e7f2ae5
---

# Project configuration execution boundary

## Report

**What was built** — Desktop's Node engine, including hosts with a partial Bun shim, rejects MCP, LSP and formatter configuration outside its host sources. Ordinary project settings and Bun CLI behavior are preserved. Allowed file decisions survive global aggregation; rejected project entries cannot enable servers or inject environment overrides.

Legacy TOML is read and parsed from disk on each load. Migration outside the host boundary is skipped, preserving allowed symlink sources across invalidation and restart. Model refresh candidate and commit reflect current legacy model settings and file edits without migration writes, deletion or starter writes. Windows UI verification remains required after integrating the updated Node engine into the desktop client.

Project configuration updates merge the stored configuration rather than its runtime view. Saving a model through `PATCH /config` preserves MCP, LSP and formatter sections filtered by host policy, along with literal variable references and relative plugin paths.

**Verification** — From `packages/cli`, `bun test --timeout 30000 test/config test/plugin/host-sdk.test.ts test/plugin/host-node.test.ts test/mcp/project-config-execution.test.ts` passed with 206 tests, 4 existing platform skips and 518 assertions. From the repository root, `bun run typecheck` passed across all workspaces and scripts. From `packages/cli`, `MODELS_DEV_API_JSON=./test/tool/fixtures/models-api.json bun run script/build-node.ts` succeeded. Built-engine smoke checks exercised `GET /command` and `/config` on native Node and a partial Bun shim: host MCP connected, project markers were absent, allowed symlinks survived and edited legacy TOML was reloaded after invalidation. `git diff --check` passed; scoped lint reported 0 errors and 21 existing warnings on unchanged code. The branch was rebased onto `origin/main`; merge checks passed. Independent review approved implementation commit `53e7f2ae5` with no actionable findings.

## [S1] Problem

Opening a project in MiMo Desktop initializes the Node engine and connects MCP servers from merged project configuration. A downloaded project's local MCP command can run without a task or permission decision. Project LSP and formatter configuration shares the same missing source boundary.

## [S2] Design

### [S2.1] Host execution policy

Reuse the existing plugin and hook policy: Node, including a partial Bun shim, always restricts executable configuration; Bun restricts it when `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS` is enabled. Accept MCP, LSP and formatter configuration only from files whose resolved paths are inside `MIMOCODE_CONFIG_DIR` or the user's global config directory, or from host-owned `MIMOCODE_CONFIG_CONTENT` and `MIMOCODE_CONFIG_DEFAULTS`. The restriction targets project-supplied configuration: the global directory is written by the user (Desktop's MCP settings persist there), so it is trusted like the host directory. A global file that resolves outside the global directory keeps the decision of its resolved location. Preserve ordinary Bun CLI configuration behavior.

### [S2.2] Filter before merging

Discard entire MCP, LSP and formatter sections from other sources while loading each source, before configuration merging, including enabled toggles, environment and initialization overrides. Preserve ordinary project settings. Apply the same source check to Claude MCP compatibility and managed configuration. Preserve individual file decisions through global aggregation: a global symlink resolving to an allowed host file stays allowed, while a host symlink escaping to a project stays rejected. Rejected entries must neither execute nor replace allowed entries or their provenance. This policy is evaluated on every project instance load, including restored projects.

### [S2.3] Verification

Exercise actual configuration loading across root and nested JSON/JSONC files, Claude compatibility, allowed host configuration, host overrides, absent host directories and symlinks. Use a real harmless MCP subprocess that writes a temporary marker to prove restricted project loading cannot execute it, including a second instance load. Verify Node behavior with and without a partial Bun shim, and existing configuration and plugin tests.

### [S2.4] Legacy migration boundary

Read and parse legacy TOML from disk using its original source decision on every load, without a module import cache. If the migration destination is outside allowed host sources, preserve the legacy file and skip migration writes and deletion. This keeps an allowed global symlink into the host directory usable after invalidation and restart. Model-only reads also load and normalize current legacy model settings, including edits to an already loaded file, without migration writes, deletion or starter configuration writes. Continue normal migration when the destination is allowed, including ordinary Bun CLI mode. Rejected legacy executable sections remain unavailable at runtime.

### [S2.5] Configuration persistence

Read, normalize and validate the stored JSON/JSONC directly before merging a project update. Runtime execution filtering, variable substitution, plugin resolution and schema insertion must not transform the persisted values. Invalid stored configuration fails before writing. Repeated model updates preserve stored executable sections while the loader continues enforcing the host boundary.

## [S3] Out of Scope

HTML preview and privileged desktop bridges are the report's second vulnerability. Desktop UI and Windows installer sources are not present in this repository; verification here covers the shared engine and its Node build.

## Tasks

- [x] T1: Share the host source policy and filter executable configuration — acceptance: rejected sections cannot enter effective configuration or override allowed host entries (covers: S2.1, S2.2).
- [x] T2: Add and run regression tests — acceptance: restricted loading never writes a project MCP marker, allowed host MCP still connects, Node shim and source boundary cases pass (depends: T1, covers: S2.3).
- [x] T3: Verify compatibility and independently review the diff — acceptance: relevant tests and typecheck complete; review findings are resolved (depends: T2, T4).
- [x] T4: Preserve legacy sources when migration would cross the host boundary — acceptance: allowed TOML symlink configuration survives source invalidation, restricted destinations receive no migration write or deletion, and allowed migrations still complete (covers: S2.4).
- [x] T5: Preserve stored configuration during project updates — acceptance: repeated model saves retain filtered executable sections, literal references and disabled settings; invalid stored configuration is not overwritten (covers: S2.5).

## Journey log

Review caught a trust decision being applied again to an aggregated global directory, which incorrectly rejected a legitimate global symlink into the host directory. Filtering now happens at each original source load; both symlink directions have regressions. The original project configuration tests failed before the fix, and a real harmless MCP fixture confirmed root, hidden and Claude project servers connected before the policy was extended.

Legacy migration review also exposed source changes after migration and stale model reads. Retaining the original source, including it in model-only reads and replacing cached imports with filesystem parsing resolves those cases; regressions cover initial load, invalidation, refresh candidate/commit and edits to an already loaded TOML file.

Configuration persistence regression: `Config.update` reused the runtime loader, which removed rejected executable sections before rewriting the file. It now parses stored values directly. The restricted model-save test reproduced the deletion before the fix. Validation on 2026-10-29 passed 210 tests with 4 existing platform skips and 535 assertions using the configuration, host plugin and MCP boundary test command above. Workspace typecheck and the Node build passed; scoped lint reported 0 errors and 21 existing warnings on unchanged code. Built-engine `GET /config` and two consecutive `PATCH /config` requests passed on native Node both without Bun and with a partial Bun shim, confirming runtime filtering and persistence of all three sections and a literal file reference.
