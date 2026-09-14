---
feature: plugin-sdk-npm-version
status: in-progress
updated: 2026-09-14
branch: feat/plugin-sdk-npm-version
commits: 4b1dfe2fa68bd6cf4d086244617ccac4146fc43a..4b1dfe2fa68bd6cf4d086244617ccac4146fc43a
---

# Plugin SDK npm Version Resolution

## Report

## [S1] Problem

Config load installs `@mimo-ai/plugin` into each config directory so user plugins can import the SDK. The install request currently pins the package version to `InstallationVersion` whenever `InstallationLocal` is false.

`InstallationVersion` is an **install identity**, not an npm dist-tag. Official CLI releases use a published semver and match npm versions. Embedding hosts (MiMo Desktop) deliberately inject `MIMOCODE_VERSION=desktop-<pin hash>` with `MIMOCODE_CHANNEL=latest` so builtin skill / compose extraction paths advance with the pin. That identity never exists on npm, so config load requests `@mimo-ai/plugin@desktop-<hash>`, npm resolution fails, and the engine only logs `background dependency install failed`. User plugins that import `@mimo-ai/plugin` from a config directory then fail to resolve at runtime.

## [S2] Design

Decouple **install identity** from **npm package version resolution**.

`InstallationVersion` / `InstallationLocal` remain unchanged: they still drive User-Agent, telemetry, skill extraction directories, and release upgrade checks.

Add a pure resolver and its runtime binding in `packages/opencode/src/installation/version.ts`:

```ts
pluginSdkNpmVersion(version: string, local: boolean): string | undefined
PluginSdkNpmVersion = pluginSdkNpmVersion(InstallationVersion, InstallationLocal)
```

Contract for `pluginSdkNpmVersion`:

| Input | Result |
|-------|--------|
| `local === true` | `undefined` (npm resolves latest) |
| non-local + valid semver version (e.g. `0.1.14`, `0.1.3-preview.0`) | that version (pin to the release) |
| non-local + non-semver identity (`desktop-<hash>`, any non-npm string) | `undefined` (latest) |

Semver validity uses the same `semver` package already used by npm/plugin code (`semver.valid`). Preview prereleases are valid semver and stay pinned when they are the release identity.

Config and TUI install sites both consume `PluginSdkNpmVersion` instead of `InstallationLocal ? undefined : InstallationVersion`:

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/cli/cmd/tui/config/tui.ts`

Error behavior is unchanged: install failure still logs a warning and does not block config load. The change only makes the version request resolvable for non-semver identities.

## [S3] Out of Scope

- Changing desktop `MIMOCODE_VERSION=desktop-<hash>` / skill extraction identity.
- Publishing desktop-hash tags to npm.
- Surfacing background install failures to product UI.
- Probing npm before pin / fallback-on-404 for unpublished semver identities.
- Compatibility-check changes (`checkPluginCompatibility` already skips non-semver host versions).

## Tasks

- [ ] T1: Add `pluginSdkNpmVersion` pure helper + `PluginSdkNpmVersion` binding in `installation/version.ts` — acceptance: local → undefined; valid semver non-local → same string; non-semver non-local (desktop-hash) → undefined; covered by unit tests (covers: S2)
- [ ] T2: Point `config.ts` and `tui.ts` `@mimo-ai/plugin` install sites at `PluginSdkNpmVersion` — acceptance: neither site passes `InstallationLocal ? undefined : InstallationVersion` anymore; no leftover unused imports (covers: S2; depends: T1)
- [ ] T3: Run package typecheck + targeted unit tests — acceptance: `bun typecheck` and the new plugin-sdk-npm-version tests pass from `packages/opencode` (covers: S2; depends: T2)
