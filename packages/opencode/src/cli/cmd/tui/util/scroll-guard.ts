import { createEffect, createSignal, on, onCleanup, type Signal } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"

/**
 * Phase 5 scroll-stability fix: prevent sticky-scroll reset cascades.
 *
 * The default ScrollBox `stickyScroll` behaviour auto-resets to the bottom on
 * every content mutation. In a grid with multiple live cells, that "helpful"
 * behaviour is the primary cause of unwanted scroll jumps when the user has
 * deliberately scrolled away from the bottom. The guard flips the
 * `stickyScroll` flag off whenever the user has moved away from the bottom
 * (tracked via the `isAtBottom` signal) and re-enables it only after the user
 * scrolls back. Resets are debounced so a rapid burst of updates collapses
 * into a single stable state.
 */
export function useStickyScrollGuard(
  scrollRef: () => ScrollBoxRenderable | undefined,
  isAtBottom: Signal<boolean>,
): void {
  const [enabled, setEnabled] = createSignal(true)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const applyToRef = () => {
    const ref = scrollRef()
    if (!ref || ref.isDestroyed) return
    ref.stickyScroll = enabled()
  }

  // When the user has scrolled away from the bottom, freeze sticky scroll so
  // a new message does not yank them back. When they return to the bottom,
  // re-enable so future updates follow them.
  createEffect(
    on(
      isAtBottom[0],
      (atBottom) => {
        setEnabled(atBottom)
      },
      { defer: true },
    ),
  )

  // Debounce sticky-scroll toggles so a burst of content mutations does not
  // thrash the flag (each toggle forces Yoga to re-layout, which on a 4-cell
  // grid compounds into visible jitter).
  const scheduleApply = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      applyToRef()
    }, 32)
  }

  createEffect(
    on(
      enabled,
      () => {
        scheduleApply()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer)
  })
}
