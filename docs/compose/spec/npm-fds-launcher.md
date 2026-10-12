---
feature: npm-fds-launcher
status: designed
updated: 2026-10-13
branch: feat/npm-fds-launcher
commits: 
---

# npm → FDS Launcher Feasibility

## Report

**What was built** — Analysis only (user decision: stop at analysis; T1–T6 deferred). The document records the npm channel root cause, a concrete FDS-launcher contract, compatibility surface, risk surface, and ranked alternatives. No release/runtime code changed.

**Conclusion** — Exactly-one binary download is not solvable by npm metadata: there is no AVX2 field, and platform packages omit `libc`. Linux x64 therefore matches 4×~130 MB optional packages. A version-pinned FDS launcher is feasible and can preserve the compatibility table in S3 if the vendor path stays outside the wipeable XDG cache. Main residual risks: first-run network, FDS trust/checksum, cache-path mistakes. Interim: set `libc` on platform packages to cut 4→2 without a launcher.

**Verification** — Read-only inspection of `script/release.ts`, `packages/cli/script/build.ts`, `postinstall.mjs`, `bin/mimo`, `install`, `src/installation/index.ts`, `src/global/index.ts`; `npm view` of `@mimo-ai/cli@0.1.15` and `@mimo-ai/mimocode-linux-x64@0.1.15` (unpackedSize 13 441 vs 134 990 540; `os`/`cpu` set, `libc` absent).

**Journey log**

1. Multi-download is postinstall's problem in appearance only — npm has already fetched every os/cpu match before the wrapper picks one.
2. `Global.Path.cache` (and thus `cache/bin`) is wiped on `CACHE_VERSION` bump — a launcher binary must not live there.
3. curl installer already owns the FDS layout (`releases/latest`, `releases/vX.Y.Z/<target>.tar.gz|zip`); the launcher should reuse it and pin `vX.Y.Z` to the package version rather than `latest`.
4. `libc` on platform packages is a 1-line packaging fix that halves the pain even if the launcher slips.

## [S1] Problem

`npm install -g @mimo-ai/cli` does not pull one binary. On a typical Linux x64 host it materializes **four** platform packages (~130 MB unpacked each, ~520 MB total) and keeps only one useful at runtime. Users report downloading several copies (`baseline`, `x64` variants, musl/glibc). The complaint is about **download volume and install time**, not about the CLI itself.

Root cause is npm `optionalDependencies` platform matching, not the wrapper's runtime selection.

| Host | Matching optional packages today | Actually needed |
| --- | --- | --- |
| Linux x64 glibc + AVX2 | `linux-x64`, `linux-x64-baseline`, `linux-x64-musl`, `linux-x64-baseline-musl` (4) | 1 (`linux-x64`) |
| Linux x64 glibc, no AVX2 | same 4 | 1 (`linux-x64-baseline`) |
| Linux x64 musl | same 4 | 1 (`linux-x64-musl` or `…-baseline-musl`) |
| Linux arm64 | `linux-arm64`, `linux-arm64-musl` (2) | 1 |
| Darwin/Windows x64 | native + `-baseline` (2) | 1 |

Each platform package is a full Bun-compiled binary:

- `@mimo-ai/mimocode-linux-x64@0.1.15` `dist.unpackedSize` = **134 990 540** (~129 MB)
- sibling baseline/musl packages are within ~3 MB of that
- `@mimo-ai/cli@0.1.15` itself is **13 441** bytes (bin wrapper + postinstall)

## [S2] Current channel

```text
npm install -g @mimo-ai/cli
        │
        ├─ optionalDependencies (12): @mimo-ai/mimocode-{os}-{arch}[-baseline][-musl]
        │     package.json fields today: os: [linux|darwin|win32], cpu: [x64|arm64]
        │     MISSING: libc (npm has it; we do not set it)
        │     MISSING: any AVX2/baseline discriminator (npm has none)
        │
        ▼
  npm downloads EVERY optional package whose os/cpu match
        │   (baseline and musl siblings share the same os/cpu)
        ▼
  postinstall.mjs hardlinks/copies one chosen binary to
  packages/@mimo-ai/cli/bin/.mimocode   (Windows: skipped; wrapper walks node_modules)
        │
        ▼
  bin/mimo (node): MIMOCODE_BIN_PATH → bin/.mimocode → walk node_modules
  by preference order (musl/avx2 detect) → spawnSync(argv)  [stdio inherit, exit code]
```

