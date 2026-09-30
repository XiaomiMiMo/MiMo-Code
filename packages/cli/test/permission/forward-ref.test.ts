import { describe, expect, test } from "bun:test"
import { forwardRef } from "../../src/permission/permission-forward-ref"

describe("forwardRef parent-grant snapshots", () => {
  test("set/get/clear parent grants", () => {
    forwardRef.setParentGrants("parent1", {
      ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      approved: [{ permission: "edit", pattern: "/tmp/*", action: "allow" }],
    })
    const snap = forwardRef.getParentGrants("parent1")
    expect(snap?.ruleset).toHaveLength(1)
    expect(snap?.approved).toHaveLength(1)
    forwardRef.clearParentGrants("parent1")
    expect(forwardRef.getParentGrants("parent1")).toBeUndefined()
  })

  test("snapshot is shallow-copied so later mutation cannot widen a child grant", () => {
    const ruleset = [{ permission: "bash", pattern: "*", action: "allow" as const }]
    forwardRef.setParentGrants("parent2", { ruleset, approved: [] })
    ruleset.push({ permission: "edit", pattern: "*", action: "allow" })
    expect(forwardRef.getParentGrants("parent2")?.ruleset).toHaveLength(1)
    forwardRef.clearParentGrants("parent2")
  })
})
