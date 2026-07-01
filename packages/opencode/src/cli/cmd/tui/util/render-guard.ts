import { createSignal, onCleanup } from "solid-js"

/**
 * Phase 5 rendering-safety utility: mark a component as destroyed and let
 * late-arriving effects / event handlers short-circuit.
 *
 * Solid components execute effects until their root is disposed, but the
 * `isDestroyed` signal is read from many call sites that may be invoked
 * after a navigation swap. Pairing a destroy guard with `onCleanup` lets
 * those sites exit cheaply:
 *
 * ```ts
 * const guard = useDestroyGuard()
 * createEffect(() => {
 *   if (guard.isDestroyed()) return
 *   ...
 * })
 * ```
 */
export function useDestroyGuard(): { isDestroyed: () => boolean; markDestroyed: () => void } {
  const [isDestroyed, setIsDestroyed] = createSignal(false)
  onCleanup(() => setIsDestroyed(true))
  return {
    isDestroyed,
    markDestroyed: () => setIsDestroyed(true),
  }
}

/**
 * Phase 5 rendering-safety utility: a non-reentrant lock for serializing
 * operations that must not overlap (e.g. mutating a ScrollBox while a sticky
 * scroll effect is mid-flight).
 *
 * The lock is intentionally local — the creator owns the lifecycle and
 * should dispose the holder before teardown. `acquire()` returns `false`
 * when the lock is already held, so callers can opt to skip rather than
 * block.
 */
export function useRenderLock(): { acquire: () => boolean; release: () => void } {
  let held = false
  const acquire = (): boolean => {
    if (held) return false
    held = true
    return true
  }
  const release = (): void => {
    held = false
  }
  onCleanup(release)
  return { acquire, release }
}