Evidence in tree:

- `script/release.ts` — 12 platforms, `optionalDependencies: { [@mimo-ai/${name}]: version }`, publish order npm libs → GitHub → FDS → npm cli.
- `packages/cli/script/build.ts` — platform `package.json` writes only `os` + `cpu` (no `libc`).
- `packages/cli/script/postinstall.mjs` + `packages/cli/bin/mimo` — pick **one** binary after npm already downloaded the matching set.
- `install` / `installation/index.ts` — curl channel already uses FDS (`https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/{latest,vX.Y.Z/…}`), no checksum verify today.

Why matching multiplies (not "Linux is special"):

1. **baseline vs non-baseline** — npm has no CPU-feature field. Both packages declare the same `os`/`cpu`, so both always match on that arch.
2. **musl vs glibc** — npm ≥10.13 supports `libc: ["glibc"|"musl"]`; our packages omit it, so both always match on Linux.
3. Linux x64 is the only host with **both** axes (4-way), which is why Linux users feel it most.

Partial mitigations that do **not** reach "exactly one download":

| Fix | Linux x64 downloads | Residual |
| --- | --- | --- |
| Add `libc: ["glibc"\|"musl"]` | 4 → 2 | still baseline ×2 |
| Drop baseline packages (ship only AVX2) | 4 → 2 (with libc) or 1 (if also drop musl) | perf / old-CPU regression |
| Ship only baseline (Bun `--target=bun-linux-x64-baseline`) | 1 | leaves performance on the table; still need musl split |
| npm `overrides` / user-side pin | 1 | not default UX; easy to get wrong |

npm cannot express "prefer AVX2, fall back to baseline" as a single optional match. **Exactly-one binary download is not achievable by metadata alone.**

## [S3] Design — `@mimo-ai/cli` as an FDS launcher

Goal (user constraint): keep install/CLI compatibility, have `@mimo-ai/cli` pull **exactly one** binary from FDS into a designated location, and forward argv unchanged.

### Contract

1. **Package shape.** `@mimo-ai/cli` keeps name, `bin: { mimo }`, version equal to the release version. `optionalDependencies` go **empty** (or are removed in a major). No platform tarball is required at install time. Unpacked size stays ~tens of KB.
2. **Detection (at run time, not install time).** Same target key as `install` / `bin/mimo` today:
   - `os` ∈ `darwin|linux|windows`
   - `arch` ∈ `x64|arm64` (map `x86_64`/`aarch64`)
   - linux: musl if `/etc/alpine-release` or `ldd --version` mentions musl
   - x64: baseline if no AVX2 (`/proc/cpuinfo`, `sysctl hw.optional.avx2_0`, `IsProcessorFeaturePresent(40)`)
   - target name: `mimocode-${os}-${arch}[-baseline][-musl]`
3. **Version pin.** The launcher downloads the binary **of its own package version** (`@mimo-ai/cli@X.Y.Z` → `releases/vX.Y.Z/<target>.{tar.gz|zip}`), not `releases/latest`. "确切的一份" = one artifact, one version, one target. `releases/latest` remains for the curl installer only.
4. **Fetch location (FDS).** `MIMO_FDS_BASE` (default `https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode`) + `/releases/v${version}/${archive}`. Same base override the curl installer already honors.
5. **On-disk location (designated).** One directory shared across npm installs, **outside** the wipeable XDG cache tree:

   | Mode | Path |
   | --- | --- |
   | `MIMOCODE_HOME` set | `$MIMOCODE_HOME/vendor/bin/v${version}/${target}/mimo[.exe]` |
   | XDG default | `${XDG_DATA_HOME\|~/.local/share}/mimocode/vendor/bin/v${version}/${target}/mimo[.exe]` |

   Reasons:
   - `Global.Path.cache` is **wiped when `CACHE_VERSION` changes** (`packages/cli/src/global/index.ts`); `Path.bin = cache/bin` must not own the launcher binary.
   - Path is versioned so N npm installs / rollbacks can coexist; a single symlink/copy is not rewritten in place while running.
   - `MIMOCODE_HOME` isolation keeps tests and multi-profile machines from sharing one binary.
