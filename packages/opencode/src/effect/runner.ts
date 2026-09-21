import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never, B = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly ensureRunning: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  /** [R003] Start work only if idle; busy → fail B. Never join an existing run. */
  readonly ensureExclusive: (work: Effect.Effect<A, E>) => Effect.Effect<A, E | B>
  readonly start: (work: Effect.Effect<A, E>) => Effect.Effect<void, B>
  /**
   * [C001] Start work and return a cancel bound to THIS run id only —
   * a later replacement run is never interrupted.
   */
  readonly startOwned: (
    work: Effect.Effect<A, E>,
  ) => Effect.Effect<{ readonly runId: number; readonly interruptOwned: Effect.Effect<void> }, B>
  readonly startShell: (work: Effect.Effect<A, E>) => Effect.Effect<A, E | B>
  readonly cancel: Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
  /**
   * (Removed) pending-attach dual owner. TurnQueue Controller is the sole
   * admission/mailbox owner; ensureRunning serializes behind a live run and
   * the Controller kicks remaining accepted receipts on idle.
   */
}

interface ShellHandle<A, E> {
  id: number
  fiber: Fiber.Fiber<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  /**
   * Cancel in progress: fiber interrupt (and its ensuring/finalizers) has not
   * finished. Stays non-Idle so a new start/ensureRunning cannot begin until
   * the retiring execution's finalizers complete (RL-ORPHAN-D01 handoff).
   */
  | { readonly _tag: "Cancelling"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }

export const make = <A, E = never, B = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
    busy?: () => B
    label?: string
    onReentryWarn?: (info: { label: string; existingRunId: number }) => Effect.Effect<void>
    onRunStart?: Effect.Effect<() => void>
    onShellStart?: Effect.Effect<() => void>
  },
): Runner<A, E, B> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = opts?.onIdle ?? Effect.void
  const busy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const idleIfCurrent = () =>
    SynchronizedRef.modify(ref, (st) => [st._tag === "Idle" ? idle : Effect.void, st] as const).pipe(Effect.flatten)

  // Explicit return types break the finishRun ↔ startRun circular inference.
  const startRun = (
    work: Effect.Effect<A, E>,
    done: Deferred.Deferred<A, E | Cancelled>,
  ): Effect.Effect<RunHandle<A, E>> =>
    Effect.gen(function* () {
      const id = next()
      const release = opts?.onRunStart ? yield* opts.onRunStart : () => {}
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(id, done, exit)),
        Effect.forkIn(scope),
      )
      // If this fiber is interrupted before `work` ever starts, onExit/ensuring
      // on the effect do not run — settle `done` from the fiber exit so waiters
      // (ensureExclusive / admission) cannot hang.
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap((exit) => complete(done, exit)),
        Effect.ensuring(Effect.sync(release)),
        Effect.forkIn(scope),
      )
      return { id, done, fiber } satisfies RunHandle<A, E>
    })

  const finishRun = (
    id: number,
    done: Deferred.Deferred<A, E | Cancelled>,
    exit: Exit.Exit<A, E>,
  ): Effect.Effect<void> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Cancelling" && st.run.id === id) {
          // Cancel's own fiber may have been interrupted before it could flip
          // to Idle. The retiring work exiting is the reliable convergence
          // point (RL-ORPHAN-C02).
          return [
            Effect.gen(function* () {
              yield* idle
              yield* complete(done, exit)
            }),
            { _tag: "Idle" } as const,
          ] as const
        }
        if (st._tag !== "Running" || st.run.id !== id) return [complete(done, exit), st] as const
        // No pending-attach: remaining work is owned by TurnQueue receipts;
        // onIdle kicks the Controller scheduler for leftover accepted work.
        return [
          Effect.gen(function* () {
            yield* idle
            yield* complete(done, exit)
          }),
          { _tag: "Idle" } as const,
        ] as const
      }),
    ).pipe(Effect.flatten)

  const busyFailure = <C>(): Effect.Effect<C, B> =>
    opts?.busy ? Effect.fail(opts.busy()) : Effect.die(new Error("Runner is busy"))

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) return [idle, { _tag: "Idle" }] as const
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) => Fiber.interrupt(shell.fiber)

  const ensureRunning = (work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        switch (st._tag) {
          case "Running": {
            // Fiber already exited but state is still Running — finishRun/onIdle
            // lost the race or never ran (abnormal finish left a stale busy
            // ledger). Reclaim and start the new work so a sent prompt always
            // gets a loop; do not await a dead Deferred forever.
            const exit = st.run.fiber.pollUnsafe()
            if (exit !== undefined) {
              yield* Deferred.isDone(st.run.done).pipe(
                Effect.flatMap((done) => (done ? Effect.void : Deferred.done(st.run.done, exit))),
              )
              const done = yield* Deferred.make<A, E | Cancelled>()
              const run = yield* startRun(work, done)
              return [Deferred.await(done), { _tag: "Running", run }] as const
            }
            if (opts?.onReentryWarn)
              yield* opts.onReentryWarn({ label: opts.label ?? "(unlabeled)", existingRunId: st.run.id })
            // Live fiber: NO pending-attach (C-01). Serialize — wait for the
            // current run, then start this work as a new exclusive run. The
            // Controller mailbox owns multi-work admission; one pending slot
            // was a second consumer and is gone.
            const fiber = st.run.fiber
            return [
              Fiber.await(fiber).pipe(
                Effect.ignore,
                Effect.andThen(Effect.suspend(() => ensureRunning(work))),
              ),
              st,
            ] as const
          }
          case "Shell": {
            const shellFiber = st.shell.fiber
            return [
              Fiber.await(shellFiber).pipe(
                Effect.ignore,
                Effect.andThen(Effect.suspend(() => ensureRunning(work))),
              ),
              st,
            ] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [Deferred.await(done), { _tag: "Running", run }] as const
          }
          case "Cancelling": {
            // Wait for the retiring fiber (and its finalizers) to finish, then
            // retry — new work must not start mid-finalizer (RL-ORPHAN-D01).
            const fiber = st.run.fiber
            return [
              Fiber.await(fiber).pipe(
                Effect.ignore,
                Effect.andThen(Effect.suspend(() => ensureRunning(work))),
              ),
              st,
            ] as const
          }
        }
      }),
    ).pipe(
      Effect.flatten,
      Effect.catch(
        (e): Effect.Effect<A, E> => (e instanceof Cancelled ? (onInterrupt ?? Effect.die(e)) : Effect.fail(e as E)),
      ),
    )

  const startShell = (work: Effect.Effect<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [busyFailure<A>(), st] as readonly [Effect.Effect<A, E | B>, State<A, E>]
        }
        yield* busy
        const release = opts?.onShellStart ? yield* opts.onShellStart : () => {}
        const id = next()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.ensuring(Effect.sync(release)), Effect.forkChild)
        const shell = { id, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (Cause.hasInterruptsOnly(exit.cause) && onInterrupt) return yield* onInterrupt
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as readonly [Effect.Effect<A, E | B>, State<A, E>]
      }),
    ).pipe(Effect.flatten)

  const ensureExclusive = (work: Effect.Effect<A, E>): Effect.Effect<A, E | B> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [busyFailure<A>(), st] as readonly [Effect.Effect<A, E | B>, State<A, E>]
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        return [
          Deferred.await(done) as Effect.Effect<A, E | B>,
          { _tag: "Running", run } as State<A, E>,
        ] as const
      }),
    ).pipe(
      Effect.flatten,
      Effect.catch(
        (e): Effect.Effect<A, E | B> => (e instanceof Cancelled ? (onInterrupt ?? Effect.die(e)) : Effect.fail(e as E | B)),
      ),
    )

  const start = (work: Effect.Effect<A, E>): Effect.Effect<void, B> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [busyFailure<void>(), st] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        return [Effect.void, { _tag: "Running", run } as const] as const
      }),
    ).pipe(Effect.flatten)

  /**
   * [C001] Cancel only the run with this id, reusing the Cancelling lifecycle:
   * stay non-Idle until finalizers finish; settle pending waiters like `cancel`.
   */
  const interruptOwned = (runId: number) =>
    SynchronizedRef.modify(ref, (st) => {
      if (st._tag === "Running" && st.run.id === runId) {
        return [
          Effect.gen(function* () {
            // Interrupt WAITS for the fiber, including ensuring/finalizers.
            // State stays Cancelling until finishRun (RL-ORPHAN-D01).
            yield* Fiber.interrupt(st.run.fiber)
            yield* SynchronizedRef.modify(ref, (s) => {
              if (s._tag === "Cancelling" && s.run.id === runId) {
                return [idle, { _tag: "Idle" }] as const
              }
              return [Effect.void, s] as const
            }).pipe(Effect.flatten)
          }),
          { _tag: "Cancelling", run: st.run } as const,
        ] as const
      }
      if (st._tag === "Cancelling" && st.run.id === runId) {
        return [Fiber.await(st.run.fiber).pipe(Effect.asVoid, Effect.ignore), st] as const
      }
      // Wrong owner (replacement already took over) — do not touch.
      return [Effect.void, st] as const
    }).pipe(Effect.flatten)

  const startOwned = (
    work: Effect.Effect<A, E>,
  ): Effect.Effect<{ readonly runId: number; readonly interruptOwned: Effect.Effect<void> }, B> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          return [busyFailure<{ runId: number; interruptOwned: Effect.Effect<void> }>(), st] as const
        }
        const done = yield* Deferred.make<A, E | Cancelled>()
        const run = yield* startRun(work, done)
        const owned = {
          runId: run.id,
          interruptOwned: interruptOwned(run.id),
        }
        return [Effect.succeed(owned), { _tag: "Running", run } as const] as const
      }),
    ).pipe(Effect.flatten)

  const cancel = SynchronizedRef.modify(ref, (st) => {
    switch (st._tag) {
      case "Idle":
        return [Effect.void, st] as const
      case "Cancelling":
        // Already waiting on the same fiber — do not double-interrupt.
        return [Fiber.await(st.run.fiber).pipe(Effect.asVoid, Effect.ignore), st] as const
      case "Running":
        return [
          Effect.gen(function* () {
            // Interrupt WAITS for the fiber, including ensuring/finalizers.
            // State stays Cancelling until finishRun or this effect flips Idle
            // so start/ensureRunning cannot begin mid-finalizer (RL-ORPHAN-D01).
            yield* Fiber.interrupt(st.run.fiber)
            // finishRun usually already converged Cancelling → Idle; this is
            // belt-and-suspenders if the fiber exited without onExit ordering.
            yield* SynchronizedRef.modify(ref, (s) => {
              if (s._tag === "Cancelling" && s.run.id === st.run.id) {
                return [idle, { _tag: "Idle" }] as const
              }
              return [Effect.void, s] as const
            }).pipe(Effect.flatten)
          }),
          { _tag: "Cancelling", run: st.run } as const,
        ] as const
      case "Shell":
        return [
          Effect.gen(function* () {
            yield* stopShell(st.shell)
            yield* idleIfCurrent()
          }),
          { _tag: "Idle" } as const,
        ] as const
    }
  }).pipe(Effect.flatten)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    ensureRunning,
    ensureExclusive,
    start,
    startOwned,
    startShell,
    cancel,
  }
}
