---
feature: memory-test-isolation
status: delivered
updated: 2026-11-17
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2826
---

# Memory test isolation

## Report

**What was built** — `test/fixture/memory.ts` exports `resetMemory()`. It removes `<Global.Path.data>/memory` and clears `memory_fts` in the same call. The five memory suites call it in `beforeEach`. Their `afterEach` runs `Instance.disposeAll()` and then `resetMemory()`, so later files also start clean. The redundant per-test `fs.rm(root)` calls are gone. `packages/cli/test/AGENTS.md` gains a "Process-Global State" section. No production code changed.

**Verification** (from `packages/cli`)
- Scratch polluter followed by the old `reconcile.test.ts`: FAIL with `pruned: 1`. This reproduces CI's `pruned: 21` and `pruned: 27`. With the fix: PASS, 6/6.
- `bun test test/memory test/tool/memory.test.ts`: PASS, 117/0.
- The local CI shard 3/4 file list (144 files): PASS, 1426/0.
- `bun run typecheck` (tsgo): PASS. `oxlint` on the touched files: 0 warnings.
- Independent review: no critical findings. The two minor findings were addressed: a shorter repeated comment, and AGENTS.md wording about `afterEach`.

## [S1] Problem

`Memory.reconcile > indexes native memory layouts, searches them and reconciles updates/deletes [TP-R6-06]` fails on `main` (`pruned: 21`, run 43877202670) and on the Bun 1.4.4 survey branch #2821 (`pruned: 27`, runs 43898387694 and 43906880066). The failure is not specific to a runtime. It depends on the order of test files.

`bun test` runs every file in one process without isolation. Two pieces of memory state are global to that process:

- the memory root `<Global.Path.data>/memory`, which is fixed when `test/preload.ts` sets the XDG directories;
- the `memory_fts` table in the shared `:memory:` database.

Session and checkpoint tests write `memory/sessions/<sid>/…` files and do not remove them. A local run of shard 3 ended with 32 such files. A later reconcile indexes them into `memory_fts`. That reconcile may be the detached boot reconcile in `InstanceBootstrap` or the lazy reconcile in `Memory.search`. Every memory test file clears `memory_fts` only in `afterEach`, and each test resets only the disk half with `fs.rm(root)`. When `reconcile.test.ts` happens to be the first memory file after such files, its first test deletes the files but keeps their rows. The first `reconcile()` then reports those rows as `pruned`. The count is stable for a given shard composition, so the failure comes and goes whenever the shard split changes.

Deterministic reproduction: run a scratch file that writes `memory/sessions/ses_polluter/checkpoint.md` and calls `reconcileMemory`, in the same `bun test` invocation as `test/memory/reconcile.test.ts`. Result: `pruned: 1`.

## [S2] Design

### S2.1 Tests own their precondition

A test that asserts on state shared across the process must set that state up in `beforeEach`. It must not rely on other files cleaning up in `afterEach`, because Bun gives no ordering or isolation guarantee between files.

### S2.2 `resetMemory()` fixture

`test/fixture/memory.ts` exports `resetMemory(): Promise<void>`. It removes `<Global.Path.data>/memory` recursively and deletes every row of `memory_fts`. Both halves are reset together, so the disk and the index start out consistent and empty.

The memory test files that assert on reconcile, search or row counts call it in `beforeEach`:
- `test/memory/reconcile.test.ts`
- `test/memory/service.test.ts`
- `test/memory/cc-search.test.ts`
- `test/memory/cc-reconcile.test.ts`
- `test/tool/memory.test.ts`

Their existing `afterEach` keeps `Instance.disposeAll()`, and its FTS clear becomes `resetMemory()` so later files also start clean. The per-test `fs.rm(root)` lines that only reset the memory root are removed as redundant.

### S2.3 Written convention

`packages/cli/test/AGENTS.md` gets a short "Process-global state" section. It states the S2.1 rule and names the known shared state: the memory root and FTS, other tables in the in-memory DB, and `Global.Path.*`.

## [S3] Out of Scope

- Making session/checkpoint tests clean up the memory files they leave behind.
- Removing the `mock.module` and other isolated steps from CI, and adopting `--isolate`.
- Timing flakes seen on `main`: `SessionCheckpoint.drainWriters`, invalid-output continuation, and the inbox restart `stop interrupts pending delivery`.
- Product changes to memory root resolution.

## Tasks
- [x] T1: Add `resetMemory()` and use it in `beforeEach`/`afterEach` of the five memory test files — acceptance: the scratch polluter reproduction from S1 passes with the 5 files; all 5 files pass (covers: S2.1, S2.2)
- [x] T2: Document the convention in `packages/cli/test/AGENTS.md` (covers: S2.3)

## Journey log
- A probe that ran each preceding file alone with a check file afterwards found no pollution. Bun does not run files in argument order; it orders them by directory and the order differs between macOS and Linux CI. The deterministic repro therefore uses a scratch file in the same directory, and the order Bun actually used is confirmed from its output.
