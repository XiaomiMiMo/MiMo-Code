import type { Renderable } from "@opentui/core"

/**
 * Phase 5 window-fragility fix: focus-steal guard for grid cells.
 *
 * `Prompt` (and a few other components) auto-focus themselves in effects,
 * which used to fire after a dialog closed even when the active cell was no
 * longer the user's focus. Wrapping the focus call with `withFocusGuard` lets
 * callers quickly check whether the surrounding context makes focusing safe
 * before the call is attempted.
 */
export function withFocusGuard(fn: () => void): void {
  if (!isSafeToFocusGlobal()) return
  fn()
}

/**
 * `true` iff a focus call on `target` is safe to perform right now.
 *
 * The rules:
 * - target must be alive (not destroyed)
 * - target must currently be `focusable`
 * - target must not be the currently-focused renderable (focusing something
 *   that is already focused is a no-op but emits a frame of churn)
 * - target must have a non-zero size — focusing a 0x0 element drops Yoga into
 *   an invalid state on some layouts
 */
export function isSafeToFocus(target: Renderable): boolean {
  if (!target || target.isDestroyed) return false
  if (!target.focusable) return false
  if (target.focused) return false
  const width = target.width
  const height = target.height
  if (width <= 0 || height <= 0) return false
  return true
}

/**
 * Cross-cell focus supervisor. `true` when the global state is healthy enough
 * that any focus operation is reasonable. The default implementation always
 * returns `true`; grid-level mounts override this via `setFocusGuard` when
 * they own the active cell.
 */
let guard: () => boolean = () => true

export function setFocusGuard(fn: () => boolean): () => void {
  const previous = guard
  guard = fn
  return () => {
    guard = previous
  }
}

function isSafeToFocusGlobal(): boolean {
  return guard()
}
