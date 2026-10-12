---
feature: npm-fds-launcher
status: delivered
updated: 2026-10-13
branch: feat/npm-fds-launcher
commits: 8e1df4ab..f78f35fb
---

# npm FDS Launcher

## Report

**What was built** — `@mimo-ai/cli` is now a thin launcher instead of a hub of 12 `optionalDependencies` platform packages. `bin/mimo` detects one target (os/arch/AVX2/musl), uses `MIMOCODE_BIN_PATH` or package-local `vendor/mimo[.exe]`, otherwise downloads exactly one version-pinned FDS archive (`releases/vX.Y.Z/<target>.{tar.gz|zip}`) into `vendor/`, and forwards argv with inherited stdio. `postinstall` prefetches best-effort and never fails install. FDS failure exits 1 with the real error and a recommended `curl`/`irm` native install. `npm uninstall` deletes the binary with the package directory. Wrapper packaging drops `optionalDependencies`. READMEs mark npm as limited support: `README.md` / `README.zh.md` only recommend curl/irm; `README_npm.md` recommends the native installer over `npm install -g @mimo-ai/cli` and still names the package for users who need it.

Upgrade is package replace, not tree migration: no leftover-`node_modules` fallback. If the first run cannot reach FDS, it says so and points at curl/irm.

**Verification** — `bun test ./test/installation/launcher.test.ts ./test/installation/launcher-bin.test.ts ./test/installation/postinstall.test.ts` in `packages/cli` — PASS, 28 tests (12-target matrix, URL pin + `MIMO_FDS_BASE`, vendor hit offline, FDS fetch via stub, sha256 match/mismatch/fail-closed, argv/exit codes, postinstall best-effort, FDS-down error + curl/irm hint). Independent review of `8e1df4ab..5707931b` met T2/T4/T5/T6 acceptance; criticals (download timeout, sha256 fail-open, Windows rename race, postinstall import layout) fixed in follow-up commits.

**Journey log**

1. Multi-download is not postinstall picking wrong — npm already fetched every `os`/`cpu` match; baseline/musl siblings share those fields.
2. Do not put the launcher binary under `Global.Path.cache` (wiped on `CACHE_VERSION`).
3. Upgrade = uninstall old package + install new; do not paper over orphans with legacy `node_modules` lookup.
4. `Bun.spawnSync` deadlocks tests that also `Bun.serve` in-process — use async spawn around local stubs.

## [S1] Problem

`npm install -g @mimo-ai/cli` pulled several platform packages (~130 MB each) on Linux x64 because `optionalDependencies` matching cannot distinguish baseline vs AVX2 or musl vs glibc (`os`/`cpu` identical; `libc` was unset). Users saw multiple huge downloads while only one binary was used.

## [S2] Delivered design

### Package

- Name `@mimo-ai/cli`, `bin: { "mimo": "./mimo.js" }`, version = release version, `"type": "module"`, `engines.node >=20.10.0`.
- No `optionalDependencies`. **No npm platform packages** — binaries ship as FDS/GitHub archives only.
- Shipped files: `mimo.js`, `launcher.js`, `postinstall.mjs`.

### Runtime resolution (`mimo.js`)

1. `MIMOCODE_BIN_PATH` → spawn that.
2. `<package-root>/vendor/mimo` or `vendor/mimo.exe` → spawn that.
3. Else download from FDS into `vendor/`, then spawn.
4. On failure: exit 1 with the error and recommended `curl -fsSL https://mimo.xiaomi.com/install | bash` (Windows: `irm https://mimo.xiaomi.com/install.ps1 | iex`).

Detection (one target, all 12 published names):

- `darwin|linux|windows` × `x64|arm64`
- linux musl via `/etc/alpine-release` or `ldd --version`
- x64 baseline when AVX2 is absent (`/proc/cpuinfo`, `sysctl hw.optional.avx2_0`, `IsProcessorFeaturePresent(40)`)
- name `mimocode-${os}-${arch}[-baseline][-musl]`

