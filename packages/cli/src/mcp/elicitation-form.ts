/**
 * Form-mode MCP elicitation (spec 2025-11-25, client/elicitation): a server
 * sends a flat `requestedSchema` whose properties are primitives (string,
 * number/integer, boolean) or enums (single- or multi-select). This module
 * turns such a form into questions and the answers back into an
 * `ElicitResult`, validating every value against the schema. Anything it cannot
 * represent or validate is reported, never guessed.
 */

export * as McpElicitationForm from "./elicitation-form"

export const ACCEPT = "Accept"
export const DECLINE = "Decline"
export const CANCEL = "Cancel"
export const SUBMIT = "Submit"
export const SKIP = "Skip"
export const YES = "Yes"
export const NO = "No"

export type Value = string | number | boolean | string[]
export type Content = Record<string, Value>
export type Result = { action: "accept"; content: Content } | { action: "decline" } | { action: "cancel" }

export interface QuestionOption {
  label: string
  description: string
}
export interface Question {
  key: string
  header: string
  question: string
  options: QuestionOption[]
  multiple: boolean
  custom: boolean
}

type Choice = { value: string; title: string }
type Field =
  | { kind: "string"; name: string; title: string; description?: string; required: boolean; default?: string
      minLength?: number; maxLength?: number; pattern?: string; format?: string }
  | { kind: "number"; name: string; title: string; description?: string; required: boolean; default?: number
      integer: boolean; minimum?: number; maximum?: number }
  | { kind: "boolean"; name: string; title: string; description?: string; required: boolean; default?: boolean }
  | { kind: "enum"; name: string; title: string; description?: string; required: boolean; default?: string; choices: Choice[] }
  | { kind: "multi"; name: string; title: string; description?: string; required: boolean; default?: string[]
      choices: Choice[]; minItems?: number; maxItems?: number }

export interface Form {
  readonly fields: readonly Field[]
  readonly questions: readonly Question[]
  /** Map answers (one entry per question, as returned by the question service) to a result. */
  decode(answers: ReadonlyArray<ReadonlyArray<string>>): Result | { error: string }
  /** Validate structured content supplied directly by a client. */
  validate(content: unknown): { ok: true; content: Content } | { ok: false; error: string }
}

const FORMATS = new Set(["email", "uri", "date", "date-time"])

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined)
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function choices(schema: Record<string, unknown>): Choice[] | undefined {
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.every((item) => typeof item === "string")) return undefined
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : undefined
    return (schema.enum as string[]).map((value, i) => ({ value, title: text(names?.[i]) ?? value }))
  }
  const list = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (!list) return undefined
  const out: Choice[] = []
  for (const item of list) {
    const entry = record(item)
    if (!entry || typeof entry.const !== "string") return undefined
    out.push({ value: entry.const, title: text(entry.title) ?? entry.const })
  }
  return out
}

