import { describe, expect, test } from "bun:test"
import { AGREEMENT_KEY, shouldShowAgreement } from "../../../../src/cli/cmd/tui/component/dialog-agreement"

describe("product agreement", () => {
  test("key is product-level and not free-channel branded", () => {
    expect(AGREEMENT_KEY).toBe("agreement_accepted")
    expect(AGREEMENT_KEY).not.toContain("free")
  })

  test("shows on first launch and stays hidden once accepted", () => {
    expect(shouldShowAgreement(undefined)).toBe(true)
    expect(shouldShowAgreement(false)).toBe(true)
    expect(shouldShowAgreement(true)).toBe(false)
  })
})
