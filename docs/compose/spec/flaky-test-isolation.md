---
feature: flaky-test-isolation
status: delivered
updated: 2026-07-27
branch: fix/flaky-test-isolation
commits: 028f3178..f4daa79e
---

# Flaky Test Isolation

## Report

**What was built** — Three suites that failed off-CI for environment reasons now assert the behavior
they claim to. `assertSafeUrl` takes the DNS resolver as an optional parameter, so the fail-closed and
rebinding assertions run against a stub instead of whichever resolver the developer's network hands
them; the rebinding branch gained its first test. `checkpoint-rebuild-unify` wipes
`ActorRegistryTable` before each test, because `renderRebuildContext` reads the process-wide
`ActorRegistry.listActive()` and earlier test files leave background actors behind in the singleton
SQLite client.

The workflow cancel-cascade test no longer times out. Its assertions always passed in ~280ms; the
budget was consumed by an unbounded teardown. Reclaiming the run's children notifies the parent
session's `main` inbox, which re-arms the parent's `main` runner against the auto-answering test LLM,
and `SessionRunState`'s instance-state finalizer then awaits `Runner.cancel` from inside an
uninterruptible finalizer, where no timeout can fire. The test drains that runner itself, bounded, on
the interruptible side of scope close. The same drain let the previously-skipped orphan-on-cancel
regression test come back, restoring the only coverage of that bug; its recorded skip rationale
blamed a slow `cancel`, which measurement disproved.

**Verification** — `bun test test/util/ssrf.test.ts` passed 23 tests.
`bun test test/actor test/session/checkpoint-rebuild-unify.test.ts` passed 130 tests / 2 skip, having
reproduced the failure on the same command before the fix.
`bun test test/workflow/runtime.test.ts` passed three consecutive times (28 pass, 1 skip) and again
after the review follow-up. `bun test` (full suite) passed three times: 4360 pass / 0 fail twice
before the unskip and 4361 pass / 37 skip / 0 fail after, 4399 tests across 418 files.
`bun typecheck` passed. oxlint on the four changed files reported 49 warnings / 0 errors against 48 /
0 on `main`; the single added warning is another instance of the `await-thenable` false positive that
already fires 20 times in that file.

**Journey log**

- The first fix attempt for the cancel test — swapping `llm.hang` for `hangUntil` + release, the
  idiom `runtime-worktree.test.ts` uses — made it strictly worse: releasing the hang lets the child
  resume, so it was still Running at teardown and the isolated run started hanging too. The
  established idiom in a sibling file was the wrong tool here.
- Measuring before theorising was what cracked it. Probes showed the assertions finishing in 280ms,
  raising the budget to 180s still timing out (so: deadlock, not slowness), and
  `process._getActiveHandles()` empty (so: an Effect fiber, not a socket).
- Naming the stuck disposer needed the stack captured at the `InstanceState.make` call site, outside
  the returned `Effect.gen` — inside it, every frame is Effect runtime internals. A first attempt
  filtered stack lines on `/src/`, which matches every path under `~/src`, and silently kept nothing.
- Effect finalizers run uninterruptibly, so an `Effect.timeout` placed inside one never fires. That
  is why the deadlock presented as infinite rather than as a bounded 6s stall.
- Bisecting showed *any* predecessor test triggered the hang, which ruled out a specific
  interaction and pointed at process-global state instead.

## [S1] Problem

Three suites in `packages/opencode` fail off-CI for reasons unrelated to the behavior they claim to
cover. Each failure is an environment or harness artifact, not a product defect, so each one trains
readers to ignore red output.

1. `test/util/ssrf.test.ts` asserts that `assertSafeUrl` rejects an unresolvable hostname by asking
   the real resolver for a `.invalid` name. Resolvers that answer for `.invalid` (ISP or corporate
   DNS, mDNS) make the call succeed, so the assertion depends on which network the developer sits on.
2. `test/session/checkpoint-rebuild-unify.test.ts` asserts that `insertRebuildBoundary` returns
   `false` when there is nothing to push. `renderRebuildContext` reads
   `ActorRegistry.listActive()`, which is process-wide, and the SQLite client is a process-level
   singleton, so background actors left `pending`/`running` by an earlier test file make the context
   non-empty. It passes alone and fails in a whole-suite run.
