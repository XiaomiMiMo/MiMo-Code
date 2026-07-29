import { describe, expect, test } from "bun:test"
import { logo, logoThin } from "../../../src/cli/logo"
import { homeLogoShape, resolveHomeLogoKey } from "../../../src/cli/cmd/tui/routes/home-logo"

describe("home logo selection", () => {
  test("uses the visible classic logo by default", () => {
    expect(resolveHomeLogoKey(undefined)).toBe("classic")
    expect(homeLogoShape(undefined)).toBe(logo)
  })

  test("keeps an explicit thin logo preference", () => {
    expect(resolveHomeLogoKey("thin")).toBe("thin")
    expect(homeLogoShape("thin")).toBe(logoThin)
  })

  test("falls back to classic for invalid stored preferences", () => {
    expect(resolveHomeLogoKey("missing")).toBe("classic")
    expect(homeLogoShape("missing")).toBe(logo)
  })
})
