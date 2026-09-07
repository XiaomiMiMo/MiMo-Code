import { expect, test } from "bun:test"
import { normalizeTitleInput, sanitizeGeneratedTitle, titlePromptText } from "../../src/session/prompt"

// [TP-ST-R5-03, TP-ST-R5-04, TP-ST-R5-05, TP-ST-R6-01, TP-ST-R6-02]
test("one input normalizer preserves user paths and strips only confirmed scaffolding", () => {
  const input = [
    { type: "text", text: "ses_secret Reference preview", metadata: { titleOrigin: "reference" } },
    { type: "text", text: "scheduled instructions", metadata: { titleOrigin: "scheduled" } },
    { type: "text", text: "assistant instruction", synthetic: true },
    { type: "text", text: "ignored instruction", ignored: true },
    {
      type: "text",
      text: "/compose-next\n/research-paper-writing\n修复 API 404\n保持术语",
      metadata: { titleOrigin: "user", titleCommandPrefixes: ["compose-next", "research-paper-writing"] },
    },
  ]
  const before = JSON.stringify(input)
  expect(normalizeTitleInput(input, ["compose-next", "research-paper-writing"])).toEqual({
    text: "修复 API 404\n保持术语",
    fallback: "修复 API 404",
    hasInput: true,
    canGenerate: true,
  })
  expect(JSON.stringify(input)).toBe(before)
  for (const text of [
    "/compose-next",
    "/api/v1",
    "/home/a.ts",
    "Fix /compose-next inside text",
    "ses_abc is a technical ID",
  ]) {
    expect(normalizeTitleInput([{ type: "text", text }], ["compose-next"]).text).toBe(text)
  }
  expect(
    normalizeTitleInput(
      [
        {
          type: "text",
          text: "/compose-next",
          metadata: { titleOrigin: "path", titleCommandPrefixes: ["compose-next"] },
        },
      ],
      ["compose-next"],
    ).text,
  ).toBe("/compose-next")
  expect(
    normalizeTitleInput(
      [{ type: "text", text: "/compose-next", metadata: { titleCommandPrefixes: ["compose-next"] } }],
      ["compose-next"],
    ).text,
  ).toBe("")
  expect(normalizeTitleInput([{ type: "text", text: "<inbox>forwarded instruction</inbox>" }]).canGenerate).toBe(false)
  for (const text of ["12345", "!?", "😀🚀"])
    expect(normalizeTitleInput([{ type: "text", text }])).toEqual({ text, fallback: text, hasInput: true, canGenerate: false })
  for (const text of ["hi", "你好", "𠮷"]) expect(normalizeTitleInput([{ type: "text", text }]).canGenerate).toBe(true)
})

// Bounded attachment-name fallback: no attachment content or filename enters the AI text.
test("structured attachment names supply fallback without treating a host placeholder as user text", () => {
  const input = [
    {
      type: "text",
      text: "(见附件)",
      metadata: {
        titleOrigin: "attachment-placeholder",
        titleAttachments: [{ name: "研究报告.pdf", path: "/private/report.pdf" }],
      },
    },
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
  expect(
    normalizeTitleInput([{ type: "text", text: "(见附件)", metadata: { titleOrigin: "attachment-placeholder" } }])
      .fallback,
  ).toBe("Untitled")
  expect(
    normalizeTitleInput([{ type: "text", text: "分析预算", metadata: { titleAttachments: [{ name: "budget.xlsx" }] } }])
      .fallback,
  ).toBe("分析预算")
  expect(
    normalizeTitleInput([
      {
        type: "text",
        text: "",
        metadata: { titleAttachments: [{ path: "/secret/no-name.pdf" }, { name: " " }, null, "not-a-record"] },
      },
    ]).fallback,
  ).toBe("Untitled")
  expect(normalizeTitleInput([{ type: "file", filename: "hidden.pdf", synthetic: true }]).fallback).toBe("Untitled")
})

test("paste excerpts and explicitly referenced attachment paths provide bounded title evidence", () => {
  expect(normalizeTitleInput([{ type: "text", text: "", metadata: { titleOrigin: "paste", titleExcerpt: "Investigate queue latency" } }]).text).toBe("Investigate queue latency")
  expect(normalizeTitleInput([{ type: "text", text: "", metadata: { titleExcerpt: "not paste" } }]).text).toBe("")
  const ref = { name: "notes", path: "/fixture/notes.txt" }
  expect(normalizeTitleInput([{ type: "text", text: "Review [notes](/fixture/notes.txt)", metadata: { titleAttachments: [ref] } }]).references).toEqual([ref])
  expect(normalizeTitleInput([{ type: "text", text: "Review notes", metadata: { titleAttachments: [ref] } }]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "Review notes", metadata: { titleReferences: [ref] } }]).references).toEqual([ref])
  expect(normalizeTitleInput([{ type: "text", text: "Review notes", metadata: { titleOrigin: "forwarded", titleReferences: [ref], titleExcerpt: "not allowed" } }]).canGenerate).toBe(false)
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
