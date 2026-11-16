---
feature: bun-1-4-compat
status: in-progress
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2821
---

# Bun 1.4.4 compatibility survey

## Report

This branch moves the root `packageManager` pin from `bun@1.3.14` to `bun@1.4.4` as an
experiment, then compares install, typecheck, tests, the single-binary build and runtime smoke
checks against 1.3.14. No product code is changed. Every temporary instrumentation patch
described below was reverted before commit.

| #  | Area | Symptom | 1.3.14 | 1.4.4 | Root cause | Severity |
| -- | ---- | ------- | ------ | ----- | ---------- | -------- |
| F1 | TUI startup (Worker messaging) | Interactive TUI never draws. The process stays alive at 0% CPU with an empty worker log. | Draws in 5/5 starts | Hangs in 5/5 starts (compiled and from source) | Bun 1.4.4 drops a `postMessage` sent to a Worker before the worker's global `onmessage` exists; 1.3.14 queues it. | **Critical** (issue #2782); **fixed runtime-independently by #2820** |
| F2 | `Bun.stringWidth` | `test/cli/tui/collapse.test.ts` › "keeps one cluster even when it is wider than the whole budget" fails deterministically | `stringWidth("\u1100\u1161\u11A8") === 4` | `=== 2` | Runtime changed grapheme-width rules for conjoining Hangul jamo; 1.4.4 now matches the precomposed syllable `한` (2) | Low (test pins old runtime behaviour; TUI clipping for decomposed jamo changes by 2 cells) |
| F3 | `@npmcli/agent` proxy patch | Installing an npm plugin with `http(s)_proxy` set fails: `fetch() proxy.url must be a non-empty string` | **Bug in shipped builds**: patch keyed to 4.0.0 never applies to the locked 4.0.2 | Install works (1.4.4 accepts a `URL` here); `bun ci` warns that the patch no longer applies | `@npmcli/agent` exposes `agent.proxy.url` as a `URL`; Bun 1.3.14's `node:http` passes it to `fetch`, which requires a string | **Medium, pre-existing, affected releases up to 0.1.17; fixed by #2822** |
| F4 | Test isolation | CI on the 1.4.4 pin (rebased on #2820) is red only on F2; the other shard failures from the first run did not recur | CI green | CI: only F2 fails | Not runtime-specific. CI already runs the `mock.module` MCP suites in separate processes. `bun test --isolate` exists on **both** runtimes and makes `test/mcp` pass 152/152 on both, while a plain run fails 32 on both | Info (CI could adopt `--isolate`; unrelated to the pin) |
| F5 | Compiled binary size | `dist/mimocode-darwin-arm64/bin/mimo` | 101,357,666 B | 128,227,298 B (+27%) | Larger Bun 1.4.4 runtime embedded by `bun build --compile` | Info |

Everything else matched across runtimes: `bun ci` (same 1063 packages in the `node_modules/.bun`
store, lockfile untouched), `bun run typecheck` (passes), build (`exit 0`, built-in smoke
passes), `--version`, `models`, headless `run` (reaches the provider, which returns 401), and
`serve --port 0` (HTTP 200 on all four endpoints probed).

A main-side "worker ready" handshake (now merged as #2820) made the 1.4.4 TUI draw in 5/5 starts.
The privacy dialog, `ctrl+p`, prompt submit and clean exit (`EXIT=0`, about 1 s) all worked.
No second TUI blocker surfaced behind F1.

With the pin rebased onto #2820, CI fails only on F2. F3 turned out to be a bug in 1.3.14 releases, not a 1.4 issue; it is fixed by #2822.

## [S1] Problem

Homebrew's `mimo-code` formula builds this repository with Homebrew's Bun 1.4.4. It rewrites the
`packageManager` pin, then runs
`cd packages/cli && bun --bun ./script/build.ts --single --skip-install`. Users of that build hit
a TUI that never draws (#2782). We need to know whether that is the only 1.4.4 incompatibility,
and how 1.4.4 affects install, typecheck, tests and the other CLI entry points.

## [S2] Method (commands run, versions)

- Runtimes: `1.4.4+38afee6c8` (`~/.local/share/vite-plus/package_manager/bun/1.4.4/bun/bin/bun.native`)
  and `1.3.14` (`0d9b296a`, `…/bun/1.3.14/bun/bin/bun.native`). The bare `bun` vite-plus shim
  follows the root pin, so after the pin change it resolves to 1.4.4.
- Base commit: `24c3d937` (origin/main). Worktree branch: `chore/bun-1-4-compat-survey`.
- macOS arm64. tmux 120×30 panes. Isolated `MIMOCODE_HOME` / workspace from `mktemp -d` under
  `/tmp`. `MIMOCODE_PURE=true`, `--trust`.

Commands (from the worktree root unless noted):

```bash
# 1. pin + install
sed -i '' 's/"packageManager": "bun@1.3.14"/"packageManager": "bun@1.4.4"/' package.json
bun ci                                   # 1.4.4
git archive HEAD | tar -x -C /tmp/example-1314 && (cd /tmp/example-1314 && $BUN_1314 ci)   # 1.3.14 baseline copy

# 2. typecheck
bun run typecheck

# 3. tests (sequential, never two full suites at once)
(cd packages/cli && $BUN_144  test --timeout 30000)          # full, 1.4.4
(cd packages/cli && $BUN_1314 test --timeout 30000)          # full, 1.3.14
(cd packages/cli && $BUN_xxx  test --timeout 30000 <26 files that failed on 1.4.4>)   # both runtimes
(cd packages/cli && $BUN_144  test --timeout 30000 <1.4.4-only files>)   # x2, plus single-file reruns

# 4. build + smoke
(cd packages/cli && bun --bun ./script/build.ts --single --skip-install)              # 1.4.4
(cd /tmp/example-1314/packages/cli && MIMOCODE_CHANNEL=survey MIMOCODE_COMMIT_SHA=24c3d937 \
   $BUN_1314 --bun ./script/build.ts --single --skip-install)                          # 1.3.14
BUN_BE_BUN=1 ./mimo --version          # confirms embedded runtime: 1.4.4 / 1.3.14
MIMOCODE_HOME=$(mktemp -d) ./mimo models
echo "Say hello" | MIMOCODE_HOME=$(mktemp -d) ./mimo run --format json --dangerously-skip-permissions --dir /tmp/example
MIMOCODE_HOME=$(mktemp -d) ./mimo serve --port 0 ; curl /global/health /config /session /doc
# TUI: 5 starts per variant; tmux remain-on-exit on, stderr to a file, poll 20 s for "ctrl+p"
tmux respawn-pane -k -t S "MIMOCODE_HOME=… MIMOCODE_PURE=true ./mimo /tmp/example --trust 2>err; echo EXIT=\$? >>err"
```

The 1.3.14 build needed a clean copy with the original pin. `script/meta.ts` checks
`semver.satisfies(process.versions.bun, ^<pin>)`, so `^1.4.4` rejects 1.3.14. The copy is a
`git archive` without `.git`, so `MIMOCODE_CHANNEL`/`MIMOCODE_COMMIT_SHA` replace the
`git branch` / `git rev-parse` lookups.

## [S3] Findings

### F1 — Worker drops the TUI's first RPC on 1.4.4 (critical)

Minimal reproduction, with no repository code:

```ts
// w.ts
await new Promise((r) => setTimeout(r, 200))
onmessage = (e) => postMessage("echo:" + e.data)
// main.ts
const w = new Worker(new URL("./w.ts", import.meta.url).href)
w.onmessage = (e) => console.log(Bun.version, "got", e.data)
w.postMessage("hello")
```

1.3.14 prints `got echo:hello`. 1.4.4 never replies.

TUI evidence:

| Variant | Starts | Drew `ctrl+p` | Notes |
| ------- | ------ | ------------- | ----- |
| binary built with 1.3.14 | 5 | 5 | 2–3 s each |
| binary built with 1.4.4 | 5 | 0 | pane alive after 20 s, only the DB-migration lines on screen; Ctrl+C kills it |
| source, `bun run --conditions=browser ./src/index.ts`, 1.4.4 | 5 | 0 | same |
| source, 1.4.4, buffer `onmessage` installed at **top of worker module body** (temp) | 5 | 0 | does not help, see trace |
| source, 1.4.4, main awaits a worker-emitted ready event before the first `call` (temp) | 5 | 5 | 4–5 s; interaction and exit OK |

The hung process has an empty worker log. The main log stops after the migration lines. The
process sits at 0% CPU, which matches `thread.ts` awaiting `client.call("server")` with no
timeout.

Trace from temporary `appendFileSync` instrumentation (1.4.4, from source):

```
main new Worker        t+0 ms
main post server       t+37 ms     # thread.ts first client.call
worker body start      t+533 ms    # first statement of worker.ts module body
listen; replay 0                   # top-of-body onmessage buffer saw nothing
```

The message is lost while the worker is still evaluating its **imports**, before any statement in
`worker.ts` runs. So moving `Rpc.listen` above `await Log.init(...)`
(`packages/cli/src/cli/cmd/tui/worker.ts`, `Rpc.listen(rpc)` at line 151) is **not sufficient on
its own**. Even a listener on the first line of the module body is installed too late. A robust
fix needs the main side to wait for a worker-originated "ready" message (or to retry or time out)
before the first `client.call`, or needs the listener installed by a tiny entry module that has
no heavy imports and loads the real worker afterwards.

`new Worker` exists in exactly one place (`packages/cli/src/cli/cmd/tui/thread.ts:268`). It is
the only `Rpc.client` / `Rpc.listen` pair in `src`, so no other Worker site is exposed.

The "tmux session exits on its own" observation from an earlier quick attempt came from a wrong
binary path (a directory). The TUI never actually ran there. With the correct binaries, the 1.4.4
TUI hangs and never exits by itself.

### F2 — `Bun.stringWidth` change for conjoining Hangul jamo

```bash
bun -e 'console.log(Bun.stringWidth("\u1100\u1161\u11A8"))'   # 1.3.14: 4   1.4.4: 2
```

Other probes are identical on both runtimes: CJK `中文` 4, `❤️` 2, flag 2, ZWJ family 2, tab 0,
`e\u0301` 1, ANSI-wrapped `red` 3, keycap 2, `한` 2.
`packages/cli/test/cli/tui/collapse.test.ts:92` asserts the old value. This is the only
deterministic test failure specific to 1.4.4: it fails in the full run, the 26-file subset run and
two isolated reruns. Production callers are `src/cli/cmd/tui/util/collapse.ts:30`,
`src/cli/cmd/tui/component/prompt/offset.ts:16`, `prompt/index.tsx:768` and
`prompt/autocomplete.tsx:182`. The only effect is a 2-cell width difference for decomposed jamo
sequences.

### F3 — `@npmcli/agent` proxy patch never applies (bug in shipped builds)

`package.json` `patchedDependencies` keys `@npmcli/agent@4.0.0`, but `bun.lock` has resolved
`@npmcli/agent@4.0.2` since the initial import. So the patch has never applied in this repository.
1.3.14 skips it silently; 1.4.4 prints `no longer applies`. The patch applies cleanly to 4.0.2.

The patch matters. `getAgent()` reads `https_proxy` / `http_proxy` / `proxy` from the environment at
module load and stores the proxy as a `URL`. Its `proxy` getter returns `{ url: <URL> }`. Bun's
`node:http` reads `agent.proxy.url` and hands it to `fetch()`:

| Runtime | unpatched 4.0.2 | patched 4.0.2 |
| --- | --- | --- |
| 1.3.14 | `ERROR fetch() proxy.url must be a non-empty string`, request never sent | goes through the proxy |
| 1.4.4 | goes through the proxy | goes through the proxy |

Reproduced with the released binary (0.1.17, embedded Bun 1.3.14):

```sh
cd /tmp/example && https_proxy=http://127.0.0.1:8080 mimo plugin left-pad
# ■  request to https://registry.npmjs.org/left-pad failed, reason: fetch() proxy.url must be a non-empty string
```

So every npm plugin install via Arborist (`src/npm/index.ts`) fails for users behind a proxy
configured through the environment, whether or not the proxy works. This is independent of the
1.4 pin. Fixed by #2822, which re-keys the patch to 4.0.2 and adds `test/npm-proxy.test.ts`. That
test asserts that `Agent.proxy.url` is a string, so a dropped patch fails on any runtime.

### F4 — Test isolation (not runtime-specific)

An earlier version of this survey compared two plain full `bun test` runs (75–77 failures each) and
called that "suite noise". That comparison does not reflect CI. `.github/workflows/test.yml` already
excludes the `mock.module` MCP suites, provider refresh, `runtime-worktree`, `stdio-exit-observe`
and `subagent-resume-negatives` from the sharded run, and runs them in separate processes.

CI on the 1.4.4 pin:

| Run | Result |
| --- | --- |
| first push (base 24c3d937) | shard 1: F2; shard 2: `Bun timeout interrupts and finalizes Effect tests…`; shard 4 isolated step: `subagent resume recovery negatives > cascade resume…` |
| rebased on #2820 | only F2 (moved to shard 4); all other shards green |

The two non-F2 failures pass 3/3 locally on both runtimes and did not recur, so they are CI timing
flakes.

`bun test --isolate` (a fresh global per file) exists on 1.3.14 already. 1.4.4 adds `--no-isolate`
and `--timings` (built-in duration-balanced sharding). Running `test/mcp`:

| Runtime | plain | `--isolate` |
| --- | --- | --- |
| 1.3.14 | 120 pass / 32 fail (494 s) | 152 pass / 0 fail (120 s) |
| 1.4.4 | 120 pass / 32 fail (487 s) | 152 pass / 0 fail (91 s) |

So isolation is available today; it is not something only an upgrade unlocks. Whether `--isolate`
also covers the process-wide-idleness checks (provider refresh) is untested.


**Rare flake on 1.4.4: `subagent-resume-negatives` › "cascade resume on full actor without fork
context fails honestly".** On CI with the 1.4.4 pin, it failed 2 times in about 76 runs (about 2.6%):
`providerCalls` was 1, expected 0. Both failures happened in shard 4's isolated step in early
runs. Later runs passed every time:
- 2 normal CI runs;
- 30 runs of the single test and 30 runs of the whole file on a dedicated runner;
- 10 consecutive runs in shard 4's isolated step right after the shard step.

Ruled out:
- The child actor fails at the missing-fork guard (`src/session/prompt.ts`) before any provider
  call.
- Test data dirs are per-pid, so no state is shared.
- No bun/node processes outlive the shard step, and load average was about 1.

On 1.3.14, main passed 12/12, which is too few runs to tell a 2.6% rate apart from zero. So this
is not shown to be runtime-specific. Hypothesis, not confirmed: the failure notification wakes
the main session, which reaches the provider before the test samples the count. If so, the
assertion should be scoped to the child's requests. The test keeps a temporary capture dump
(`DIAG provider capture`) on this branch so the next occurrence shows who made the call.

`Memory.reconcile` (`pruned: 27`, foreign rows from other files) also failed once on this
branch; it fails on main too and is a pre-existing flake.

### F5 — Build and non-TUI smoke

| Check | 1.3.14 binary | 1.4.4 binary |
| ----- | ------------- | ------------ |
| build | exit 0, built-in smoke passes | exit 0 (about 4 s), built-in smoke passes |
| `BUN_BE_BUN=1 mimo --version` | 1.3.14 | 1.4.4 |
| `mimo --version` | `0.0.0-survey-24c3d937` | `0.0.0-chore/bun-1-4-compat-survey-24c3d937` |
| `mimo models` | exit 0, lists `xiaomi/mimo-v2.6-*` | identical |
| headless `mimo run --format json` (no credentials) | exit 0, one `error` event: `APIError` 401 Invalid API Key | identical |
| `mimo serve --port 0` | listens; `/global/health` `/config` `/session` `/doc` → 200 | identical (health body differs only by version string length) |
| TUI | draws 5/5 | hangs 5/5 (F1) |
| size | 101,357,666 B | 128,227,298 B |

The build runs two version checks. `script/meta.ts`, which `build.ts` imports statically so it
evaluates first, accepts any `^<pin>`. `packages/cli/script/build.ts` then requires
`Bun.version === <pin>` exactly. With the upstream pin `1.3.14`, Bun 1.4.4 passes the first check
and fails the second. Homebrew's rewrite of the pin is therefore what lets its build proceed. The
resulting binary is broken because the embedded 1.4.4 runtime triggers F1.

## [S4] Out of Scope

- Fixing F1 here; it landed separately in #2820.
- Node build (`script/build-node.ts`), Windows/Linux targets, the `packages/sdk` / plugin tests,
  and authenticated end-to-end model turns (no credentials were used).
- An exhaustive Bun-API audit. APIs were checked only where a failure pointed at them (`Worker`,
  `Bun.stringWidth`).

## Tasks

Suggested order. Each item keeps 1.3.14 working and removes a 1.4 blocker or an existing bug.

- [x] **T1 — TUI worker handshake survives Bun 1.4.x.** Delivered by #2820 (ready handshake in
  `src/util/rpc.ts`).
- [x] **T2 — `collapse.test.ts` stops pinning runtime-specific jamo width.** Done on this branch:
  the test asserts only that the cluster is wider than the budget, with the budget lowered from 2 to
  1 cell. It passes 16/16 on 1.3.14 and 1.4.4. Acceptance: the test
  asserts the clipping invariant with a cluster whose width is the same on 1.3.14 and 1.4.4, and
  passes on both runtimes. This is the only remaining CI failure on the 1.4.4 pin.
- [x] **T3 — Re-key the `@npmcli/agent` patch to 4.0.2.** Delivered by #2822. Acceptance: `patchedDependencies` and
  `bun.lock` reference `@npmcli/agent@4.0.2`; the installed `lib/agents.js` returns
  `this.#proxy.toString()`; with `https_proxy` set, `mimo plugin <pkg>` on a 1.3.14 build no longer
  fails with `proxy.url must be a non-empty string`. Fixes a bug in current releases.
- [ ] **T4 — Consider `bun test --isolate` in CI.** Acceptance: the hand-written isolated steps are
  replaced or reduced where `--isolate` gives equal results on 1.3.14 (it does for `test/mcp`),
  with CI green.
- [ ] **T5 — Decide the pin bump.** Optional; no upgrade is planned. Acceptance: after T2 lands,
  either the pin moves to `bun@1.4.x` with CI green, or the supported Bun range for downstream
  packagers such as Homebrew is documented.

## Journey log

- The first TUI attempt "exited on its own". That was a wrong explicit-binary path (a directory),
  not runtime behaviour. Using `tmux set remain-on-exit on`, stderr redirected to a file and an
  appended `EXIT=$?` makes such cases unambiguous.
- The obvious fix hypothesis (call `Rpc.listen` before `await Log.init`) was tested by installing
  a buffering `onmessage` on the first line of `worker.ts`. The TUI still hung. Timestamped traces
  showed the message posted about 500 ms before the module body started. The loss happens during
  import evaluation, so the fix must be a handshake initiated by the worker or a thin entry module.
- One full-suite run per runtime cannot classify failures: about half of each run's failures
  differ between two runs on the same commit. Classification used the targeted file subset on both
  runtimes, then isolated reruns of the 1.4.4-only files.
- The clean 1.3.14 build needed a `git archive` copy with the original pin, plus
  `MIMOCODE_CHANNEL`/`MIMOCODE_COMMIT_SHA`, because `script/meta.ts` shells out to git and
  enforces `^<pin>`.
