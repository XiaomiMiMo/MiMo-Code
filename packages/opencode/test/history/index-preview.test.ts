import { test, expect } from "bun:test"
import { boundedJson, previewForIndex, previewToolOutput, INDEX_MAX_BYTES, INDEX_MAX_LINES } from "../../src/history/index-preview"
import { extract } from "../../src/history/extract"
import { MAX_BYTES, MAX_LINES } from "../../src/tool/truncate"

test("history preview shares tool truncate budget constants", () => {
  expect(INDEX_MAX_BYTES).toBe(MAX_BYTES)
  expect(INDEX_MAX_LINES).toBe(MAX_LINES)
  expect(INDEX_MAX_BYTES).toBe(50 * 1024)
})

test("previewForIndex is previewToolOutput from the tool-result path", () => {
  const long = "x".repeat(MAX_BYTES + 10_000)
  expect(previewForIndex(long)).toBe(previewToolOutput(long).content)
})

test("previewForIndex passes short text through", () => {
  expect(previewForIndex("hello")).toBe("hello")
})

test("previewForIndex caps long text", () => {
  const long = "x".repeat(MAX_BYTES + 20_000)
  const out = previewForIndex(long)
  expect(out.length).toBeLessThan(long.length)
  expect(out).toContain("truncated")
})

test("boundedJson never returns multi-MB strings", () => {
  const s = boundedJson({ output: "y".repeat(200_000) })
  expect(Buffer.byteLength(s, "utf-8")).toBeLessThanOrEqual(MAX_BYTES)
})

test("extract tool output stays within tool-result budget", () => {
  const part = {
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "find /" },
      output: "line\n".repeat(30_000),
    },
  } as never
  const r = extract(part)
  expect(r).not.toBeNull()
  expect(Buffer.byteLength(r!.body, "utf-8")).toBeLessThanOrEqual(MAX_BYTES + 256)
})

test("extract uses stored tool result string when present", () => {
  const stored =
    "bash {\"command\":\"ls\"} total 1\n\nThe tool call succeeded but the output was truncated. Full output saved to: /tmp/tool_abc\nUse Grep to search the full content or Read with offset/limit to view specific sections."
  const r = extract({
    type: "tool",
    tool: "bash",
    state: { status: "completed", input: { command: "ls" }, output: stored },
  } as never)
  expect(r?.body).toContain("/tmp/tool_abc")
})

test("huge tool input does not evict output path hint", () => {
  const hugeInput = {
    files: Array.from({ length: 4000 }, (_, i) => `/very/long/path/to/file_${i}.ts`),
  }
  const path = "/tmp/tool_xyz_needle"
  const output =
    "z".repeat(180_000) +
    `\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${path}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
  const r = extract({
    type: "tool",
    tool: "Bash",
    state: { status: "completed", input: hugeInput, output },
  } as never)
  expect(r).not.toBeNull()
  expect(r!.body).toContain(path)
  expect(r!.body).toContain("Bash")
  expect(Buffer.byteLength(r!.body, "utf-8")).toBeLessThanOrEqual(MAX_BYTES + 256)
})

test("extract patch file list is budgeted", () => {
  const files = Array.from({ length: 20_000 }, (_, i) => `/path/to/file_${i}.ts`)
  const r = extract({ type: "patch", hash: "h", files } as never)
  expect(r).not.toBeNull()
  expect(Buffer.byteLength(r!.body, "utf-8")).toBeLessThanOrEqual(MAX_BYTES + 256)
})

test("previewToolOutput stays within maxBytes including markers", () => {
  for (const direction of ["head", "tail", "head+tail"] as const) {
    const long = Array.from({ length: 8000 }, (_, i) => `line-${i}-${"payload".repeat(20)}`).join("\n")
    const r = previewToolOutput(long, { direction })
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(MAX_BYTES)
  }
})

test("previewToolOutput keeps a head slice for single-line giant outputs", () => {
  const line = `needle-start ${"x".repeat(200_000)}`
  const r = previewToolOutput(line, { direction: "head" })
  expect(r.truncated).toBe(true)
  expect(r.content).toContain("needle-start")
  expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(MAX_BYTES)
})
