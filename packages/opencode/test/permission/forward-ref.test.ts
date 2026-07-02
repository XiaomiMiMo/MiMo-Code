import { describe, expect, test } from "bun:test"
import { forwardRef } from "../../src/permission/permission-forward-ref"

describe("forwardRef", () => {
  test("specific-session grant", () => {
    forwardRef.setGrant("parent1", "childA")
    expect(forwardRef.grantAllowed("parent1", "childA")).toBe(true)
    expect(forwardRef.grantAllowed("parent1", "childB")).toBe(false)
    forwardRef.clearGrantsForParent("parent1")
    expect(forwardRef.grantAllowed("parent1", "childA")).toBe(false)
  })

  test("all grant", () => {
    forwardRef.setGrant("parent2", "*")
    expect(forwardRef.grantAllowed("parent2", "anyChild")).toBe(true)
    forwardRef.clearGrantsForParent("parent2")
  })

  test("pending add/find/remove", () => {
    forwardRef.addPending("req1", { childSessionID: "cX", parentSessionID: "pY", resolve: () => {} })
    expect(forwardRef.findPendingByChild("cX")?.requestID).toBe("req1")
    forwardRef.removePending("req1")
    expect(forwardRef.findPendingByChild("cX")).toBeUndefined()
  })

  test("resolve invokes the bound resolver, drops the record, is idempotent", () => {
    let calls = 0
    forwardRef.addPending("req3", { childSessionID: "cR", parentSessionID: "pR", resolve: () => (calls += 1) })
    expect(forwardRef.resolve("cR", "allow")).toBe(true)
    expect(calls).toBe(1)
    expect(forwardRef.findPendingByChild("cR")).toBeUndefined()
    // second resolve is a no-op (already dropped)
    expect(forwardRef.resolve("cR", "allow")).toBe(false)
    expect(calls).toBe(1)
  })

  test("clearGrantsForChild removes child from all parents", () => {
    forwardRef.setGrant("p", "childZ")
    forwardRef.clearGrantsForChild("childZ")
    expect(forwardRef.grantAllowed("p", "childZ")).toBe(false)
    forwardRef.clearGrantsForParent("p")
  })

  test("clearGrantsForChild also drops that child's pending records", () => {
    forwardRef.addPending("req2", { childSessionID: "cKill", parentSessionID: "pKeep", resolve: () => {} })
    forwardRef.clearGrantsForChild("cKill")
    expect(forwardRef.findPendingByChild("cKill")).toBeUndefined()
  })
})
