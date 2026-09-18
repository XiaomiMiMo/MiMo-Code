import { Cause, Effect, Exit, Fiber, Semaphore } from "effect"
import { Log } from "../util"

const log = Log.create({ service: "snapshot" })

export interface Resource {
  readonly gitdir: string
  readonly worktree: string
}

interface Entry {
  readonly resource: Resource
  readonly lock: Semaphore.Semaphore
  readonly refs: Set<{ readonly enabled: Effect.Effect<boolean> }>
  pending: number
}

export function make() {
  const entries = new Map<string, Entry>()

  const entry = (resource: Resource) => {
    const hit = entries.get(resource.gitdir)
    if (hit) return hit
    const next: Entry = {
      resource: { gitdir: resource.gitdir, worktree: resource.worktree },
      lock: Semaphore.makeUnsafe(1),
      refs: new Set(),
      pending: 0,
    }
    entries.set(resource.gitdir, next)
    return next
  }

  const retire = (value: Entry) => {
    if (value.refs.size || value.pending || entries.get(value.resource.gitdir) !== value) return
    entries.delete(value.resource.gitdir)
  }

  // Resolve at execution time so delayed callers cannot reuse a retired semaphore.
  const locked = <A, E, R>(resource: Resource, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const value = entry(resource)
        value.pending += 1
        return value
      }),
      (value) => value.lock.withPermits(1)(effect),
      (value) =>
        Effect.sync(() => {
          value.pending -= 1
          retire(value)
        }),
    )

  return {
    acquire: (resource: Resource, enabled: Effect.Effect<boolean>) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const value = entry(resource)
          const ref = { enabled }
          value.refs.add(ref)
          return { value, ref }
        }),
        ({ value, ref }) =>
          Effect.sync(() => {
            value.refs.delete(ref)
            retire(value)
          }),
      ).pipe(Effect.asVoid),
    locked,
    sweep: (cleanup: (resource: Resource) => Effect.Effect<void>) =>
      Effect.suspend(() =>
        Effect.forEach(
          Array.from(entries.values(), (value) => value.resource),
          (resource) =>
            locked(
              resource,
              Effect.gen(function* () {
                const value = entries.get(resource.gitdir)!
                for (const ref of Array.from(value.refs)) {
                  if (!value.refs.has(ref)) continue
                  // Cached dependency interruptions must not cancel the Runtime scheduler.
                  const active = yield* Effect.acquireUseRelease(Effect.forkChild(ref.enabled), Fiber.await, (fiber) =>
                    Fiber.interrupt(fiber),
                  )
                  if (Exit.isFailure(active)) {
                    log.error("cleanup enablement failed", { cause: Cause.pretty(active.cause) })
                    continue
                  }
                  if (!active.value || !value.refs.has(ref)) continue
                  yield* cleanup(resource)
                  return
                }
              }),
            ).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                log.error("cleanup failed", { cause: Cause.pretty(cause) })
                return Effect.void
              }),
            ),
          { discard: true },
        ),
      ),
  }
}
