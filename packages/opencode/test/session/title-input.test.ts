import { expect, test } from "bun:test"
import { normalizeTitleInput, sanitizeGeneratedTitle, titlePromptText } from "../../src/session/prompt"

test("ordinary text uses flags, not markup or arbitrary metadata, as provenance", () => {
  for (const text of ["/compose-next", "/api/v1", "<inbox>user example</inbox>", "<scheduled-task>example</scheduled-task>"]) {
    expect(normalizeTitleInput([{ type: "text", text, metadata: { origin: "skill" } }]).text).toBe(text)
  }
  expect(normalizeTitleInput([{ type: "text", text: "hidden", synthetic: true }, { type: "text", text: "ignored", ignored: true }, { type: "text", text: "  Fix API\r\nDetails " }]).text).toBe("Fix API\nDetails")
  for (const text of ["12345", "!?", "😀🚀"]) expect(normalizeTitleInput([{ type: "text", text }]).canGenerate).toBe(false)
})

// Bounded attachment-name fallback: no attachment content or filename enters the AI text.
test("structured attachment names supply fallback without treating a host placeholder as user text", () => {
  const input = [
    {
      type: "text",
      text: "(见附件)",
      synthetic: true,
    },
    { type: "file", filename: "研究报告.pdf", url: "file:///private/report.pdf" },
  ]
  const before = JSON.stringify(input)
  expect(normalizeTitleInput(input)).toEqual({ text: "", fallback: "研究报告.pdf", hasInput: true, canGenerate: false })
  expect(JSON.stringify(input)).toBe(before)
  expect(normalizeTitleInput([{ type: "file", filename: "notes.txt" }])).toEqual({
    text: "",
    fallback: "notes.txt",
    hasInput: true,
    canGenerate: false,
  })
  expect(
    normalizeTitleInput([
      { type: "file", filename: "one.pdf" },
      { type: "file", filename: "two.csv" },
    ]).fallback,
  ).toBe("one.pdf, two.csv")
  expect(Array.from(normalizeTitleInput([{ type: "file", filename: "𠮷".repeat(60) + ".pdf" }]).fallback)).toHaveLength(
    48,
  )
  expect(normalizeTitleInput([{ type: "text", text: "(见附件)" }])).toEqual({
    text: "(见附件)",
    fallback: "(见附件)",
    hasInput: true,
    canGenerate: true,
  })
  expect(normalizeTitleInput([{ type: "text", text: "(见附件)", synthetic: true }]).fallback).toBe("Untitled")
  expect(normalizeTitleInput([{ type: "text", text: "分析预算" }, { type: "file", filename: "budget.xlsx" }]).fallback).toBe("分析预算")
  expect(normalizeTitleInput([{ type: "file", filename: " " }, { type: "file" }]).fallback).toBe("Untitled")
  expect(normalizeTitleInput([{ type: "file", filename: "hidden.pdf", synthetic: true }]).fallback).toBe("Untitled")
  expect(normalizeTitleInput([{ type: "file", url: "file:///fixture/report%20one.pdf" }]).fallback).toBe("report one.pdf")
})

// [TP-ST-R9-02] Validation precedes persistence; malformed output never owns a title.
test("output schema scaffolding and think-only values are rejected", () => {
  for (const text of [
    "<think>secret</think>",
    '{"title":"x"}',
    "assistant to=functions.read",
    "123",
    "<system-reminder>Hi</system-reminder>",
    "",
  ])
    expect(sanitizeGeneratedTitle(text)).toBeUndefined()
  expect(sanitizeGeneratedTitle('<think>secret</think>\n\"标题：修复 API 404\"\nextra')).toBe("修复 API 404")
  expect(titlePromptText("Fix an API", "zh-CN")).toContain("do not translate a clear-language task")
})