### Fetch

- URL: `MIMO_FDS_BASE` (default `https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode`) + `/releases/v${packageVersion}/${target}.tar.gz|.zip` — pinned to the package version, never `releases/latest`.
- Stream to temp, optional `<url>.sha256` check when published (404 skips), extract the single `mimo[.exe]`, chmod 755, `*.partial` + rename.
- `postinstall.mjs` calls the same helper; failures only warn. First run still downloads when needed.

### Upgrade

`npm/pnpm/bun i -g @mimo-ai/cli@X.Y.Z` (or built-in upgrade) replaces the package; the new launcher fetches `vX.Y.Z`. Curl channel and `installation/index.ts` methods are unchanged. Publish order (FDS before `npm cli`) already guarantees the archive exists.

### Uninstall

Binary lives inside the package directory → `npm uninstall` / `pnpm remove` / `bun remove` / `rm -rf node_modules` all remove it. No uninstall lifecycle hook.

On Windows a running PE is locked: `bin/mimo` copies `vendor/mimo.exe` to `%TEMP%/mimocode-bin/<version>/` once and executes that copy, so `vendor/` itself stays deletable while mimo runs (upgrade/uninstall from a live TUI). The temp copy is a run artifact, not the install.

## [S3] Compatibility

| Surface | Behavior |
| --- | --- |
| `mimo` on PATH | `bin.mimo` unchanged |
| argv / stdio / exit code | forwarded |
| `MIMOCODE_BIN_PATH` | wins, no network |
| curl `install` / `install.ps1` | untouched |
| built-in upgrade | npm/pnpm/bun/curl methods work |
| Direct `@mimo-ai/mimocode-*` | still published |
| `MIMO_FDS_BASE` | same override as the curl installer |

## [S4] Rejected (not in this change)

- Shared XDG/vendor cache and `MIMOCODE_VENDOR_DIR` — orphans on uninstall.
- Leftover `node_modules/@mimo-ai/mimocode-*` fallback — upgrade is package replace.
- `libc`-only metadata fix or shipping a single fat npm package.
- `releases/latest` pin, curl|bash from the launcher, embedding the binary in the npm tarball.

## [S5] Risks (accepted / mitigated)

| Risk | Mitigation in tree |
| --- | --- |
| First-run needs FDS | postinstall prefetch; honest error + curl/irm hint |
| FDS trust | version pin; optional sha256 when `*.sha256` is published |
| Wrong cache path | `vendor/` inside the package only |
| `--ignore-scripts` | first run downloads |
| Windows AV on extracted PE | extract as `mimo.exe` |

Not done here: release-stage upload of `*.sha256`, CONTRIBUTING deep-dive, `installation.method` regression test for the vendor child.

## [S6] Out of Scope

- curl installer / GitHub Release layout, brew/scoop/choco, reducing the 12-target matrix, auto-updating the vendor binary without a package-manager bump.

## Tasks

- [ ] T1: Land `libc` on platform packages — **not done** (launcher supersedes; optionalDependencies removed from the wrapper)
- [x] T2: Version-pinned FDS launcher in `@mimo-ai/cli` (`bin/mimo` + `launcher.js`) — `bin` is `mimo`; package-local `vendor/`; `MIMOCODE_BIN_PATH` first; FDS failure exits 1 with curl/irm hint (covers: S2)
- [ ] T3: Publish per-archive SHA-256 — launcher verifies when `<url>.sha256` exists; **release upload of checksums not added**
- [x] T4: `script/release.ts` packs the wrapper without `optionalDependencies`; platform packages still published (covers: S2)
- [x] T5: Tests for argv/exit codes, `MIMOCODE_BIN_PATH`, vendor hit, FDS fetch, sha256 mismatch, postinstall best-effort, FDS-down hint (covers: S2, S5)
- [x] T6: README.md / README.zh.md drop npm install; README_npm.md recommends curl/irm over `npm install -g @mimo-ai/cli` and still names the package (covers: S2, S3)
