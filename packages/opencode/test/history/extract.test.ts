import { MessageV2 } from "../../src/session/message-v2"
import { partExamples } from "./fixtures/parts"
import { describe, expect, test } from "bun:test"
import { extract, extractCleaned } from "../../src/history/extract"

describe("history.extract", () => {
  test("user text is indexed", () => {
    const r = extract({ type: "text", text: "hello world" } as any)
    expect(r).toEqual({ body: "hello world", tool_name: null })
  })

  test("assistant text is indexed", () => {
    const r = extract({ type: "text", text: "sure" } as any)
    expect(r).toEqual({ body: "sure", tool_name: null })
  })

  test("empty text → null (streaming chunk filter)", () => {
    const r = extract({ type: "text", text: "" } as any)
    expect(r).toBeNull()
  })

  test("reasoning is indexed", () => {
    const r = extract({ type: "reasoning", text: "thinking" } as any)
    expect(r).toEqual({ body: "thinking", tool_name: null })
  })

  test("tool pending → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "pending", input: {} } }
    expect(extract(part as any)).toBeNull()
  })

  test("tool running → null (streaming mid-state)", () => {
    const part = { type: "tool", tool: "Bash", state: { status: "running", input: { command: "ls" } } }
    expect(extract(part as any)).toBeNull()
  })

  test("completed tool indexes both input and output", () => {
    const part = {
      type: "tool",
      tool: "Bash",
      state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
    }
    const r = extract(part as any)
    expect(r?.body).toContain("Bash")
    expect(r?.body).toContain('"command":"ls"')
    expect(r?.body).toContain("file.txt")
    expect(r?.tool_name).toBe("Bash")
  })

  test("tool error includes input and error", () => {
    const part = {
      type: "tool",
      tool: "Read",
      state: { status: "error", input: { file_path: "/tmp/x" }, error: "ENOENT" },
    }
    const r = extract(part as any)
    expect(r).toEqual({
      body: 'Read {"file_path":"/tmp/x"} ENOENT',
      tool_name: "Read",
    })
  })

  test("execution markers are not indexed", () => {
    for (const type of ["step-start", "step-finish", "snapshot", "checkpoint"]) {
      const r = extract({ type } as any)
      expect(r).toBeNull()
    }
  })
})

test("image filename and MIME are searchable without binary payload", () => {
  expect(
    extract({
      type: "file",
      filename: "designneedle.png",
      mime: "image/png",
      url: "data:image/png;base64,YWJj",
    } as any),
  ).toEqual({ body: "designneedle.png image/png", tool_name: null })
  // extract() returns raw text; FTS write cleans media per chunk.
  const raw = extract({
    type: "tool",
    tool: "image",
    state: {
      status: "completed",
      input: {},
      output: "data:image/png;base64,YWJj",
      attachments: [{ filename: "diagramneedle.png", mime: "image/png", url: "data:image/png;base64,YWJj" }],
    },
  } as any)
  expect(raw?.body).toContain("diagramneedle.png")
  const cleaned = extractCleaned({
    type: "tool",
    tool: "image",
    state: {
      status: "completed",
      input: {},
      output: "data:image/png;base64,YWJj",
      attachments: [{ filename: "diagramneedle.png", mime: "image/png", url: "data:image/png;base64,YWJj" }],
    },
  } as any)
  expect(cleaned?.body).toContain("diagramneedle.png")
  expect(cleaned?.body).not.toContain("YWJj")
})

test("every declared part variant has an explicit indexing decision", () => {
  expect(partExamples.map(({ data }) => data.type).sort()).toEqual(
    MessageV2.Part.options.map((schema) => schema.shape.type.value).sort(),
  )
  for (const [i, example] of partExamples.entries()) {
    const part = MessageV2.Part.parse({ id: `prt_${i}`, sessionID: "ses_all", messageID: "msg_all", ...example.data })
    const result = extractCleaned(part)
    if (example.query) expect(result?.body).toContain(example.query)
    else expect(result).toBeNull()
    expect(result?.body ?? "").not.toContain("YWJj")
  }
})
