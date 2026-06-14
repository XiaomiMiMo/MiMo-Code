import { describe, expect, test } from "bun:test"
import { DEFAULT_KINDS, extract, type Kind } from "../../src/history/extract"

const set = (kinds: ReadonlyArray<Kind>) => new Set<Kind>(kinds)

describe("history.extract", () => {
  test("DEFAULT_KINDS = user_text + assistant_text + tool_input + tool_error", () => {
    expect([...DEFAULT_KINDS].sort()).toEqual(
      ["assistant_text", "tool_error", "tool_input", "user_text"],
    )
  })

  test("user text part → user_text", () => {
    const r = extract({ type: "text", text: "hello world" } as any, "user", set(DEFAULT_KINDS))
    expect(r).toEqual({ kind: "user_text", body: "hello world", tool_name: null })
  })

  test("assistant text part → assistant_text", () => {
    const r = extract({ type: "text", text: "sure" } as any, "assistant", set(DEFAULT_KINDS))
    expect(r).toEqual({ kind: "assistant_text", body: "sure", tool_name: null })
  })

  test("empty text → null (streaming chunk filter)", () => {
    const r = extract({ type: "text", text: "" } as any, "assistant", set(DEFAULT_KINDS))
    expect(r).toBeNull()
  })

  test("reasoning skipped when not in enabled kinds", () => {
    const r = extract({ type: "reasoning", text: "thinking" } as any, "assistant", set(DEFAULT_KINDS))
    expect(r).toBeNull()
  })

  test("reasoning indexed when enabled", () => {
    const r = extract({ type: "reasoning", text: "thinking" } as any, "assistant", set(["reasoning"]))
    expect(r).toEqual({ kind: "reasoning", body: "thinking", tool_name: null })
  })

  test("tool pending → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "pending", input: {} } }
    expect(extract(part as any, "assistant", set(DEFAULT_KINDS))).toBeNull()
  })

  test("tool running → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "running", input: { command: "ls" } } }
    expect(extract(part as any, "assistant", set(DEFAULT_KINDS))).toBeNull()
  })

  test("tool completed → tool_input (output disabled)", () => {
    const part = {
      type: "tool",
      tool: "Bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }
    const r = extract(part as any, "assistant", set(DEFAULT_KINDS))
    expect(r).toEqual({
      kind: "tool_input",
      body: 'Bash {"command":"ls"}',
      tool_name: "Bash",
    })
  })

  test("tool completed + tool_output enabled → tool_output (includes output)", () => {
    const part = {
      type: "tool",
      tool: "Bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }
    const r = extract(part as any, "assistant", set(["tool_output", "tool_input"]))
    expect(r?.kind).toBe("tool_output")
    expect(r?.body).toContain("Bash")
    expect(r?.body).toContain('"command":"ls"')
    expect(r?.body).toContain("file.txt")
    expect(r?.tool_name).toBe("Bash")
  })

  test("tool error → tool_error", () => {
    const part = {
      type: "tool",
      tool: "Read",
      state: { status: "error", input: { file_path: "/tmp/x" }, error: "ENOENT" },
    }
    const r = extract(part as any, "assistant", set(DEFAULT_KINDS))
    expect(r).toEqual({
      kind: "tool_error",
      body: 'Read {"file_path":"/tmp/x"} ENOENT',
      tool_name: "Read",
    })
  })

  test("tool error but tool_error disabled, tool_input enabled → tool_input", () => {
    const part = {
      type: "tool",
      tool: "Read",
      state: { status: "error", input: { file_path: "/tmp/x" }, error: "ENOENT" },
    }
    const r = extract(part as any, "assistant", set(["tool_input"]))
    expect(r?.kind).toBe("tool_input")
  })

  test("step-start / step-finish / patch / compaction → null", () => {
    for (const type of ["step-start", "step-finish", "patch", "compaction"]) {
      const r = extract({ type } as any, "assistant", set(DEFAULT_KINDS))
      expect(r).toBeNull()
    }
  })
})
