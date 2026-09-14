---
feature: plugin-sdk-npm-version
status: delivered
updated: 2026-09-14
branch: feat/plugin-sdk-npm-version
commits: 4b1dfe2fa68bd6cf4d086244617ccac4146fc43a..aca33f1fd83637c83c26bc837d65b3068d697019
---

# Plugin SDK npm Version Resolution

## Report

**What was built** — Config/TUI background installs of `@mimo-ai/plugin` no longer pin the package to the engine install identity. A pure resolver `pluginSdkNpmVersion(version, local)` in `installation/version.ts` decides the npm version: local installs and non-semver identities (`desktop-<hash>`, other non-npm strings) omit the version so npm resolves latest; only a valid semver identity (release and prerelease forms) pins that exact string. Both install sites (`config/config.ts`, `tui/config/tui.ts`) consume the runtime binding `PluginSdkNpmVersion`. `InstallationVersion` / `InstallationLocal` remain the install identity for skill extraction, User-Agent, upgrade, and other consumers.

**Verification** — From `packages/opencode` on the feature worktree: `bun typecheck` PASS (`tsgo --no-emit` clean); `bun test test/installation/plugin-sdk-npm-version.test.ts` PASS (3 pass / 0 fail); `bun test test/installation/` PASS (22 pass / 0 fail). Grep confirms no remaining `InstallationLocal ? undefined : InstallationVersion` in package source. Independent review passed spec compliance, correctness, and codebase consistency with no critical findings.

**Journey log** —
- Desktop embeds intentionally burn `MIMOCODE_VERSION=desktop-<pin>` for skill path isolation; that identity must stay, so the fix is in the engine consumer, not the desktop inject.
- `InstallationLocal` is channel-based (`=== "local"`), not version-based — desktop runs `channel=latest` + non-semver version, so both flags matter for the pin decision.
- npm install stringifies as `[name, version].filter(Boolean).join("@")`; `undefined` correctly means unpinned, not `@pkg@undefined`.
- Residual (explicit out of scope): a non-local *valid but unpublished* semver identity still fails resolution with warn-only; no registry probe/fallback in this change.

## [S1] Problem

Config load installs `@mimo-ai/plugin` into each config directory so user plugins can import the SDK. The install request currently pins the package version to `InstallationVersion` whenever `InstallationLocal` is false.

`InstallationVersion` is an **install identity**, not an npm dist-tag. Official CLI releases use a published semver and match npm versions. Embedding hosts (MiMo Desktop) deliberately inject `MIMOCODE_VERSION=desktop-<pin hash>` with `MIMOCODE_CHANNEL=latest` so builtin skill / compose extraction paths advance with the pin. That identity never exists on npm, so config load requests `@mimo-ai/plugin@desktop-<hash>`, npm resolution fails, and the engine only logs `background dependency install failed`. User plugins that import `@mimo-ai/plugin` from a config directory then fail to resolve at runtime.

## [S2] Design

Decouple **install identity** from **npm package version resolution**.

`InstallationVersion` / `InstallationLocal` remain unchanged: they still drive User-Agent, telemetry, skill extraction directories, and release upgrade checks.

A pure resolver and its runtime binding live in `packages/opencode/src/installation/version.ts`:

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

Semver validity uses the same `semver` package already used by npm/plugin code (`semver.valid`). Preview prereleases are valid semver and stay pinned when they are the release identity. The helper checks format validity, not registry presence.

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

- [x] T1: Add `pluginSdkNpmVersion` pure helper + `PluginSdkNpmVersion` binding in `installation/version.ts` — acceptance: local → undefined; valid semver non-local → same string; non-semver non-local (desktop-hash) → undefined; covered by unit tests (covers: S2)
- [x] T2: Point `config.ts` and `tui.ts` `@mimo-ai/plugin` install sites at `PluginSdkNpmVersion` — acceptance: neither site passes `InstallationLocal ? undefined : InstallationVersion` anymore; no leftover unused imports (covers: S2; depends: T1)
- [x] T3: Run package typecheck + targeted unit tests — acceptance: `bun typecheck` and the new plugin-sdk-npm-version tests pass from `packages/opencode` (covers: S2; depends: T2)