function field(name: string, raw: unknown, required: boolean): Field | string {
  const schema = record(raw)
  if (!schema) return `property "${name}" is not a schema object`
  const title = text(schema.title) || name
  const description = text(schema.description)
  const base = { name, title, ...(description ? { description } : {}), required }
  if (schema.type === "string") {
    const options = choices(schema)
    if (options) {
      if (!options.length) return `property "${name}" has no choices`
      const value = text(schema.default)
      return { kind: "enum", ...base, choices: options, ...(value !== undefined ? { default: value } : {}) }
    }
    if (schema.oneOf !== undefined || schema.anyOf !== undefined || schema.enum !== undefined)
      return `property "${name}" has unsupported choices`
    const format = text(schema.format)
    if (format !== undefined && !FORMATS.has(format)) return `property "${name}" has unsupported format "${format}"`
    const pattern = text(schema.pattern)
    if (pattern !== undefined) {
      try {
        new RegExp(pattern, "u")
      } catch {
        return `property "${name}" has an invalid pattern`
      }
    }
    const value = text(schema.default)
    return {
      kind: "string", ...base,
      ...(value !== undefined ? { default: value } : {}),
      ...(count(schema.minLength) !== undefined ? { minLength: count(schema.minLength) } : {}),
      ...(count(schema.maxLength) !== undefined ? { maxLength: count(schema.maxLength) } : {}),
      ...(pattern !== undefined ? { pattern } : {}),
      ...(format !== undefined ? { format } : {}),
    }
  }
  if (schema.type === "number" || schema.type === "integer") {
    const value = finite(schema.default)
    return {
      kind: "number", ...base, integer: schema.type === "integer",
      ...(value !== undefined ? { default: value } : {}),
      ...(finite(schema.minimum) !== undefined ? { minimum: finite(schema.minimum) } : {}),
      ...(finite(schema.maximum) !== undefined ? { maximum: finite(schema.maximum) } : {}),
    }
  }
  if (schema.type === "boolean") {
    return { kind: "boolean", ...base, ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) }
  }
  if (schema.type === "array") {
    const items = record(schema.items)
    const options = items && (items.type === "string" || items.type === undefined) ? choices(items) : undefined
    if (!options?.length) return `property "${name}" is an array without enum items`
    const value = Array.isArray(schema.default) && schema.default.every((item) => typeof item === "string")
      ? (schema.default as string[]) : undefined
    return {
      kind: "multi", ...base, choices: options,
      ...(value ? { default: value } : {}),
      ...(count(schema.minItems) !== undefined ? { minItems: count(schema.minItems) } : {}),
      ...(count(schema.maxItems) !== undefined ? { maxItems: count(schema.maxItems) } : {}),
    }
  }
  return `property "${name}" has unsupported type`
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u

function checkFormat(format: string, value: string) {
  if (format === "email") return EMAIL.test(value)
  if (format === "uri") {
    try {
      return new URL(value).protocol.length > 1
    } catch {
      return false
    }
  }
  if (format === "date") return DATE.test(value) && !Number.isNaN(Date.parse(value))
  if (format === "date-time") return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))
  return false
}

