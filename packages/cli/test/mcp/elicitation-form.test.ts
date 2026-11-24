import { describe, expect, test } from "bun:test"
import { McpElicitationForm } from "../../src/mcp/elicitation-form"

function build(schema: unknown) {
  const form = McpElicitationForm.build("recorder", "Allow access?", schema)
  if (typeof form === "string") throw new Error(form)
  return form
}

const decision = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      title: "Allow",
      oneOf: [
        { const: "once", title: "Only this time" },
        { const: "session", title: "For this task" },
        { const: "always", title: "Always" },
      ],
      default: "once",
    },
  },
  required: ["decision"],
}

describe("mcp elicitation form", () => {
  test("empty form is a plain confirmation", () => {
    const form = build({ type: "object", properties: {} })
    expect(form.questions).toHaveLength(1)
    expect(form.questions[0].options.map((option) => option.label)).toEqual(["Accept", "Decline", "Cancel"])
    expect(form.decode([["Accept"]])).toEqual({ action: "accept", content: {} })
    expect(form.decode([["Decline"]])).toEqual({ action: "decline" })
    expect(form.decode([["Cancel"]])).toEqual({ action: "cancel" })
    expect(form.decode([["other"]])).toEqual({ action: "cancel" })
  })

  test("a single required choice answers the form directly, with Decline", () => {
    const form = build(decision)
    expect(form.questions).toHaveLength(1)
    const [question] = form.questions
    expect(question.header).toBe("Allow")
    expect(question.question).toContain("recorder")
    expect(question.question).toContain("Allow access?")
    expect(question.custom).toBe(false)
    expect(question.options.map((option) => option.label)).toEqual(["Only this time", "For this task", "Always", "Decline"])
    expect(question.options[0].description).toBe("Default")
    expect(form.decode([["For this task"]])).toEqual({ action: "accept", content: { decision: "session" } })
    expect(form.decode([["Decline"]])).toEqual({ action: "decline" })
    expect(form.decode([["session"]])).toEqual({ action: "cancel" })
    expect(form.decode([])).toEqual({ action: "cancel" })
  })

  test("legacy enum and enumNames, colliding titles stay distinguishable", () => {
    const form = build({
      type: "object",
      properties: { color: { type: "string", enum: ["r", "g", "x"], enumNames: ["Red", "Same", "Same"] } },
      required: ["color"],
    })
    expect(form.questions[0].options.map((option) => option.label)).toEqual(["Red", "Same (g)", "Same (x)", "Decline"])
    expect(form.decode([["Same (x)"]])).toEqual({ action: "accept", content: { color: "x" } })
  })

  test("required boolean alone becomes Yes / No / Decline", () => {
    const form = build({ type: "object", properties: { approve: { type: "boolean", title: "Approve" } }, required: ["approve"] })
    expect(form.questions[0].options.map((option) => option.label)).toEqual(["Yes", "No", "Decline"])
    expect(form.decode([["No"]])).toEqual({ action: "accept", content: { approve: false } })
  })

  test("general forms ask each field then Submit / Decline, and validate", () => {
    const form = build({
      type: "object",
      properties: {
        name: { type: "string", title: "Name", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
        email: { type: "string", format: "email" },
        age: { type: "integer", minimum: 18, maximum: 99 },
        subscribe: { type: "boolean" },
        tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2 },
        tier: { type: "string", enum: ["free", "pro"] },
      },
      required: ["name", "age", "tags"],
    })
    expect(form.questions.map((question) => question.header)).toEqual(["Name", "email", "age", "subscribe", "tags", "tier", "recorder"])
    expect(form.questions[0].custom).toBe(true)
    expect(form.questions[1].options.map((option) => option.label)).toEqual(["Skip"])
    expect(form.questions[3].options.map((option) => option.label)).toEqual(["Yes", "No", "Skip"])
    expect(form.questions[4].multiple).toBe(true)
    expect(form.questions[5].options.map((option) => option.label)).toEqual(["free", "pro", "Skip"])
    expect(form.questions[6].options.map((option) => option.label)).toEqual(["Submit", "Decline"])

    const answers = [["abc"], ["a@b.co"], ["30"], ["Yes"], ["a", "c"], ["Skip"], ["Submit"]]
    expect(form.decode(answers)).toEqual({
      action: "accept",
      content: { name: "abc", email: "a@b.co", age: 30, subscribe: true, tags: ["a", "c"] },
    })
    expect(form.decode(answers.with(-1, ["Decline"]))).toEqual({ action: "decline" })
    expect(form.decode(answers.with(-1, []))).toEqual({ action: "cancel" })
    expect(form.decode(answers.with(0, ["ABC"]))).toEqual({ error: '"name" does not match the pattern' })
    expect(form.decode(answers.with(0, ["a"]))).toEqual({ error: '"name" is too short' })
    expect(form.decode(answers.with(1, ["nope"]))).toEqual({ error: '"email" is not a valid email' })
    expect(form.decode(answers.with(2, ["17"]))).toEqual({ error: '"age" is below the minimum' })
    expect(form.decode(answers.with(2, ["30.5"]))).toEqual({ error: '"age" must be an integer' })
    expect(form.decode(answers.with(2, ["x"]))).toEqual({ error: '"age" must be a number' })
    expect(form.decode(answers.with(4, ["a", "b", "c"]))).toEqual({ error: '"tags" has too many values' })
    expect(form.decode(answers.with(4, []))).toEqual({ error: '"tags" has too few values' })
    expect(form.decode(answers.with(4, ["z"]))).toEqual({ error: '"tags" has an unknown choice' })
    expect(form.decode(answers.with(2, []))).toEqual({ error: '"age" is required' })
    expect(form.decode(answers.slice(1))).toEqual({ action: "cancel" })
  })

  test("structured content is validated against the schema", () => {
    const form = build(decision)
    expect(form.validate({ decision: "always" })).toEqual({ ok: true, content: { decision: "always" } })
    expect(form.validate({ decision: "never" })).toEqual({ ok: false, error: '"decision" is not one of the allowed values' })
    expect(form.validate({})).toEqual({ ok: false, error: '"decision" is required' })
    expect(form.validate({ decision: "once", extra: 1 })).toEqual({ ok: false, error: 'unexpected property "extra"' })
    expect(form.validate([])).toEqual({ ok: false, error: "content must be an object" })
    const dates = build({
      type: "object",
      properties: { day: { type: "string", format: "date" }, at: { type: "string", format: "date-time" }, site: { type: "string", format: "uri" } },
    })
    expect(dates.validate({ day: "2026-11-24", at: "2026-11-24T10:00:00Z", site: "https://example.com" }).ok).toBe(true)
    expect(dates.validate({ day: "24/11/2026" }).ok).toBe(false)
    expect(dates.validate({ at: "2026-11-24" }).ok).toBe(false)
    expect(dates.validate({ site: "not a url" }).ok).toBe(false)
  })

  test("schemas outside the flat primitive subset are refused", () => {
    const refuse = (schema: unknown) => McpElicitationForm.build("recorder", "m", schema)
    expect(refuse({ type: "array" })).toBe("requestedSchema must be an object schema")
    expect(refuse({ type: "object", properties: { a: { type: "object" } } })).toBe('property "a" has unsupported type')
    expect(refuse({ type: "object", properties: { a: { type: "array", items: { type: "number" } } } })).toBe(
      'property "a" is an array without enum items',
    )
    expect(refuse({ type: "object", properties: { a: { type: "string", format: "ipv4" } } })).toBe(
      'property "a" has unsupported format "ipv4"',
    )
    expect(refuse({ type: "object", properties: { a: { type: "string", pattern: "(" } } })).toBe('property "a" has an invalid pattern')
    expect(refuse({ type: "object", properties: {}, required: ["missing"] })).toBe(
      "requestedSchema.required names a property that does not exist",
    )
  })
})
