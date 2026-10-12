---
feature: plugin-host-sdk
status: in-progress
updated: 2026-10-12
branch: feat/plugin-host-sdk
commits:
---

# Plugin Host SDK

## Report

## [S1] Problem

On every startup the engine and the TUI run an npm install of `@mimo-ai/plugin` into every config directory (`~/.config/mimocode`, each `.mimocode` up the tree, `~/.mimocode`, `MIMOCODE_CONFIG_DIR`). Plugin loading waits for all of those installs with no timeout whenever any plugin exists. The install touches the network and writes `package.json`, `package-lock.json` and `node_modules` into user directories without asking. It can pin a version that does not exist on npm, and it gives each directory its own copy of the SDK and its own `zod`. This supersedes the version-resolution patch in `plugin-sdk-npm-version.md`.

The Node build (used only by MiMo Desktop) has the same coupling. Desktop pre-writes npm short-circuit files so the wait returns immediately. Directory plugins written by users are only half supported there: they load, but a plugin that imports the SDK fails to resolve. On top of that, user plugins can collide with Desktop's own tools.

## [S2] Design

### [S2.1] No implicit install

Config and TUI config loading never install packages into config directories, and plugin loading never waits on dependency installs. Existing `package.json` and `node_modules` in those directories are left untouched. Explicitly configured npm plugins, providers and LSP servers keep their own install paths. `PluginLoader.loadExternal` drops its `wait` option and the file-plugin retry it drove, since no caller prepares dependencies any more.

When an external plugin fails to import because a module is missing, the load error tells the author to bundle runtime dependencies or install them in the plugin's own directory.

### [S2.2] Host-provided SDK on Bun

`packages/cli/src/plugin/host.ts` exports `PluginHost.provideSdk()`. On the Bun runtime it registers a `Bun.plugin` that serves `@mimo-ai/plugin`, `@mimo-ai/plugin/tool` and `@mimo-ai/plugin/tui` from the host's bundled SDK as `loader: "object"` modules. The call is idempotent. It is a no-op when `Bun` is undefined.

The host module wins over any `node_modules/@mimo-ai/plugin` next to the plugin, so plugins share the host's `tool()` and `zod`. Plugin authors install the package only for types.

`provideSdk()` runs before any external plugin import: at the start of `PluginLoader.loadExternal` (the single entry for server plugins, TUI plugins, TUI file plugins and plugins added from the TUI) and before file hooks load. File hooks are bundled with `Bun.build`, which does not see runtime plugins, so that bundle marks `@mimo-ai/plugin` and `@mimo-ai/plugin/*` as external. The runtime import then resolves to the host module.

### [S2.3] Config-dir-only plugin policy

`PluginHost.onlyConfigDir()` is true when the runtime cannot serve the SDK (`typeof Bun === "undefined"`) or when the new flag `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS` is truthy. Under this policy the engine loads only plugins provided by `MIMOCODE_CONFIG_DIR`:

- `PluginHost.filterOrigins(origins)` keeps a plugin origin only when its `source` path lies inside `Flag.MIMOCODE_CONFIG_DIR`. Non-path sources (`MIMOCODE_CONFIG_CONTENT`, remote config URLs) are dropped. `PluginLoader.loadExternal` applies it, so it covers every server and TUI plugin load, including TUI file plugins (their source is `<dir>/tui.json`).
- `PluginHost.filterDirectories(dirs)` keeps a config directory only when it lies inside `Flag.MIMOCODE_CONFIG_DIR`. It applies to file-hook discovery.
- When the policy is active and `MIMOCODE_CONFIG_DIR` is unset, no external plugins, file hooks or TUI file plugins load.
- Each filter logs the number of skipped items.

When the policy is inactive, both helpers return their input unchanged. `MIMOCODE_PURE` still takes precedence and skips all external plugins.

On the Node build, Desktop's own plugin is declared in `MIMOCODE_CONFIG_DIR/mimocode.json` and keeps loading. User plugins from global or project config are not loaded at all, rather than loading in a half-working state. Desktop needs no change; its npm short-circuit files become unused.

### [S2.4] Testing

- A plugin in a temp directory with no `node_modules` imports `tool` from `@mimo-ai/plugin` and registers a tool.
- With a fake `node_modules/@mimo-ai/plugin` next to the plugin, the plugin receives the host module.
- A file hook with a value import from `@mimo-ai/plugin` loads with no `node_modules`.
- With `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS=1`, a plugin declared in `MIMOCODE_CONFIG_DIR` loads and a project-local plugin does not. With the flag set and `MIMOCODE_CONFIG_DIR` unset, no external plugin loads.
- Config loading leaves no `package-lock.json` or `node_modules/@mimo-ai/plugin` behind (existing `plugin-dependencies` tests).

## [S3] Out of Scope

- Serving the SDK on the Node runtime (Node module hooks).
- Removing Desktop's npm short-circuit files; Desktop does that after bumping its engine pin.
- Changing npm CLI distribution or the npm plugin install path for explicitly configured plugins.
- Making file hooks work on the Node build; they already require `Bun.build`.
- Removing the now always-false `retry` argument threaded through loader reports and TUI plugin state.

## Tasks

- [ ] T1: Remove startup SDK installs, dependency waits and `PluginSdkNpmVersion`; add the missing-module hint — acceptance: `plugin-dependencies` tests pass and no config-dir npm install remains in `config.ts` or `tui.ts` (covers: S2.1)
- [ ] T2: Add `PluginHost.provideSdk()` and call it before server and TUI external plugin loads; mark the SDK external in the file-hook bundle — acceptance: host-SDK tests in S2.4 pass (covers: S2.2, S2.4; depends: T1)
- [ ] T3: Add `MIMOCODE_ONLY_CONFIG_DIR_PLUGINS`, `PluginHost.onlyConfigDir()`, `filterOrigins`, `filterDirectories`, and apply them in `PluginLoader.loadExternal` and file-hook discovery — acceptance: policy tests in S2.4 pass (covers: S2.3, S2.4; depends: T2)
