import type { JSONSchema7 } from "@ai-sdk/provider"
import { isRecord } from "./record"

/** Collapse PascalCase, camelCase, snake_case, and kebab-case to one comparable token. */
export function canonical(name: string): string {
  return name.replace(/[-_\s]+/g, "").toLowerCase()
}

/** Resolve a model-provided identifier to a registered name when casing or separators differ. */
export function resolveName(name: string, candidates: readonly string[]): string | undefined {
  if (candidates.includes(name)) return name

  const lower = name.toLowerCase()
  const caseMatch = candidates.find((candidate) => candidate.toLowerCase() === lower)
  if (caseMatch) return caseMatch

  const key = canonical(name)
  return candidates.find((candidate) => canonical(candidate) === key)
}

export function schemaPropertyKeys(schema: JSONSchema7): string[] {
  if (!isRecord(schema.properties)) return []
  return Object.keys(schema.properties)
}

function combinedSchemas(schema: JSONSchema7): JSONSchema7[] {
  const out: JSONSchema7[] = []
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branch = schema[key]
    if (!Array.isArray(branch)) continue
    for (const entry of branch) {
      if (typeof entry === "object" && entry !== null) out.push(entry as JSONSchema7)
    }
  }
  return out
}

function normalizeValue(value: unknown, schema: JSONSchema7 | undefined): unknown {
  if (!schema) return value

  if (Array.isArray(value)) {
    const items = schema.items
    const itemSchema =
      typeof items === "object" && items !== null && !Array.isArray(items) ? (items as JSONSchema7) : undefined
    if (!itemSchema) return value
    return value.map((entry) => normalizeValue(entry, itemSchema))
  }

  if (isRecord(value)) return normalizeInput(value, schema)

  return value
}

/** Remap object keys to the schema's canonical property names, recursively. */
export function normalizeInput(input: unknown, schema: JSONSchema7): unknown {
  if (!isRecord(input)) return input

  const propertyKeys = schemaPropertyKeys(schema)
  const combinedBranches = combinedSchemas(schema)
  if (propertyKeys.length === 0 && combinedBranches.length === 0) return input

  const properties = isRecord(schema.properties) ? schema.properties : {}
  const byCanonical = new Map(propertyKeys.map((key) => [canonical(key), key]))
  const propertyKeySet = new Set(propertyKeys)
  const exactKeys = new Set<string>()
  const normalized: Record<string, unknown> = {}

  const childSchemaFor = (key: string): JSONSchema7 | undefined => {
    const propertySchema = properties[key]
    return typeof propertySchema === "object" && propertySchema !== null ? (propertySchema as JSONSchema7) : undefined
  }

  // Pass 1: exact matches always win over aliases regardless of iteration order.
  for (const [key, value] of Object.entries(input)) {
    if (!propertyKeySet.has(key)) continue
    normalized[key] = normalizeValue(value, childSchemaFor(key))
    exactKeys.add(key)
  }

  // Pass 2: alias keys only fill slots not claimed by an exact match.
  for (const [key, value] of Object.entries(input)) {
    if (propertyKeySet.has(key)) continue
    const resolvedKey = byCanonical.get(canonical(key))
    if (resolvedKey) {
      if (exactKeys.has(resolvedKey) || resolvedKey in normalized) continue
      normalized[resolvedKey] = normalizeValue(value, childSchemaFor(resolvedKey))
      continue
    }
    normalized[key] = value
  }

  // Recurse into combinator branches (allOf/anyOf/oneOf) so nested properties
  // declared via composition are also normalized.
  let result: Record<string, unknown> = normalized
  for (const branch of combinedBranches) {
    const next = normalizeInput(result, branch)
    if (isRecord(next)) result = next
  }

  return result
}

// Repair `\uXXXX` escapes whose 4 hex digits were split by injected whitespace
// (e.g. a CJK char `\u7ed1` arriving as `\u7 ed1` when a streaming/router
// boundary cuts the 6-char escape and rejoins it with a space). We walk each
// `\u`, then pull the next 4 hex digits, tolerating whitespace between them, and
// re-emit a clean `\uXXXX`. Anything that isn't a recoverable 4-hex escape is
// left byte-for-byte unchanged so valid content and other escapes are untouched.
function repairUnicodeEscapes(input: string): string {
  if (!input.includes("\\u")) return input
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch !== "\\") {
      out += ch
      i++
      continue
    }
    const next = input[i + 1]
    // Preserve escaped backslash so `\\u...` (a literal backslash + u) is not
    // mistaken for a unicode escape.
    if (next === "\\") {
      out += "\\\\"
      i += 2
      continue
    }
    if (next !== "u") {
      out += ch
      i++
      continue
    }
    // Collect up to 4 hex digits after `\u`, skipping interleaved whitespace.
    let j = i + 2
    const hex: string[] = []
    while (j < input.length && hex.length < 4) {
      const c = input[j]
      if (/[0-9a-fA-F]/.test(c)) {
        hex.push(c)
        j++
        continue
      }
      if (/\s/.test(c)) {
        j++
        continue
      }
      break
    }
    if (hex.length === 4) {
      out += "\\u" + hex.join("")
      i = j
      continue
    }
    // Not a recoverable escape — leave the `\u` as-is and move on.
    out += ch
    i++
  }
  return out
}

export function parseToolInput(input: string): unknown {
  if (input.trim() === "") return {}
  try {
    return JSON.parse(input) as unknown
  } catch {
    const repaired = repairUnicodeEscapes(input)
    if (repaired !== input) {
      try {
        return JSON.parse(repaired) as unknown
      } catch {
        return input
      }
    }
    return input
  }
}

export function stringifyToolInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input)
}

export type RepairToolCallInput = {
  toolName: string
  input: string
  toolNames: readonly string[]
  getSchema: (toolName: string) => JSONSchema7 | PromiseLike<JSONSchema7>
}

export type RepairedToolCall = {
  toolName: string
  input: string
}

/** Repair tool name and/or argument keys so AI SDK validation can succeed. */
export async function repairToolCall(input: RepairToolCallInput): Promise<RepairedToolCall | undefined> {
  const resolvedName = resolveName(input.toolName, input.toolNames)
  if (!resolvedName) return undefined

  const schema = await Promise.resolve(input.getSchema(resolvedName))
  const parsed = parseToolInput(input.input)
  const normalized = normalizeInput(parsed, schema)
  const repairedInput = stringifyToolInput(normalized)

  if (resolvedName === input.toolName && repairedInput === input.input) return undefined

  return {
    toolName: resolvedName,
    input: repairedInput,
  }
}
