---
feature: tui-worker-startup-handshake
status: delivered
updated: 2026-11-16
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2820
---

# TUI worker startup handshake

## Report

**What was built**
- `Rpc.listen` posts `rpc.ready` once its listener is installed, and `Rpc.client` queues requests until it receives `rpc.ready`. Delivery to the TUI worker therefore no longer depends on how the runtime treats messages that arrive before the listener exists.
- Method failures, unknown methods and failed posts reject the call instead of hanging it.
- A worker `close` rejects every pending and later call.
- `thread.ts` disposes the client before terminating the worker, so a deliberate shutdown leaves no stray rejections.

**Verification**
- `bun test test/util/rpc.test.ts`: 8 pass / 0 fail on both Bun 1.3.14 and Bun 1.4.4. Before the fix: on 1.4.4 the first call timed out (the #2782 stall); the hold-until-ready test failed on both runtimes; a throwing method crashed the 1.3.14 test process (exit 133) and hung on 1.4.4.
- `bun run typecheck` (packages/cli): pass.
- `bun test test/util test/cli` (1.3.14): 763 pass / 0 fail.
- Real TUI from source on Bun 1.4.4 (tmux, up to 45s for the status bar):
  - Base commit: drew 0/5; the process stayed alive.
  - This branch: drew 5/5, then 3/3 more after the review fixes. Quitting with Ctrl+C exited 0 with an empty stderr.
- Homebrew-style single binaries (root pin rewritten to `bun@1.4.4`, `build.ts --single --skip-install`):
  - Base commit: drew 2/5.
  - This branch: drew 5/5, then 15/15.
- Real TUI from source on Bun 1.3.14 with this branch: drew 3/3.

## [S1] Problem

`mimo` (the TUI command) starts its backend in a Bun `Worker` and talks to it through
`packages/cli/src/util/rpc.ts`. Right after `new Worker(...)`, the thread calls
`client.call("server")`. The worker module only assigns `onmessage` (via
`Rpc.listen`) at its end, after a top-level `await Log.init(...)`.

Bun 1.3.14 (the pinned runtime) queues messages that reach a worker before its
listener is set. Bun 1.4.x drops a message if the listener is assigned only after
a top-level `await`, whether that `await` is in the worker module or in a module it
imports. The request is lost and `rpc.ts` waits for a reply forever, so the
terminal stays blank with the process idle (issue #2782). Homebrew's `mimo-code`
formula builds from source with Bun 1.4.x, so its users hit this.

The RPC layer also has no failure path. A method that throws produces only an
unhandled rejection inside the worker, and a worker that dies leaves every pending
call unsettled. Callers' `.catch` handlers (for example the loopback-listener bind
in `thread.ts`) can therefore never run.

## [S2] Design

### S2.1 Ready handshake
- After `Rpc.listen(rpc)` assigns its message handler, the worker posts
  `{ type: "rpc.ready" }`.
- `Rpc.client(target)` holds outgoing requests in a queue until it receives
  `rpc.ready`, then sends them in call order. Calls made after that are sent
  immediately.
- Messages from the worker to the thread are already safe on every runtime: the
  thread assigns `target.onmessage` synchronously, in the same tick as
  `new Worker`. Events (`rpc.event`) the worker emits before `rpc.ready` are still
  delivered.
- The handshake makes delivery independent of when, and after how many awaits, the
  worker installs its listener.

### S2.2 Error propagation
- In `listen`, if a method throws or rejects, the worker replies
  `{ type: "rpc.result", id, error: <message> }`. `call` then rejects with an
  `Error` carrying that message.
- Requests for an unknown method also reply with an error and do not crash the
  worker.

### S2.3 Worker termination
- When the target emits `close`, the client rejects every pending and queued call.
  Every later call rejects immediately with an error that says the worker has
  stopped. Callers that already `.catch` (such as the loopback bind or
  `checkUpgrade`) degrade instead of hanging.
- Only `close` counts as termination. On both Bun 1.3.14 and 1.4.4, an uncaught
  error in a worker fires `error` and is always followed by `close`, so treating
  `error` alone as death would add nothing and could misfire.
- The client subscribes with `addEventListener`, so it does not take over
  `worker.onerror`, which `thread.ts` uses for logging.

### S2.4 Wire compatibility
- The thread and the worker always ship together in one binary or source tree. No
  mixed-version peers exist, so no backward-compatibility shim is needed.

## [S3] Out of Scope
- Other Bun 1.4.x incompatibilities. These are tracked by the separate survey
  `docs/compose/spec/bun-1-4-compat.md` on branch `chore/bun-1-4-compat-survey`.
- A wall-clock timeout on worker startup. A slow but healthy worker must not be
  killed. The failure modes found so far (a lost message, a throwing method, a dead
  worker) are covered by S2.1–S2.3.
- Changing the Homebrew formula or the pinned Bun version.

## Tasks
- [x] T1: Ready handshake in `rpc.ts` and worker — acceptance: a real Bun Worker that awaits before `Rpc.listen` answers a call made immediately after construction, under both Bun 1.3.14 and 1.4.4; the client posts no request before `rpc.ready` (covers: S2.1)
- [x] T2: Error replies — acceptance: a call to a throwing method or an unknown method rejects with the error message instead of hanging (covers: S2.2)
- [x] T3: Termination handling — acceptance: when the worker exits or errors, pending calls reject and later calls reject immediately (covers: S2.3)
- [x] T4: Bun 1.4.4 end-to-end evidence — acceptance: with the root pin switched to `bun@1.4.4` in a scratch checkout, the TUI started from source and from a `build.ts --single` binary draws its status bar in repeated starts with this change and stalls without it (depends: T1)

## Journey log
- Bun 1.4.4 delivers a message only if the worker assigns `onmessage` synchronously during module evaluation; after any top-level `await` in the worker or in a module it imports, the message is dropped. Do not rely on listener timing; use the handshake.
- My first attempt to run the real TUI under 1.4.4 passed a directory path instead of the binary, so the run never actually launched and the "exits on its own" result was wrong. Use `.../bun/1.4.4/bun/bin/bun.native`.
