import type ParcelWatcher from "@parcel/watcher"
import { Cause, Effect, Exit } from "effect"
import { realpath } from "node:fs/promises"
import { Log } from "../util"

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000

type Entry = {
  callbacks: Set<ParcelWatcher.SubscribeCallback>
  ready: Promise<ParcelWatcher.AsyncSubscription>
  subscription?: ParcelWatcher.AsyncSubscription
  closing?: Promise<void>
}

type Lease = {
  key: string
  entry: Entry
  callback: ParcelWatcher.SubscribeCallback
  released: boolean
}

export class WatcherSubscriptions {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly subscribe: typeof ParcelWatcher.subscribe) {}

  private acquire(
    key: string,
    dir: string,
    ignore: string[],
    backend: ParcelWatcher.BackendType,
    callback: ParcelWatcher.SubscribeCallback,
  ) {
    const current = this.entries.get(key)
    if (current) {
      current.callbacks.add(callback)
      return { key, entry: current, callback, released: false }
    }
    const entry: Entry = {
      callbacks: new Set([callback]),
      ready: Promise.resolve().then(() =>
        this.subscribe(
          dir,
          (error, events) => {
            for (const listener of Array.from(entry.callbacks)) {
              if (!entry.callbacks.has(listener)) continue
              try {
                listener(error, events)
              } catch (error) {
                log.error("watcher listener failed", { error })
              }
            }
          },
          { ignore, backend },
        ),
      ),
    }
    entry.ready = entry.ready.then((subscription) => {
      entry.subscription = subscription
      return subscription
    })
    this.entries.set(key, entry)
    return { key, entry, callback, released: false }
  }

  private release(lease: Lease): Promise<void> {
    if (lease.released) return Promise.resolve()
    lease.released = true
    const entry = lease.entry
    entry.callbacks.delete(lease.callback)
    if (entry.callbacks.size) return Promise.resolve()
    entry.closing = entry.ready
      .then((subscription) => subscription.unsubscribe())
      .then(
        () => {
          if (this.entries.get(lease.key) === entry) this.entries.delete(lease.key)
        },
        (error) => {
          if (!entry.subscription && this.entries.get(lease.key) === entry) this.entries.delete(lease.key)
          throw error
        },
      )
    const settled = entry.closing.catch((error) => log.error("failed to close watcher subscription", { error }))
    // A timed-out native subscribe cannot be cancelled; close its late result without blocking disposal.
    return entry.subscription ? settled : Promise.resolve()
  }

  watch(dir: string, ignore: string[], backend: ParcelWatcher.BackendType, callback: ParcelWatcher.SubscribeCallback) {
    return Effect.suspend(() => {
      let lease: Lease | undefined
      const listener: ParcelWatcher.SubscribeCallback = (error, events) => callback(error, events)
      return Effect.gen({ self: this }, function* () {
        const physical = yield* Effect.tryPromise(() => realpath(dir))
        const patterns = [...new Set(ignore)].sort()
        const key = JSON.stringify([physical, backend, patterns])
        for (;;) {
          const closing = yield* Effect.sync(() => {
            const closing = this.entries.get(key)?.closing
            if (!closing) lease = this.acquire(key, physical, patterns, backend, listener)
            return closing
          })
          if (!closing) break
          yield* Effect.tryPromise(() => closing)
        }
        const acquired = lease!
        yield* Effect.addFinalizer(() => Effect.promise(() => this.release(acquired)))
        yield* Effect.promise(() => acquired.entry.ready)
      }).pipe(
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && lease ? Effect.promise(() => this.release(lease!)) : Effect.void,
        ),
        Effect.catchCause((cause) => {
          log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
          return Effect.void
        }),
      )
    })
  }
}
