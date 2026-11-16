---
feature: ci-test-speed
status: delivered
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2817
---

# CI test speed and flake removal

## Report

**What was built**
- Three timing-bound tests are skipped: main-wait's 30-second refresh test, the invalid-output subagent hang test, and the cron-bridge `stop … after restart` variant.
- Unit files are now assigned to shards by recorded duration (`script/test-shard.ts` + `test/shard-weights.json`), replacing the `cksum` hash. Each weight is at least 0.05s.
- The isolated suites, which all ran on shard 4/4, are spread across the four shards, and `--reserve` accounts for their time.
- The Effect test harness now waits at most 1s for the process-wide log flush, so a stalled log queue can no longer hang unrelated tests.
- `subagent-resume-negatives`, which leaves the log queue stalled, now runs in its own process on shard 4/4.
- The `models-nonblocking` fetch spy counts only models.dev catalog requests.

**Verification**
- CI run 43831880586, attempts 1 and 2 at ac3f71d3: all 4 shards green both times, job times 276–333s.
- PR CI run 43824220225: all 4 shards green. Unit-step times were 234/287/248/246s, down from 226–398s on main. JUnit totals per shard were 227/280/244/242s. The whole run took 5m39s, against about 7.5–8 min on main. `task/registry.test.ts` took 0.14s per test; in the earlier run it timed out at 120s.
- Linux CI repro (four trigger files + registry.test.ts): 52 pass, 0 fail with the harness bound. Without it, 8 of 9 registry tests timed out.
- Local runs: the three edited suites plus the shard-script tests gave 86 pass, 3 intended skips; the shard-script tests gave 6 pass; the harness- and log-related suites gave 15 pass. `typecheck` PASS, `bun lint` 0 errors.
- Independent review: no critical findings across three rounds.

## [S1] Problem

The `test` workflow's unit job takes 7–8 minutes and is re-run often. In the
last 100 runs:

- Path-hash (`cksum % 4`) sharding is badly unbalanced: summed JUnit test time
  per shard averages about 390s / 250s / 205s / 295s. Shard 1/4 runs close to
  its 8-minute step timeout and once exceeded it (485s, 0 failures).
- Load-sensitive tests fail on busy runners and force re-runs:
  - `invalid-output continuation — integration > a message sent to a subagent
    while its retried attempt hangs supersedes the subagent step`: two 15s
    joins inside a 30s test timeout (2 failures).
  - `cron-bridge.integration > stop interrupts pending delivery and rejects
    stale fires after restart`: a 1s `waitFor` budget (2 failures; 15/15 local
    passes).
  - `checkpoint-progress-reconcile > empty when nothing to reconcile`
    (4 failures) — fixed separately by PR #2816, out of scope here.
- `main-wait > a silent but live execution survives the 30-second refresh
  without being declared dead` sleeps 31s of real time on every run.
- Every process-isolated suite (provider refresh, MCP mock suites, deadline
  worktree, stdio-exit-observe, release script; about 50s) runs on shard 4/4.

## [S2] Design

### S2.1 Skip the timing-bound tests

The three tests above (`invalid-output` subagent hang, `cron-bridge` stop
restart, `main-wait` 30-second refresh) become `test.skip` / `it.live.skip`
with a one-line comment naming why (wall-clock bound / CI-load flake). The
global behavior is not locked by them; neighbouring tests in each file keep
covering the same code paths.

### S2.2 Duration-weighted sharding

`packages/cli/script/test-shard.ts`:

- `bun script/test-shard.ts <index> <total>` reads candidate test files (one
  path per line, relative to `packages/cli`) from stdin and prints the files
  assigned to shard `<index>` (1-based).
- Weights come from `packages/cli/test/shard-weights.json` (`{ path: seconds }`).
  A file absent from the map weighs 1s; every weight is floored at 0.05s to
  stand in for per-file load cost that JUnit case times omit.
- Assignment is greedy LPT: files sorted by weight descending, then path
  ascending; each goes to the lightest shard, lowest index on ties. Output is
  deterministic for a given input set and weight map, and every input file is
  assigned to exactly one shard.
- `bun script/test-shard.ts --update <junit.xml>...` rewrites the weights file
  from JUnit reports (per-file summed `time`, averaged across reports in which
  the file appears, rounded to 0.1s).

- `--reserve s1,s2,...` (after `<index> <total>`) seeds each shard's load with
  seconds it already spends outside the shared run. A malformed list, a negative
  value, or more entries than shards exits non-zero.

The workflow keeps its `find` exclusions and empty-shard guard, replacing only
the cksum loop with the script.

### S2.3 Spread the isolated suites