/** Validate one value; returns an error message or undefined. */
function check(item: Field, value: unknown): string | undefined {
  const name = `"${item.name}"`
  switch (item.kind) {
    case "string": {
      if (typeof value !== "string") return `${name} must be a string`
      const length = [...value].length
      if (item.minLength !== undefined && length < item.minLength) return `${name} is too short`
      if (item.maxLength !== undefined && length > item.maxLength) return `${name} is too long`
      if (item.pattern !== undefined && !new RegExp(item.pattern, "u").test(value)) return `${name} does not match the pattern`
      if (item.format !== undefined && !checkFormat(item.format, value)) return `${name} is not a valid ${item.format}`
      return
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`
      if (item.integer && !Number.isInteger(value)) return `${name} must be an integer`
      if (item.minimum !== undefined && value < item.minimum) return `${name} is below the minimum`
      if (item.maximum !== undefined && value > item.maximum) return `${name} is above the maximum`
      return
    case "boolean":
      return typeof value === "boolean" ? undefined : `${name} must be a boolean`
    case "enum":
      return typeof value === "string" && item.choices.some((choice) => choice.value === value)
        ? undefined : `${name} is not one of the allowed values`
    case "multi": {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return `${name} must be a list`
      if (new Set(value).size !== value.length) return `${name} has duplicate values`
      if (!value.every((entry) => item.choices.some((choice) => choice.value === entry)))
        return `${name} has a value that is not allowed`
      if (item.minItems !== undefined && value.length < item.minItems) return `${name} has too few values`
      if (item.maxItems !== undefined && value.length > item.maxItems) return `${name} has too many values`
      return
    }
  }
}

/** Unique, non-empty option labels for choices; titles that collide get their value appended. */
function labels(list: Choice[], reserved: readonly string[]) {
  const seen = new Map<string, number>()
  for (const choice of list) seen.set(choice.title, (seen.get(choice.title) ?? 0) + 1)
  return list.map((choice) =>
    (seen.get(choice.title) ?? 0) > 1 || reserved.includes(choice.title) || !choice.title.trim()
      ? `${choice.title} (${choice.value})` : choice.title,
  )
}

function describe(item: Field) {
  const parts = [item.description]
  if (item.default !== undefined) parts.push(`Default: ${Array.isArray(item.default) ? item.default.join(", ") : String(item.default)}`)
  return parts.filter(Boolean).join("\n")
}

function prompt(server: string, message: string, extra?: string) {
  return [server, message, extra].filter((part) => typeof part === "string" && part.trim()).join("\n\n")
}

/**
 * Build the questions for a form request. Returns a string describing why the
 * schema cannot be presented when it falls outside the spec's flat subset.
 */
export function build(server: string, message: string, schema: unknown, subtitle?: string): Form | string {
  const root = record(schema)
  if (!root || root.type !== "object") return "requestedSchema must be an object schema"
  const properties = record(root.properties) ?? {}
  const required = Array.isArray(root.required) ? root.required : []
  if (!required.every((name) => typeof name === "string" && Object.hasOwn(properties, name)))
    return "requestedSchema.required names a property that does not exist"
  const fields: Field[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const item = field(name, raw, required.includes(name))
    if (typeof item === "string") return item
    fields.push(item)
  }

  const validate = (content: unknown): { ok: true; content: Content } | { ok: false; error: string } => {
    const value = record(content)
    if (!value) return { ok: false, error: "content must be an object" }
    const out: Content = {}
    for (const key of Object.keys(value)) {
      if (!fields.some((item) => item.name === key)) return { ok: false, error: `unexpected property "${key}"` }
    }
    for (const item of fields) {
      if (!Object.hasOwn(value, item.name) || value[item.name] === undefined) {
        if (item.required) return { ok: false, error: `"${item.name}" is required` }
        continue
      }
      const error = check(item, value[item.name])
      if (error) return { ok: false, error }
      out[item.name] = value[item.name] as Value
    }
    return { ok: true, content: out }
  }

  // Empty form: a plain confirmation.
  if (!fields.length) {
    return {
      fields,
      questions: [{
        key: "mcp_elicitation",
        header: server,
        question: prompt(server, message, subtitle),
        options: [ACCEPT, DECLINE, CANCEL].map((label) => ({ label, description: "" })),
        multiple: false,
        custom: false,
      }],
      decode(answers) {
        const answer = answers.length === 1 && answers[0].length === 1 ? answers[0][0] : undefined
        if (answer === ACCEPT) return { action: "accept", content: {} }
        if (answer === DECLINE) return { action: "decline" }
        return { action: "cancel" }
      },
      validate,
    }
  }

  // One required single choice: the choices themselves answer the form, plus Decline.
  const only = fields.length === 1 ? fields[0] : undefined
  if (only && only.required && (only.kind === "enum" || only.kind === "boolean")) {
    const list: Choice[] = only.kind === "enum"
      ? only.choices
      : [{ value: "true", title: YES }, { value: "false", title: NO }]
    const names = labels(list, [DECLINE])
    return {
      fields,
      questions: [{
        key: "mcp_elicitation",
        header: only.title,
        question: prompt(server, message, [only.description, subtitle].filter(Boolean).join("\n\n")),
        options: [
          ...names.map((label, i) => ({
            label,
            description: list[i].value === (only.default === undefined ? undefined : String(only.default)) ? "Default" : "",
          })),
          { label: DECLINE, description: "" },
        ],
        multiple: false,
        custom: false,
      }],
      decode(answers) {
        const answer = answers.length === 1 && answers[0].length === 1 ? answers[0][0] : undefined
        if (answer === DECLINE) return { action: "decline" }
        const index = answer === undefined ? -1 : names.indexOf(answer)
        if (index < 0) return { action: "cancel" }
        const value = only.kind === "boolean" ? list[index].value === "true" : list[index].value
        return { action: "accept", content: { [only.name]: value } }
      },
      validate,
    }
  }

  // General form: one question per field, then Submit / Decline.
  const optional = (item: Field) => (item.required ? [] : [{ label: SKIP, description: "Leave this field empty" }])
  const plan = fields.map((item) => {
    if (item.kind === "enum" || item.kind === "multi") {
      const names = labels(item.choices, [SKIP])
      return {
        names,
        question: {
          key: "mcp_elicitation_field",
          header: item.title,
          question: describe(item) || item.title,
          options: [
            ...names.map((label) => ({ label, description: "" })),
            ...(item.kind === "enum" ? optional(item) : []),
          ],
          multiple: item.kind === "multi",
          custom: false,
        } satisfies Question,
      }
    }
    if (item.kind === "boolean") {
      return {
        names: [YES, NO],
        question: {
          key: "mcp_elicitation_field",
          header: item.title,
          question: describe(item) || item.title,
          options: [{ label: YES, description: "" }, { label: NO, description: "" }, ...optional(item)],
          multiple: false,
          custom: false,
        } satisfies Question,
      }
    }
    const fallback = item.default !== undefined ? [{ label: String(item.default), description: "Default" }] : []
    return {
      names: [] as string[],
      question: {
        key: "mcp_elicitation_field",
        header: item.title,
        question: describe(item) || item.title,
        options: [...fallback, ...optional(item)],
        multiple: false,
        custom: true,
      } satisfies Question,
    }
  })
  const questions: Question[] = [
    ...plan.map((entry) => entry.question),
    {
      key: "mcp_elicitation",
      header: server,
      question: prompt(server, message, subtitle),
      options: [{ label: SUBMIT, description: "" }, { label: DECLINE, description: "" }],
      multiple: false,
      custom: false,
    },
  ]
  return {
    fields,
    questions,
    decode(answers) {
      if (answers.length !== questions.length) return { action: "cancel" }
      const action = answers[answers.length - 1]
      if (action.length === 1 && action[0] === DECLINE) return { action: "decline" }
      if (action.length !== 1 || action[0] !== SUBMIT) return { action: "cancel" }
      const content: Record<string, unknown> = {}
      for (const [i, item] of fields.entries()) {
        const answer = answers[i]
        const { names } = plan[i]
        if (item.kind === "multi") {
          const picked: string[] = []
          for (const label of answer) {
            const index = names.indexOf(label)
            if (index < 0) return { error: `"${item.name}" has an unknown choice` }
            picked.push(item.choices[index].value)
          }
          if (picked.length || item.required) content[item.name] = picked
          continue
        }
        if (answer.length === 0 || (answer.length === 1 && answer[0] === SKIP && !item.required)) continue
        if (answer.length !== 1) return { error: `"${item.name}" needs exactly one answer` }
        const value = answer[0]
        if (item.kind === "enum") {
          const index = names.indexOf(value)
          if (index < 0) return { error: `"${item.name}" has an unknown choice` }
          content[item.name] = item.choices[index].value
        } else if (item.kind === "boolean") {
          if (value !== YES && value !== NO) return { error: `"${item.name}" must be Yes or No` }
          content[item.name] = value === YES
        } else if (item.kind === "number") {
          const trimmed = value.trim()
          const parsed = trimmed === "" ? Number.NaN : Number(trimmed)
          if (!Number.isFinite(parsed)) return { error: `"${item.name}" must be a number` }
          content[item.name] = parsed
        } else {
          content[item.name] = value
        }
      }
      const checked = validate(content)
      if (!checked.ok) return { error: checked.error }
      return { action: "accept", content: checked.content }
    },
    validate,
  }
}
