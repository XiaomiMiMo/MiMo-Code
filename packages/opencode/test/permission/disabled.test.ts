import { test, expect } from "bun:test"
import { Permission } from "../../src/permission"

// Minimal ruleset builder: each entry is {permission, pattern, action}.
// Using Permission.fromConfig keeps the shape identical to agent.ts configs.
function ruleset(config: Parameters<typeof Permission.fromConfig>[0]) {
  return Permission.fromConfig(config)
}

test("edit: deny on its own disables all EDIT_TOOLS (group-shorthand convenience)", () => {
  const rs = ruleset({ edit: "deny" })
  const disabled = Permission.disabled(["edit", "write", "apply_patch", "multiedit", "read"], rs)
  expect([...disabled].sort()).toEqual(["apply_patch", "edit", "multiedit", "write"])
})

test("edit: allow on its own enables all EDIT_TOOLS", () => {
  const rs = ruleset({ edit: "allow" })
  const disabled = Permission.disabled(["edit", "write", "apply_patch", "multiedit", "read"], rs)
  expect(disabled.size).toBe(0)
})

test("edit: deny + write: allow (in order) — tool-specific rule wins, write is enabled", () => {
  const rs = ruleset({ edit: "deny", write: "allow" })
  const disabled = Permission.disabled(["edit", "write", "apply_patch", "multiedit"], rs)
  expect(disabled.has("write")).toBe(false)
  // Other EDIT_TOOLS without their own rule still fall back to the edit group
  expect(disabled.has("edit")).toBe(true)
  expect(disabled.has("apply_patch")).toBe(true)
  expect(disabled.has("multiedit")).toBe(true)
})

test("write: deny on its own now blocks write (previously had no effect)", () => {
  const rs = ruleset({ write: "deny" })
  const disabled = Permission.disabled(["write", "edit"], rs)
  expect(disabled.has("write")).toBe(true)
  // edit has no rule at all; fall through to nothing → not disabled
  expect(disabled.has("edit")).toBe(false)
})

test("*: allow with no edit/write rule — write enabled", () => {
  const rs = ruleset({ "*": "allow" })
  const disabled = Permission.disabled(["write", "edit"], rs)
  expect(disabled.size).toBe(0)
})

test("*: deny with no edit/write rule — write disabled (wildcard-match)", () => {
  const rs = ruleset({ "*": "deny" })
  const disabled = Permission.disabled(["write", "edit"], rs)
  expect(disabled.has("write")).toBe(true)
  expect(disabled.has("edit")).toBe(true)
})

test("plan_enter/plan_exit are not disabled under default *: allow", () => {
  const rs = ruleset({ "*": "allow", question: "deny" })
  const disabled = Permission.disabled(["plan_enter", "plan_exit", "question", "bash"], rs)
  expect(disabled.has("plan_enter")).toBe(false)
  expect(disabled.has("plan_exit")).toBe(false)
  expect(disabled.has("question")).toBe(true)
  expect(disabled.has("bash")).toBe(false)
})

test("plan_enter/plan_exit disabled only by explicit deny", () => {
  const rs = ruleset({ "*": "allow", plan_enter: "deny", plan_exit: "deny" })
  const disabled = Permission.disabled(["plan_enter", "plan_exit", "bash"], rs)
  expect(disabled.has("plan_enter")).toBe(true)
  expect(disabled.has("plan_exit")).toBe(true)
  expect(disabled.has("bash")).toBe(false)
})
