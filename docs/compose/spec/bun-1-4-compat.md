---
feature: bun-1-4-compat
status: in-progress
updated: 2026-11-16
source: chore/bun-1-4-compat-survey
---

# Bun 1.4.4 compatibility survey

## Report

This branch moves the root `packageManager` pin from `bun@1.3.14` to `bun@1.4.4` as an
experiment, then compares install, typecheck, tests, the single-binary build and runtime smoke
checks against 1.3.14. No product code is changed. Every temporary instrumentation patch
described below was reverted before commit.

| #  | Area | Symptom | 1.3.14 | 1.4.4 | Root cause | Severity |
| -- | ---- | ------- | ------ | ----- | ---------- | -------- |
| F1 | TUI startup (Worker messaging) | Interactive TUI never draws. The process stays alive at 0% CPU with an empty worker log. Ctrl+C exits. | Draws in 5/5 starts, about 2–3 s | Hangs in 5/5 starts (compiled binary) and 5/5 (from source) | Bun 1.4.4 drops a `postMessage` sent to a Worker before the worker's global `onmessage` exists. On 1.3.14 it is queued. `thread.ts` posts `server` about 40 ms after `new Worker`, but the worker module body only starts about 500 ms later, after its import graph evaluates. | **Critical** (issue #2782) |
| F2 | `Bun.stringWidth` | `test/cli/tui/collapse.test.ts` › "keeps one cluster even when it is wider than the whole budget" fails deterministically | `stringWidth("\u1100\u1161\u11A8") === 4` | `=== 2` | Runtime changed grapheme-width rules for conjoining Hangul jamo; 1.4.4 now matches the precomposed syllable `한` (2) | Low (test pins old runtime behaviour; TUI clipping for decomposed jamo changes by 2 cells) |
| F3 | Install (`bun ci`) | `warn: patches/@npmcli%2Fagent@4.0.0.patch no longer applies (@npmcli/agent is now 4.0.2)` | Silent, patch **not** applied | Warns, patch **not** applied | Pre-existing: `patchedDependencies` keys `@npmcli/agent@4.0.0` but the lockfile resolves 4.0.2. 1.4.4 only makes it visible. | Low (pre-existing) |
| F4 | Full `bun test` run | 75–77 failures per full run, with different sets on each run | 77 fail, 4 errors | 75 fail, 3 errors | Pre-existing cross-file contamination (`mock.module` leaking between files in one `bun test` process, leaked MCP SDK cancel timers raising `this._transport?.send is not a function` between tests) plus load sensitivity. Not runtime-specific. | Medium (pre-existing; hides real regressions such as F2) |
| F5 | Compiled binary size | `dist/mimocode-darwin-arm64/bin/mimo` | 101,357,666 B | 128,227,298 B (+27%) | Larger Bun 1.4.4 runtime embedded by `bun build --compile` | Info |

Everything else matched across runtimes: `bun ci` (same 1063 packages in the `node_modules/.bun`
store, lockfile untouched), `bun run typecheck` (passes), build (`exit 0`, built-in smoke
passes), `--version`, `models`, headless `run` (reaches the provider, which returns 401), and
`serve --port 0` (HTTP 200 on all four endpoints probed).

A temporary main-side "worker ready" handshake (reverted) made the 1.4.4 TUI draw in 5/5 starts.
The privacy dialog, `ctrl+p`, prompt submit and clean exit (`EXIT=0`, about 1 s) all worked.
No second TUI blocker surfaced behind F1.

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

### F3 — `@npmcli/agent` patch is not applied (pre-existing, newly visible)

`package.json` `patchedDependencies` lists `@npmcli/agent@4.0.0`, but `bun.lock` resolves
`@npmcli/agent@4.0.2`. On both runtimes, the installed
`node_modules/.bun/@npmcli+agent@4.0.2/.../lib/agents.js:35` still reads
`{ url: this.#proxy }` (unpatched). Only 1.4.4 prints the warning. Install is otherwise identical
(exit 0, same store entry count, `bun.lock` unchanged).

### F4 — Full-suite test noise (pre-existing, both runtimes)

