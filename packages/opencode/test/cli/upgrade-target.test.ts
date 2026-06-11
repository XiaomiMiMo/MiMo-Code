import { describe, expect, test } from "bun:test"
import { resolveUpgradeTarget } from "../../src/cli/cmd/upgrade"
import { Installation } from "../../src/installation"

describe("upgrade target resolution", () => {
  test("uses the selected method when resolving latest target", async () => {
    const calls: Installation.Method[] = []
    const target = await resolveUpgradeTarget({
      method: "npm",
      latest: async (method) => {
        calls.push(method)
        return "2.0.0"
      },
    })

    expect(target).toBe("2.0.0")
    expect(calls).toEqual(["npm"])
  })

  test("normalizes explicit target without checking latest", async () => {
    const target = await resolveUpgradeTarget({
      target: "v2.0.0",
      method: "curl",
      latest: async () => {
        throw new Error("latest should not be called")
      },
    })

    expect(target).toBe("2.0.0")
  })
})
