import { describe, expect, test } from "bun:test"
import {
  collectionFor,
  isPackedName,
  isTopLevelKeep,
  pack,
  unpack,
} from "../../src/tool/deber"

describe("pack", () => {
  test("groups available builtins into two-level collections and skips empty ones", () => {
    const specs = pack(["read", "write", "bash", "webfetch", "skill", "task", "invalid", "session"])
    const byId = Object.fromEntries(specs.map((s) => [s.id, s.ops]))
    expect(byId.file).toEqual(["read", "write"])
    expect(byId.shell).toEqual(["bash"])
    expect(byId.net).toEqual(["webfetch"])
    expect(byId.skill).toEqual(["skill"])
    expect(byId.agent).toEqual(["task"])
    expect(byId.media).toBeUndefined()
    expect(byId.misc).toBeUndefined()
  })

  test("keeps control tools top-level and routes unknown ids to misc", () => {
    const specs = pack(["read", "invalid", "session", "workflow", "exec", "mcp_tool_search", "lsp", "plan_exit"])
    const ids = specs.map((s) => s.id)
    expect(ids).toContain("file")
    expect(ids).toContain("misc")
    expect(ids).not.toContain("shell")
    const file = specs.find((s) => s.id === "file")!
    expect(file.ops).toEqual(["read"])
    const misc = specs.find((s) => s.id === "misc")!
    expect(misc.ops).toEqual(["lsp"])
  })

  test("is deterministic for identical input sets", () => {
    const a = pack(["grep", "glob", "read", "bash"])
    const b = pack(["bash", "read", "glob", "grep"])
    expect(a).toEqual(b)
  })

  test("description lists ops and the nested args contract", () => {
    const file = pack(["read", "edit"]).find((s) => s.id === "file")!
    expect(file.description).toContain("- read")
    expect(file.description).toContain("- edit")
    expect(file.description).toContain("`args`")
  })
})

describe("unpack", () => {
  test("passes bare original ids through with their args", () => {
    const result = unpack("bash", { command: "ls" })
    expect(result).toEqual({ ok: true, id: "bash", args: { command: "ls" } })
  })

  test("unwraps nested op+args and records the collection", () => {
    const result = unpack("file", { op: "read", args: { path: "/tmp/a" } })
    expect(result).toEqual({ ok: true, id: "read", args: { path: "/tmp/a" }, via: "file" })
  })

  test("lifts flattened op fields into args when nested args is absent", () => {
    const result = unpack("shell", { op: "bash", command: "pwd" })
    expect(result).toEqual({ ok: true, id: "bash", args: { command: "pwd" }, via: "shell" })
  })

  test("rejects missing/empty op on a collection call", () => {
    const result = unpack("file", { args: { path: "/tmp/a" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid-args")
  })

  test("rejects ops outside the collection", () => {
    const result = unpack("shell", { op: "read", args: { path: "/tmp/a" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown-op")
  })

  test("rejects non-object args", () => {
    const result = unpack("file", { op: "read", args: "nope" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid-args")
  })

  test("rejects control/packed names as misc ops", () => {
    const result = unpack("misc", { op: "session", args: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unknown-op")
  })

  test("is idempotent: unpack of already-unpacked shape stays a bare call", () => {
    const first = unpack("file", { op: "read", args: { path: "/tmp/a" } })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = unpack(first.id, first.args)
    expect(second).toEqual({ ok: true, id: "read", args: { path: "/tmp/a" } })
  })
})

describe("classification", () => {
  test("top-level keep and packed names", () => {
    expect(isTopLevelKeep("invalid")).toBe(true)
    expect(isTopLevelKeep("session")).toBe(true)
    expect(isTopLevelKeep("read")).toBe(false)
    expect(isPackedName("file")).toBe(true)
    expect(isPackedName("read")).toBe(false)
    expect(collectionFor("read")).toBe("file")
    expect(collectionFor("lsp")).toBeUndefined()
  })
})