Each isolated step stays a separate process run, pinned to one shard:
MCP mock suites → 1/4 (≈21s); provider refresh + deadline worktree → 2/4
(≈13s); stdio-exit-observe + release script → 3/4 (≈16s);
subagent-resume-negatives → 4/4 (≈14s, see S2.5). The shared run passes
`--reserve 21,13,16,14` so the per-shard job totals stay balanced.

### S2.4 Bounded log flush in the Effect test harness

`test/lib/effect.ts` flushed the process-wide log queue after every
`testEffect` test, waiting without limit. On Linux CI, work left behind by
earlier files in the same process (reproduced with subagent-resume-negatives +
cron/end-to-end + installation + json-migration) stalls that queue for 10s to
over 120s, so trivial suites such as `test/task/registry.test.ts` (sub-10ms of
real work per test) timed out. The harness now waits at most 1s for the flush;
tests that assert on log contents already call `Log.flush()` themselves.

### S2.5 Run subagent-resume-negatives in its own process

On Linux CI, `test/actor/subagent-resume-negatives.test.ts`, run in one process
with cron/end-to-end, installation and json-migration, stalls the
process-wide log queue for the rest of the run. Unrelated suites later in that
process then hang: `task/registry` and `mcp/admission-completion-boundaries`
timed out at 120s. Running only the test cases of each file (`-t`) showed that
its first two cases are enough to cause the stall when combined with the other
three files; without them, `Log.flush()` takes 0ms. The file is excluded from
the shared run and runs as an isolated step on shard 4/4, following the
existing pattern for suites that leave process-wide state behind.

## [S3] Out of Scope

- Fixing the root causes of the skipped tests.
- `bun test --parallel` / changing shard count or the isolated steps.
- The checkpoint-progress-reconcile flake (PR #2816).
- The root cause of the stalled process-wide log queue (S2.4); the harness bound
  only stops it from hanging unrelated tests.

## Tasks
- [x] T1: skip the three timing-bound tests — acceptance: each file runs locally with the test reported as skipped and the rest passing (covers: S2.1)
- [x] T2: add `test-shard.ts` + weights + unit test — acceptance: tests show deterministic, complete, balanced assignment and unknown-file default (covers: S2.2)
- [x] T3: wire the workflow to the script — acceptance: simulated 4-shard split of the current file list covers every file once with max shard ≤ 300 weighted seconds (depends: T2)
- [x] T4: spread isolated steps with `--reserve` — acceptance: no shard holds all isolated steps; simulated totals including reserve differ by ≤ 5s (covers: S2.3, depends: T3)
- [x] T5: bound the harness log flush — acceptance: on Linux CI the 4-file polluter set + registry.test.ts passes (was 8/9 timeouts) (covers: S2.4)
- [x] T6: isolate subagent-resume-negatives — acceptance: two consecutive full CI attempts green on all shards (covers: S2.5)

## Journey log
- `runtime-worktree.test.ts` is excluded from the shared run and only its
  `deadline-fired` case runs in isolation, so its other 7 cases (≈20s, all pass
  locally) never run in CI. Left as-is here; restoring them is a coverage
  decision, not a speed one.
- The first PR CI run timed out on shard 4/4 in `task/registry.test.ts`,
  because the new split put it in a process with different neighbours. On
  Linux CI, leave-one-out narrowed the trigger to four files; every pairwise
  combination passed, and the hang did not reproduce on macOS. Phase
  instrumentation put the whole time in `Log.flush()` inside the testEffect
  harness, while fs calls and `Instance.provide` were fast. Removing
  `Instance.disposeAll()` from the test did not help. Which queued log operation
  stalls is still unknown: the log file stayed empty, so it is not write
  volume. Follow-up: find it, since `Log.shutdown()` in production waits on the
  same queue.
- Another order-dependent flake showed up: `models-nonblocking > refresh(true)
  is a no-op when MIMOCODE_MODELS_PATH is pinned` replaced the process-wide
  `globalThis.fetch` and failed on any fetch made in the process during the
  test, including fetches from work earlier files left running. No test
  changes the pin, so the catalog itself cannot fetch here. The spy now counts
  only `/api.json` requests and passes other fetches through. A mutation that
  removed the pin guard still makes the test fail.
- A third hang (`mcp/admission-completion-boundaries`, 120s) showed that
  bounding the flush hid only one symptom. Running only the test cases of each
  file on CI narrowed the trigger to subagent-resume-negatives cases 1–2,
  combined with the other three files; each case run alone with a probe is
  fine. Tried `bun test --isolate` and `--parallel=2|4` (Bun 1.3.14) on all 4
  shards: every job hit the 8-minute timeout (`--isolate` finished only about
  530 tests), so per-file isolation is not usable today. Issue #2815 / PR #2816
  (checkpoint-progress-reconcile shares a session folder when `Date.now()`
  repeats) is a separate, test-file-only fix and is left to merge on its own.
