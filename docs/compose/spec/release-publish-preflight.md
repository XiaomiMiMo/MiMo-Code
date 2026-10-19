---
feature: release-publish-preflight
status: delivered
updated: 2026-10-19
branch: fix/release-preflight-checks
commits: 135cb231..0adeefc0
---

# Release Publish Preflight

## Report

**What was built** — The publish job now runs a blocking `bun script/release.ts preflight` after artifact download and before any npm/GitHub/FDS stage. Preflight asserts every `@mimo-ai/{sdk,plugin,cli}` tarball exists under `dist/release/npm` with matching embedded `name`/`version`, fails when `MIMO_FDS_AK`/`MIMO_FDS_SK` are missing, and uploads a small `releases/v{version}/.preflight-ok` canary through the real FDS signing path so unusable credentials stop the release before anything half-ships. China mirror sync now includes `@mimo-ai/sdk` and `@mimo-ai/plugin`, and the `npm cli` step label matches what it publishes (`npm — @mimo-ai/cli launcher`).

**Verification** — `bun test script/release.test.ts --timeout 120000` PASS (11 tests / 30 expects). `tsgo --noEmit -p tsconfig.scripts.json` PASS. `bunx oxlint` on changed scripts: 0 errors (9 warnings match existing `expect().rejects` / sync-registry assertion style). Independent review: all five acceptance criteria met; no critical findings.

**Journey log** — Preflight was scoped to tarball completeness + FDS canary only; trusted-publisher / `allow-publish` checks stay in maintainer `trust` (CI has no npm owner session). Residual accepted risk: FDS can still die mid-upload after a green canary; recover with “Re-run failed jobs”. Canary is intentionally public-read like every other FDS object and is not referenced by `releases/latest`.

## [S1] Problem

The publish job runs `npm libs` → `github` → `fds` → `npm cli` with no gate in front of it. FDS credentials and the built npm tarballs are only exercised after some channels have already shipped. A missing `MIMO_FDS_AK`/`MIMO_FDS_SK`, an unreachable FDS endpoint, or a corrupt/incomplete `dist/release/npm` therefore leaves a half-published release (SDK/plugin and/or GitHub Release already out, installers still on the old pin). China mirror sync also omits `@mimo-ai/sdk` and `@mimo-ai/plugin`, so new library versions never reach npmmirror while `@mimo-ai/cli` does.

## [S2] Design

Run a blocking **preflight** as the first step of the `publish` job, after artifact download and before any npm/GitHub/FDS publish stage.

1. **Tarballs present and coherent** — for each package in `npmGroups.libs + npmGroups.cli` (`@mimo-ai/sdk`, `@mimo-ai/plugin`, `@mimo-ai/cli`), require `dist/release/npm/<tarball>` to exist and its embedded `package/package.json` `name`/`version` to match the release version. Fail with the full missing/mismatched list. This reuses the same name/version rule `pack()` enforces at build time.
2. **FDS usable** — fail fast unless `MIMO_FDS_AK` and `MIMO_FDS_SK` are set. Then prove signing + network + bucket with one small canary upload (`releases/v{version}/.preflight-ok`, body = version text). Upload uses the existing `putObject` path (including public-read ACL). A second run of the same release overwrites the canary; it is not published as an install artifact and is not referenced by `releases/latest`.
3. **Mirror list complete** — `script/sync-registry.ts` `PACKAGES` includes `@mimo-ai/sdk` and `@mimo-ai/plugin` alongside `@mimo-ai/cli` (legacy platform package names stay for historical mirror completeness).
4. **Step label** — the publish step that runs `bun script/release.ts npm cli` is named for what it actually publishes (`npm — @mimo-ai/cli launcher`), not “platform packages and CLI wrapper”.

Preflight is one new stage `bun script/release.ts preflight` invoked from `release.yml`. It is intentionally ordered **before** `npm libs` so a bad FDS/credential/artifact state cannot leave npm or GitHub half-shipped. Mid-upload FDS failure after a green preflight can still interrupt a release; that residual window is accepted and recovered with “Re-run failed jobs”.

Out of band: trusted-publisher / `allow-publish` registration stays a maintainer `trust` step and is not part of this preflight (CI has no npm owner session).

## [S3] Out of Scope

- Changing publish order of `npm libs` / `github` / `fds` / `npm cli`.
- Fixing `trust()` skip / revoke-recreate for `--allow-publish` (separate change).
- Uploading per-archive `*.sha256`.
- Rewriting stale prose in `docs/compose/spec/release-ci.md` beyond what this change requires.
- Making China mirror sync a blocking release gate.

## Tasks

- [x] T1: Add `preflight` stage in `script/release.ts` — acceptance: missing tarball name/version mismatch and missing FDS creds throw before any upload; canary succeeds when creds and endpoint work (`covers: S2`)
- [x] T2: Call `preflight` as the first publish step in `.github/workflows/release.yml` and rename the `npm cli` step label (`covers: S2`; depends: T1)
- [x] T3: Add `@mimo-ai/sdk` and `@mimo-ai/plugin` to `script/sync-registry.ts` PACKAGES (`covers: S2`)
- [x] T4: Tests for preflight tarball checks and FDS credential failure (`covers: S2`; depends: T1)
