import { expect, test } from "bun:test"
import { normalizeTitleInput, sanitizeGeneratedTitle, titlePromptText } from "../../src/session/prompt"

// [TP-ST-R5-03, TP-ST-R5-04, TP-ST-R5-05, TP-ST-R6-01, TP-ST-R6-02]
test("one input normalizer preserves user paths and strips only confirmed scaffolding", () => {
  const input = [
    { type: "text", text: "ses_secret Reference preview", metadata: { titleOrigin: "reference" } },
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

test("explicitly mentioned FileParts provide local title references only", () => {
  const file = { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///fixture/notes.txt" }
  const ref = { name: "notes.txt", path: "/fixture/notes.txt" }
  expect(normalizeTitleInput([{ type: "text", text: "Review [notes](/fixture/notes.txt)" }, file]).references).toEqual([ref])
  expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt" }, file]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "Review notes" }, file]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "Review /fixture/notes.txt" }, { ...file, url: "data:text/plain;base64,c2VjcmV0", source: { type: "file", path: ref.path } }]).references).toEqual([ref])
  expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt" }, { ...file, url: "data:text/plain;base64,c2VjcmV0" }]).references).toBeUndefined()
  for (const mime of ["image/png", "image/svg+xml", "application/pdf", "audio/wav", "video/mp4", "application/octet-stream"]) {
    expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt" }, { ...file, mime, source: { type: "file", path: ref.path } }]).references).toBeUndefined()
  }
  expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt" }, { ...file, source: { type: "file", path: "/other/notes.txt" } }]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt" }, { ...file, source: { type: "resource", uri: "remote://notes" } }]).references).toBeUndefined()
  for (const origin of ["scheduled", "forwarded"]) {
    expect(normalizeTitleInput([{ type: "text", text: "Review notes.txt", metadata: { titleOrigin: origin } }, file])).toMatchObject({ hasInput: false, canGenerate: false, fallback: "Untitled" })
  }
})

test("file references require a complete path token or a verified source span", () => {
  for (const [name, text] of [["test", "latest changes"], ["test", "test the flow"], ["a", "a lot of work"], ["src", "inspect src today"]]) {
    expect(normalizeTitleInput([{ type: "text", text }, { type: "file", mime: "text/plain", filename: name, url: `file:///fixture/${name}` }]).references).toBeUndefined()
  }
  const file = { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///fixture/notes.txt" }
  for (const text of ["/fixture/notes.txt.bak", "file:///fixture/notes.txt.bak", "x/fixture/notes.txt", "https://host/fixture/notes.txt", "/fixture/notes.txt/child"]) {
    expect(normalizeTitleInput([{ type: "text", text }, file]).references).toBeUndefined()
  }
  for (const text of ["Review /fixture/notes.txt", "Review `/fixture/notes.txt`", "[notes](file:///fixture/notes.txt)"]) {
    expect(normalizeTitleInput([{ type: "text", text }, file]).references).toEqual([{ name: "notes.txt", path: "/fixture/notes.txt" }])
  }
  const source = { type: "file", path: "/fixture/notes.txt", text: { value: "@notes", start: 9, end: 15 } }
  expect(normalizeTitleInput([{ type: "text", text: "  Review @notes" }, { ...file, source }]).references).toHaveLength(1)
  expect(normalizeTitleInput([{ type: "text", text: "  Review other!" }, { ...file, source }]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "  Review @notes", synthetic: true }, { ...file, source }]).references).toBeUndefined()
  expect(normalizeTitleInput([{ type: "text", text: "\r\nReview @notes" }, { ...file, source }]).references).toHaveLength(1)
  const command = { type: "text", text: "/review @notes", metadata: { titleCommandPrefixes: ["review"] } }
  expect(normalizeTitleInput([command, { ...file, source: { ...source, text: { value: "/review", start: 0, end: 7 } } }], ["review"]).references).toBeUndefined()
  expect(normalizeTitleInput([command, { ...file, source: { ...source, text: { value: "@notes", start: 8, end: 14 } } }], ["review"]).references).toHaveLength(1)
})

test("mixed injected envelopes do not suppress genuine user text", () => {
  const file = { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///fixture/notes.txt" }
  for (const envelope of [
    { type: "text", text: "forwarded details", metadata: { titleOrigin: "forwarded" } },
    { type: "text", text: "scheduled details", metadata: { titleOrigin: "scheduled" } },
    { type: "text", text: "<inbox>untrusted data</inbox>", synthetic: true },
    { type: "text", text: "<scheduled-task>untrusted data</scheduled-task>" },
  ]) {
    expect(normalizeTitleInput([envelope, file])).toMatchObject({ hasInput: false, canGenerate: false })
    expect(normalizeTitleInput([envelope, { type: "text", text: "Fix API 404" }, file])).toMatchObject({ text: "Fix API 404", fallback: "Fix API 404", hasInput: true, canGenerate: true })
    expect(normalizeTitleInput([envelope, { type: "text", text: "Fix API 404" }, file]).references).toBeUndefined()
  }
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