3. `test/workflow/runtime.test.ts` "cancel stops in-flight child agents and marks the run cancelled"
   exhausts its 30s budget. The assertions complete in ~280ms; the remaining time is a teardown
   deadlock, and it is not a slow path but an unbounded one — raising the budget to 180s still times
   out.

## [S2] Design

**SSRF resolver injection.** `assertSafeUrl` takes the resolver as an optional second parameter
defaulting to `dns/promises.lookup`, mirroring the `fetchImpl` parameter `safeFetch` already exposes
for the same reason. The DNS-dependent assertions inject a stub, so they pin the behavior that
matters — resolution failure means reject, and a hostname resolving into a blocked range means
reject — without consulting a real resolver. Production callers are unchanged.

**Rebuild-context actor leakage.** `listActive()` stays process-wide: peer actors legitimately live
in child sessions, so scoping the query to one `session_id` would drop live children from the "Active
actors" section. The test instead wipes `ActorRegistryTable` in `beforeEach`, the same isolation
`test/session/checkpoint-rebuild-v3.test.ts` already applies for the same reason, and consistent with
how that test already neutralizes the other inputs (deleting the memory dirs, capping `recent_user`
to 0).

**Cancel-cascade teardown deadlock.** Reclaiming the workflow's children makes each one notify the
parent session's `main` inbox, which re-arms the parent's `main` runner against the auto-answering
test LLM. `SessionRunState`'s instance-state finalizer cancels every runner still in its map, and
`Runner.cancel` awaits `Deferred.await(run.done)`. Effect finalizers run uninterruptibly, so that
await cannot be bounded from inside and the instance disposer never returns. The test drains the
runner map itself — `SessionRunState.cancel(parent.id)`, bounded and ignored — after its assertions
and before the fixture scope closes, where the cancel is still interruptible and the bound applies.

Out of the three, only the SSRF change touches `src/`, and it is additive.

**Restored orphan-on-cancel coverage.** The sibling test in the same describe, "cancel during an
in-flight fan-out reclaims every child (no orphan)", was skipped under the same symptom with the
diagnosis "`cancel` itself does not return before the test deadline". That diagnosis is wrong —
`cancel` returns in ~300ms — and the real cause is the teardown deadlock above. With the same drain
applied it is unskipped, restoring the only coverage of the MR104 orphan-on-cancel regression.

## [S3] Out of Scope

- Bounding `Instance.dispose()` so a stuck instance-state finalizer cannot wedge teardown.
  `Instance.disposeDirectory` already bounds its path with `DIRECTORY_DISPOSE_TIMEOUT`; the direct
  `dispose()` path does not. That is a real robustness gap, reachable in production whenever an
  instance is disposed while a session run is live, but changing teardown semantics is a separate
  change with its own risk surface.
- Session-scoping the "Active actors" rebuild section.
- The other `llm.hang` call sites in `test/workflow/runtime.test.ts`. They pass today; converting
  them is unverified churn.

## Tasks

- [x] T1: Inject the resolver into `assertSafeUrl` and rewrite the DNS assertions against a stub —
      acceptance: `bun test test/util/ssrf.test.ts` passes with no network dependency (covers: S2)
- [x] T2: Wipe leaked `ActorRegistryTable` rows in `checkpoint-rebuild-unify` — acceptance:
      `bun test test/actor test/session/checkpoint-rebuild-unify.test.ts` passes, having failed
      before (covers: S2)
- [x] T3: Quiesce the parent session before teardown in the cancel-cascade test — acceptance:
      `bun test test/workflow/runtime.test.ts` passes with zero failures (covers: S2)
- [x] T4: Confirm no further local-only failures across two full runs — acceptance: the union of two
      `bun test` runs adds no failure attributable to this branch (covers: S1)
- [x] T5: Unskip the orphan-on-cancel test with the same drain — acceptance:
      `bun test test/workflow/runtime.test.ts` green three consecutive times and a full run stays
      green (covers: S2; depends: T3)
