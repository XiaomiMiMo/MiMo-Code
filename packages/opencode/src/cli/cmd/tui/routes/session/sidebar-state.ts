/**
 * Sidebar visibility preference. `auto` follows the terminal width; `show`/`hide` are
 * explicit user overrides that outlive a resize.
 */
export type SidebarPreference = "auto" | "show" | "hide"

export function sidebarVisibleFor(preference: SidebarPreference, wide: boolean) {
  if (preference === "auto") return wide
  return preference === "show"
}

/**
 * Toggling normalises back to `auto` whenever the requested state is what the width
 * would have picked anyway. That keeps a collapse/expand round-trip on a wide terminal
 * from leaving behind a `show` override that survives a shrink.
 */
export function sidebarToggle(preference: SidebarPreference, wide: boolean): SidebarPreference {
  const next = !sidebarVisibleFor(preference, wide)
  if (next === wide) return "auto"
  return next ? "show" : "hide"
}
