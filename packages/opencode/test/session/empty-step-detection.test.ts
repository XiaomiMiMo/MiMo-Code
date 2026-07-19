import { describe, expect, test } from "bun:test"
import { isEmptyStep } from "../../src/session/prompt/empty-step-detection"
import type { MessageV2 } from "../../src/session/message-v2"

// Minimal part builders — only the fields isEmptyStep inspects. Cast through
// unknown so we don't have to satisfy the full PartBase shape (id/messageID/…)
// that isEmptyStep never reads.
function toolPart(input: Record<string, unknown>, opts?: { providerExecuted?: boolean; status?: string }) {
  return {
    type: "tool",
    tool: "read",
    metadata: opts?.providerExecuted ? { providerExecuted: true } : undefined,
    state: { status: opts?.status ?? "completed", input },
  } as unknown as MessageV2.Part
}

function textPart(text: string, opts?: { synthetic?: boolean; ignored?: boolean }) {
  return {
    type: "text",
    text,
    synthetic: opts?.synthetic,
    ignored: opts?.ignored,
  } as unknown as MessageV2.Part
}

function reasoningPart(text: string) {
  return { type: "reasoning", text } as unknown as MessageV2.Part
}

describe("isEmptyStep — case (a): tool call with empty/invalid input", () => {
  test("tool call with no keys is empty", () => {
    expect(isEmptyStep([toolPart({})])).toBe(true)
  })

  test("tool call whose only values are empty strings/whitespace is empty", () => {
    expect(isEmptyStep([toolPart({ file_path: "", pattern: "   " })])).toBe(true)
  })

  test("tool call whose values are null/undefined is empty", () => {
    expect(isEmptyStep([toolPart({ a: null, b: undefined })])).toBe(true)
  })

  test("tool call with empty array / empty object values is empty", () => {
    expect(isEmptyStep([toolPart({ items: [], opts: {} })])).toBe(true)
  })

  test("tool call with a real string argument is NOT empty", () => {
    expect(isEmptyStep([toolPart({ file_path: "/tmp/x" })])).toBe(false)
  })

  test("tool call with a numeric/boolean argument is NOT empty", () => {
    expect(isEmptyStep([toolPart({ limit: 0 })])).toBe(false)
    expect(isEmptyStep([toolPart({ flag: false })])).toBe(false)
  })

  test("all tool parts empty => empty; any non-empty tool part => not empty", () => {
    expect(isEmptyStep([toolPart({}), toolPart({ x: "" })])).toBe(true)
    expect(isEmptyStep([toolPart({}), toolPart({ x: "real" })])).toBe(false)
  })

  test("provider-executed tool part is ignored for the has-tool test", () => {
    // A provider-executed part is not a client action; without any real client
    // tool call there is nothing to flag as empty (b-branch is disabled).
    expect(isEmptyStep([toolPart({ q: "x" }, { providerExecuted: true })])).toBe(false)
  })
})

describe("isEmptyStep — (b) empty terminal is NOT flagged (allowed by design)", () => {
  test("completely empty parts array is NOT empty (natural turn end)", () => {
    expect(isEmptyStep([])).toBe(false)
  })

  test("only a synthetic text part is NOT empty (no client tool call to flag)", () => {
    expect(isEmptyStep([textPart("<system-reminder>...</system-reminder>", { synthetic: true })])).toBe(false)
  })

  test("only whitespace text is NOT empty", () => {
    expect(isEmptyStep([textPart("   \n  ")])).toBe(false)
  })

  test("substantive text answer is NOT empty", () => {
    expect(isEmptyStep([textPart("Here is your answer.")])).toBe(false)
  })

  test("substantive reasoning is NOT empty", () => {
    expect(isEmptyStep([reasoningPart("Let me think about this...")])).toBe(false)
  })

  test("ignored text alone is NOT empty (no tool call to flag)", () => {
    expect(isEmptyStep([textPart("stuff", { ignored: true })])).toBe(false)
  })

  test("provider-executed tool part alone is NOT empty (not a client action)", () => {
    expect(isEmptyStep([toolPart({ q: "x" }, { providerExecuted: true })])).toBe(false)
  })
})