| Run | pass | skip | todo | fail | errors | tests | wall |
| --- | ---- | ---- | ---- | ---- | ------ | ----- | ---- |
| full, 1.4.4 | 6219 | 41 | 1 | 75 | 3 | 6336 / 589 files | 1303 s (another agent's 1.3.14 test process shared the CPU for part of the run) |
| full, 1.3.14 | 6216 | 41 | 1 | 77 | 4 | 6335 / 589 files | 1972 s |
| 26 files that failed on 1.4.4, 1.3.14 | 143 | 2 | – | 47 | 1 | 192 | 446 s |
| same 26 files, 1.4.4 | 142 | 2 | – | 48 | 1 | 192 | 406 s |

- 39 failure names are shared between the two full runs. 36 fail only in the 1.4.4 full run, and
  38 only in the 1.3.14 full run (Project/Worktree/actor tests).
- Of the 36 failures seen only on 1.4.4, 35 pass when rerun on 1.4.4 (subset run and two isolated
  reruns of `test/workflow/{sandbox,persistence,manifest-permission,runtime-worktree,tool,model-routing}`,
  `test/session/{checkpoint-splitover-integration,turn-end-lossless}`, `test/plugin/checkpoint-splitover`).
  These are flakes. The remaining one is F2.
- The MCP block (`test/mcp/lifecycle.test.ts` plus `admission-*`, `oauth-*`, `host`,
  `first-turn-wait`, `tool-progress`, `session/tool-*`) fails identically on **both** runtimes when
  run together with other files. `test/mcp/lifecycle.test.ts` alone passes 31/31 on both.
  Cause: `mock.module(...)` (lifecycle.test.ts:126–134) contends with files that loaded the real
  modules first.
- Many of the workflow/sandbox failures in the 1.4.4 full run are unhandled
  `TypeError: this._transport?.send is not a function` from
  `@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:667` (a request-cancel timer left over
  from an earlier MCP test with a mocked transport). The error is attributed to whichever test is
  running when it fires. The same class of "Unhandled error between tests" appears on 1.3.14.

Classification: **1.4.4-only deterministic: 1 (F2). 1.4.4-only flaky: 35. Pre-existing on both:
the rest.** None involve sqlite, fetch/streams, spawn/pty, fs or timer semantics changes.

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

`script/meta.ts` accepts any `^<pin>`. With the upstream pin `1.3.14`, Bun 1.4.4 already
satisfies `^1.3.14`, so Homebrew's pin rewrite is not what lets the build proceed. The resulting
binary is broken because the embedded 1.4.4 runtime triggers F1.

## [S4] Out of Scope

- Fixing F1 in product code. Another agent owns the worker handshake fix in a separate worktree.
  This survey only adds the evidence that a worker-side reorder alone is insufficient.
- Node build (`script/build-node.ts`), Windows/Linux targets, the `packages/sdk` / plugin tests,
  and authenticated end-to-end model turns (no credentials were used).
- An exhaustive Bun-API audit. APIs were checked only where a failure pointed at them (`Worker`,
  `Bun.stringWidth`).
- De-flaking the suite-wide `mock.module` / leaked MCP timer contamination (F4). It is
  pre-existing, and only recorded here because it hides runtime regressions.

## Tasks

- [ ] **T1 — TUI worker handshake survives Bun 1.4.x** (owned elsewhere). Acceptance: with the
  pin at `bun@1.4.4`, a binary from `bun --bun ./script/build.ts --single --skip-install` draws the
  `ctrl+p` status bar in tmux in 10/10 cold starts. 1.3.14 behaviour is unchanged. The first
  `client.call` cannot be sent before the worker signals readiness, or it has a bounded timeout
  with a visible error instead of an infinite hang. A test covers a worker whose import graph is
  slow.
- [ ] **T2 — `collapse.test.ts` stops pinning runtime-specific jamo width.** Acceptance: the test
  asserts the clipping invariant (one cluster kept whole even when wider than the budget) with a
  cluster whose width is the same on 1.3.14 and 1.4.4, or derives the expected width from
  `Bun.stringWidth`. `bun test test/cli/tui/collapse.test.ts` passes on both runtimes.
- [ ] **T3 — `@npmcli/agent` patch key matches the resolved version.** Acceptance: the patch is
  re-keyed to (or regenerated for) `@npmcli/agent@4.0.2`, or removed if no longer needed. `bun ci`
  on 1.4.4 prints no "no longer applies" warning. The installed `lib/agents.js` contains the
  patched `this.#proxy.toString()`.
- [ ] **T4 — Full `bun test` run is order-independent for MCP tests.** Acceptance: the MCP block
  (`test/mcp/*`, `test/session/tool-*`) passes in a full-suite run on both runtimes, and no
  "Unhandled error between tests" from `protocol.js` cancel timers is reported.
- [ ] **T5 — Decide the pin bump.** Acceptance: after T1–T2 land, the pin moves to `bun@1.4.x`
  with CI green, or the decision not to bump (and to state the supported Bun range for packagers
  such as Homebrew) is recorded.

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
