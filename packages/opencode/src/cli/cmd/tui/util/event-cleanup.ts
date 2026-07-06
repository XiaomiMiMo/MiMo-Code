import { onCleanup } from "solid-js"

/**
 * Phase 5 event-leak fix: collect per-component event-listener cleanups and
 * run them in a single `onCleanup`.
 *
 * `event.on()` calls in this codebase frequently return a `Promise<() => void>`
 * that previously was discarded — which leaked the listener across route
 * changes. `track()` accepts either a sync cleanup or a thenable; both
 * resolve into a single dispose sweep registered against the current Solid
 * owner. If a tracked cleanup throws, the rest still run.
 */
export function useEventTracker(): {
  track: (cleanup: (() => void) | Promise<() => void>) => void
  cleanup: () => void
} {
  const cleanups: Array<() => void> = []
  const track = (cleanup: (() => void) | Promise<() => void>) => {
    if (typeof cleanup === "function") {
      cleanups.push(cleanup)
      return
    }
    void cleanup.then(
      (fn) => {
        if (typeof fn === "function") cleanups.push(fn)
      },
      () => {
        // Track the failure but do not throw — the rest of the listeners
        // should still be eligible to run on teardown
      },
    )
  }
  const cleanup = () => {
    while (cleanups.length) {
      const fn = cleanups.pop()
      try {
        fn?.()
      } catch {
        // Ignore individual cleanup failures; other listeners still need to run
      }
    }
  }
  onCleanup(cleanup)
  return { track, cleanup }
}
