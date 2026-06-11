import { describe, test, expect } from "bun:test"
import { resolveInvocationStyle } from "../../src/tool/invocation-style"

describe("resolveInvocationStyle", () => {
  test("defaults to json when no tool config", () => {
    expect(resolveInvocationStyle(undefined, "task")).toBe("json")
    expect(resolveInvocationStyle({}, "task")).toBe("json")
  })

  test("global invocation_style applies to all tools", () => {
    const cfg = { invocation_style: "shell" as const }
    expect(resolveInvocationStyle(cfg, "task")).toBe("shell")
    expect(resolveInvocationStyle(cfg, "actor")).toBe("shell")
  })

  test("per-tool override beats global", () => {
    const cfg = {
      invocation_style: "shell" as const,
      invocation_style_by_tool: { task: "json" as const },
    }
    expect(resolveInvocationStyle(cfg, "task")).toBe("json")
    expect(resolveInvocationStyle(cfg, "actor")).toBe("shell")
  })

  test("per-tool override applies with no global set (global defaults json)", () => {
    const cfg = { invocation_style_by_tool: { actor: "shell" as const } }
    expect(resolveInvocationStyle(cfg, "actor")).toBe("shell")
    expect(resolveInvocationStyle(cfg, "task")).toBe("json")
  })
})