6. **Fetch protocol.** First launch (or postinstall best-effort) downloads one archive to `*.partial`, verifies length and optionally SHA-256 (publish side writes `releases/vX.Y.Z/<target>.sha256`), extracts the single `mimo` executable, `chmod 755`, then `rename` into place. Concurrent launches take a lock (same `Flock` idea as elsewhere) and wait on the winner.
7. **Exec.** `child_process.spawn(bin, process.argv.slice(2), { stdio: "inherit" })`, forward signals where the platform allows, exit with the child's code. Do not rewrite args, cwd, or env except a documented user-agent if needed. Priority order preserved:
   1. `MIMOCODE_BIN_PATH` (escape hatch; no download)
   2. existing binary at the versioned vendor path (offline)
   3. download from FDS (online)
   4. clear error: network + URL + `--version X.Y.Z` hint
8. **Upgrade.** `npm i -g @mimo-ai/cli@X.Y.Z` (or pnpm/bun) bumps the launcher; the next `mimo` run fetches binary `vX.Y.Z`. Built-in `/upgrade` and `installation/index.ts` keep working: npm method still reinstalls the wrapper; curl method still uses `install`. Method detection that keys on `process.execPath` still sees a real binary after the launcher `exec`s it (argv0/execPath of the child is the vendor binary).
9. **Platform packages.** Keep publishing `@mimo-ai/mimocode-*` for direct installs and for anyone who vendors a binary; stop listing them as `optionalDependencies` of `@mimo-ai/cli` only. README continues to say "install that package directly" for the platform packages.

### Compatibility surface (must not break)

| Surface | Requirement |
| --- | --- |
| `npm/pnpm/bun i -g @mimo-ai/cli` | provides `mimo` on PATH |
| argv | forwarded unchanged (TUI, `--version`, pipes, exit codes) |
| stdio | inherit (interactive TUI, colors) |
| `MIMOCODE_BIN_PATH` | wins, no network |
| curl `install` / `install.ps1` | unchanged (separate channel) |
| built-in upgrade | npm/pnpm/bun/curl methods still work |
| direct `@mimo-ai/mimocode-*` install | still published and usable |
| `MIMO_FDS_BASE` | same override as curl installer |
| `MIMOCODE_HOME` | isolation for vendor binary too |
| first-run UX | may download once; later runs offline |

## [S4] Alternatives

| Option | Exactly-1 download | Compat | Notes |
| --- | --- | --- | --- |
| **A. FDS launcher (S3)** | yes | high if S3 table holds | moves trust/network from install to first run |
| **B. metadata-only** (`libc` + drop baseline) | no (2 or perf loss) | highest | does not solve baseline; shrinks the bug |
| **C. hybrid** — keep 1 optional package chosen by postinstall script with `os`/`cpu`/`libc` and a single "smart" package that downloads on postinstall | yes (1 npm + 1 FDS) | medium | still downloads 0 platform packages; postinstall becomes network-dependent |
| **D. ship only baseline binaries on npm, AVX2 via FDS/curl** | 1 npm pkg | medium | npm path loses AVX2 perf |
| **E. single fat npm package containing all targets** | 1 (huge) | high | worse than today |

Recommendation: **A**, with B as a cheap interim patch if a launcher lands later than the user-facing pain. C is A with an install-time prefetch — optional enhancement, not a separate architecture.

