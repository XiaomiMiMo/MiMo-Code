---
feature: log-safety
status: delivered
updated: 2026-07-27
branch: fix/tui-log-stderr
commits: 014a2577..aa28c273
---

# Log Safety

## Report

**What was built** — Logger instances own unique active files and serialize initialization, writes, rotation, and shutdown through one lifecycle queue. Cleanup preserves live files, recovers stale process and worker files, enforces archive count and size budgets, and stops file writes safely when finalization cannot complete. CLI hard exits use `Log.exit()` and normal TUI exits return through the top-level shutdown.

The logger no longer treats stderr as a fallback sink. Records reach stderr only under `--print-logs`; without a usable file sink they are dropped, and sink failures are swallowed rather than reported. The TUI worker flushes before its bounded teardown and closes its log as the last teardown step, so instance disposal and bus unsubscribe records land in the file instead of on the rendered screen.

**Verification** — `MIMOCODE_PROCESS_ROLE=main bun test test/util/log.test.ts` passed 18 tests / 53 expectations, and `MIMOCODE_PROCESS_ROLE=worker bun test test/util/log.test.ts test/effect/app-runtime-logger.test.ts test/effect/runner-warn-log.test.ts` passed 26 tests. `bun typecheck` passed. oxlint on the changed files reported zero warnings and zero errors.

Reproduction, before and after: running the same child-process script against the pre-fix `log.ts` leaked `INFO … teardown after shutdown` to stderr, while the fixed logger emitted nothing. End-to-end, a tmux-driven `bun dev <dir>` quit through the `exit` prompt command on `main` printed nine teardown records to stderr — the exact lines the user reported — with the worker log file ending at `worker shutting down`; on the delivered head stderr stayed empty and the worker log file contained the full teardown sequence through `service=bus type=session.updated unsubscribing`.

**Journey log**

- The first review exposed that a write queue alone is insufficient; lifecycle mutations must use the same queue.
- Capturing a stream before queued rotation can make shutdown close the wrong resource; shutdown now resolves the current stream only when its queued operation runs.
- Bun main and worker contexts share a PID, so stale worker recovery also needs the process role.
- Closing the worker log before its teardown traded one bug for another: the records were durable but were printed over the TUI. Flushing, then closing last, satisfies both; a worker killed mid-drain leaves an `.active.log` that the next initialization recovers.
- Gating the failure report behind print mode made it unreachable — print mode never opens a file — which is why the reporting path was removed instead of gated. Attempting to test a branch is the cheapest way to discover it cannot happen.
- `bun dev` writes its logs under the checkout's `.dev-home` (`MIMOCODE_HOME` in `script/dev.ts`), so redirecting only stderr to a file keeps the TUI on the real terminal while making a leak trivially greppable.

## [S1] Problem

The CLI main context and TUI worker initialize logging independently but can target the same file. Rotation and cleanup can therefore rename, truncate, or delete a file another context still writes. Log writes also discard asynchronous failures and fatal exits do not flush.

## [S2] File Ownership And Retention

Each logger initialization owns a unique active filename containing the timestamp, process role, PID, and a random instance identifier. Active files are distinguishable from completed and rotated files and are never selected by cleanup. Initialization, writes, rotation, and shutdown share one ordered lifecycle queue, so concurrent initialization closes the prior stream before replacing its state.

With rotation enabled, queued records that individually fit within the threshold rotate before an active file would exceed 50 MiB. Archived files are reduced to at most 10 and at most 200 MiB in total, and cleanup errors do not interrupt logging. A failed archive move uses a copy/remove fallback; if finalization still fails, the file sink closes instead of reopening the same oversized file with a reset counter. Explicitly disabling rotation continues to permit one active file to exceed 50 MiB.

## [S3] Failure And Shutdown Behavior

Stream failures are consumed by the logger and must not create unhandled promise rejections, crash on a stream `error` event, or recursively call the logger. They are not reported to any stream: a file failure can only happen while logging to a file, which is exactly when stderr belongs to the rendered TUI screen, so the missing or short log file is the only signal. `flush()` waits for queued writes and leaves the file sink open. `shutdown()` runs after earlier queued rotations, closes the final stream, and marks its file completed. CLI hard exits use `Log.exit()`, and normal TUI exits return through the top-level shutdown.

## [S4] Terminal Isolation

The logger writes to stderr only when the process was initialized with `print` (`--print-logs`), and then only the records themselves. Without a usable file sink — before initialization, after `shutdown()`, or when opening or finalizing the file failed — records are dropped. The TUI renders on the same terminal the process writes stderr to, so a leaked line corrupts the screen; a dropped record is preferable to a corrupted display.

The TUI worker therefore flushes, not closes, before its bounded teardown: queued records must be durable in case the host kills the worker mid-drain, while the teardown that follows (checkpoint drain, instance disposal, server stop) must still log to the file. The worker closes its log as the last teardown step. A worker killed before that leaves an `.active.log` that the next initialization recovers.

## [S5] Testing Boundaries

Tests use real temporary files and streams. They cover unique ownership across repeated and concurrent initialization, same-PID worker recovery, ordered concurrent writes, size rotation, shutdown queued behind a rotation, retention by count and total bytes, active-file preservation, disabled rotation, write failure without unhandled rejection, and flush/shutdown persistence.

Terminal isolation is verified in a child process, because the sink state is module-level: records emitted before initialization and after `shutdown()` produce empty stdout and stderr while earlier records remain in the file, an unusable log directory produces no output at all, and `print` mode still writes records to stderr — without creating a file, and unaffected by an unusable log directory. An isolated dev CLI run verifies that a post-initialization command error exits nonzero with no active log and one completed log.

## [S6] Out Of Scope

This change does not introduce per-record truncation, modify MCP/ACP/voice logging, add time-based retention, compress archives, change session/database retention, or remove the explicit rotation-disable option.

## Tasks

- [x] T1: Implement unique active-file ownership and a serialized lifecycle queue — acceptance: concurrent initialization cannot target, leak, or clean another live active file, and file/count/total limits hold (covers: S2)
- [x] T2: Add failure-safe flush, shutdown, and command exit lifecycle — acceptance: write/finalization failures do not reject globally or resume unsafe file writes, and CLI/TUI/worker exit paths close pending logs before termination (covers: S3; depends: T1)
- [x] T3: Add and run focused tests and package typecheck — acceptance: all S5 cases pass from packages/opencode and typecheck succeeds (covers: S5; depends: T1, T2)
- [x] T4: Confine log records to the file sink unless print mode is active — acceptance: a record emitted after `shutdown()` or before `init()` produces no stderr output, while `--print-logs` still prints (covers: S4)
- [x] T5: Keep the worker's file sink open across teardown — acceptance: a TUI quit writes the worker teardown records (instance disposal, bus unsubscribe) to the log file and nothing to stderr (covers: S4; depends: T4)
