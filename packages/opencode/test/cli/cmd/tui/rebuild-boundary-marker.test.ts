import { describe, expect, test } from "bun:test"
import { dict as en } from "../../../../src/cli/cmd/tui/i18n/en"
import { dict as zh } from "../../../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../../../src/cli/cmd/tui/i18n/zht"

// A `/rebuild` inserts one user message carrying a `checkpoint` part plus
// synthetic text parts. The TUI renders it as a one-line marker row in
// UserMessage (routes/session/index.tsx) so the boundary is visible in the
// transcript. The label copy is localized; the marker row would render an empty
// badge if these keys ever went missing, so pin them here.
const KEYS = ["tui.session.rebuild_boundary.label", "tui.session.rebuild_boundary.detail"] as const

describe("rebuild boundary marker copy", () => {
  test("english copy names the rebuild and what happened to earlier messages", () => {
    expect(en["tui.session.rebuild_boundary.label"]).toBe("context rebuilt")
    expect(en["tui.session.rebuild_boundary.detail"]).toBe("earlier messages summarized")
  })

  test("localized dictionaries define the marker copy", () => {
    for (const key of KEYS) {
      for (const [name, dict] of Object.entries({ en, zh, zht })) {
        expect(dict[key], `${name} is missing ${key}`).toBeTruthy()
      }
      // Untranslated keys silently fall back to English via the `base` merge in
      // context/language.tsx, so an English string here means a missed
      // translation rather than a crash — assert it is actually translated.
      expect(zh[key]).not.toBe(en[key])
      expect(zht[key]).not.toBe(en[key])
    }
  })
})