## [S5] Risk surface

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **First-run network dependency** (npm install succeeds offline-ish, first `mimo` fails) | high | clear error; document `MIMOCODE_BIN_PATH`; optional postinstall prefetch; curl installer already requires network |
| **Offline after cache filled** | medium | versioned vendor path persists; reinstall of the JS package does not delete vendor binaries |
| **FDS reachability outside CN / corporate proxy** | high | `MIMO_FDS_BASE` mirror; keep GitHub Release archives as secondary fallback (same filenames); document env |
| **Trust shift** (npm integrity/signatures → HTTPS FDS) | high | publish SHA-256 next to each archive; verify before exec; consider detached signature later; curl channel has the same gap today |
| **Supply chain / MITM** | high | TLS + checksum; never `curl \| bash` the binary from the launcher; pin version, do not follow `latest` |
| **Cache wipe footgun** | high if wrong path | do **not** store under `Global.Path.cache` / `cache/bin`; use `data/vendor` or `MIMOCODE_HOME/vendor` |
| **Windows AV / SmartScreen** on freshly extracted PE | medium | extract with predictable name `mimo.exe`, mark downloaded, keep existing postinstall note about extensionless PE; same as curl channel |
| **Concurrent `mimo` first-run** (CI matrix, parallel npm) | medium | file lock + atomic rename; single extractor |
| **Version skew** launcher vs binary | medium | pin to package version; refuse to run if vendor binary `--version` mismatches (cheap self-check) |
| **npm `--ignore-scripts`** | low | launcher no longer *needs* postinstall; download moves to first run |
| **pnpm/yarn global bin quirks** | medium | keep the existing thin `bin/mimo` node entry; test all three PMs |
| **Exit code / signal fidelity** | medium | `spawnSync`/`spawn` + `stdio: inherit`, propagate status/signal; add a wrapper test |
| **execPath / upgrade method detection** | medium | child binary's `execPath` is the real binary path (vendor or curl), so `installation.method` heuristics keep working; add a test |
| **`uninstall`** | low | document that `data/vendor` binaries may remain; `mimo uninstall` already offers cache cleanup — include vendor dir |
| **Multi-user machines** | low | vendor path is per-user (XDG data / `MIMOCODE_HOME`); no shared /usr/lib write |
| **Antivirus on postinstall download** | medium | prefer lazy download (A) over postinstall network (C) |
| **Breaking change for consumers of `optionalDependencies`** | low | rare; changelog + major bump if the set of published optional deps disappears from the wrapper |
| **FDS object ACL** (public read) | medium | already required by curl channel; keep public-read ACL on release archives + checksums |
| **Partial download / disk full** | medium | `*.partial` + rename; verify size/sha; retry once |

## [S6] Out of Scope

- Changing curl `install` / `install.ps1` / GitHub Release layout (they stay the non-npm channels).
- Brew/scoop/choco.
- Embedding the binary inside the npm tarball.
- Auto-updating the vendor binary without a package-manager version bump (that is the curl channel's job).
- Cross-host compilation or reducing the 12-target matrix.

## [S7] Decision summary

1. Problem is real and structural: npm cannot select "AVX2 else baseline", and we never set `libc`.
2. Exactly-one binary download requires moving selection out of npm optionalDependencies → **FDS launcher is feasible**.
3. Compatibility can be held on the table in S3 if vendor path avoids the wipeable cache and argv/stdio/`MIMOCODE_BIN_PATH` stay intact.
4. Main residual risks are **first-run network**, **FDS trust/checksum**, and **cache-path mistakes** — all have concrete mitigations.
5. Interim option B (`libc` fields; optionally drop baseline from npm) can ship independently and shrinks Linux from 4×130 MB to 2×130 MB without a launcher.

## Tasks

- [ ] T1: Land `libc` on platform packages and/or document the 2× baseline residual — acceptance: published platform package.json sets `libc: ["glibc"]` or `["musl"]` where applicable, or the doc explicitly defers this; Linux x64 install downloads ≤2 optional packages with a modern npm (covers: S2)
- [ ] T2: Implement version-pinned FDS launcher in `@mimo-ai/cli` (`bin/mimo` + tiny download helper) — acceptance: `npm i -g` of the packed wrapper with zero optionalDependencies runs `mimo --version` by fetching `releases/vX.Y.Z/<target>` into the S3 vendor path, honors `MIMOCODE_BIN_PATH` first, forwards argv, and is offline-capable after first fetch (covers: S3)
- [ ] T3: Publish per-archive SHA-256 and verify in the launcher — acceptance: release stage uploads `<target>.sha256` beside each archive; launcher refuses a mismatched payload (covers: S3, S5)
- [ ] T4: Adjust release/npm stages to stop treating 12 platform packages as optional deps of `@mimo-ai/cli` — acceptance: `script/release.ts` packs a wrapper without `optionalDependencies`, still publishes platform packages for direct install; trust list unchanged or updated explicitly (covers: S3)
- [ ] T5: Compatibility tests — acceptance: wrappers tests cover argv/exit-code forwarding, `MIMOCODE_BIN_PATH`, vendor cache hit without network, first-run fetch with a stub server, and `installation.method` still classifies the child binary (covers: S3, S5)
- [ ] T6: Docs (README_npm, CONTRIBUTING) — acceptance: install/upgrade/offline behavior of the launcher is documented, including `MIMO_FDS_BASE` and checksum policy (covers: S3, S5)
