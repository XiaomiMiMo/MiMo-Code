import { isRecord } from "../util/record"

/**
 * Repairs the malformed `actor` argument shapes models actually emit, so a call
 * that is semantically correct but structurally off still reaches execution
 * instead of dying in schema validation.
 *
 * Repairs, applied in order:
 *  1. a stringified `operation` envelope
 *     (`{"operation":"{\"action\":\"spawn\",...}"}`), including envelopes whose
 *     raw CR/LF/TAB make them invalid JSON until those characters are escaped;
 *  2. a top-level `subagent_type` that belongs inside `operation`;
 *  3. a flat bag with no `operation` key at all
 *     (`{"action":"spawn","subagent_type":"general",...}`), defaulting `action`
 *     to `spawn`.
 *
 * Pure and conservative: it never mutates its input, returns the value by
 * reference when no repair applies, and leaves anything it cannot repair
 * untouched so the schema still reports the original error. It never invents
 * or relaxes a value — an unknown `subagent_type` or an unparseable payload
 * still fails validation.
 */
export function coerceActorArguments(value: unknown): unknown {
  if (!isRecord(value)) return value
  return wrapFlatOperation(moveStraySubagentType(parseStringifiedOperation(value)))
}

/** Repair 1: parse `operation` when the model stringified the envelope. */
function parseStringifiedOperation(value: Record<string, unknown>): Record<string, unknown> {
  const operation = value.operation
  if (typeof operation !== "string") return value
  const parsed = parseEnvelope(operation)
  // Unparseable: return the value untouched so validation reports the real
  // problem instead of a silently empty envelope.
  if (!parsed) return value
  return { ...value, operation: parsed }
}

const RAW_WHITESPACE_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" }

function parseEnvelope(text: string): Record<string, unknown> | undefined {
  const direct = tryParseObject(text)
  if (direct) return direct
  // A raw newline/tab inside a JSON string is illegal, and models emit prompts
  // and descriptions with embedded line breaks. Escape them and retry once.
  const escaped = text.replace(/[\n\r\t]/g, (char) => RAW_WHITESPACE_ESCAPES[char] ?? char)
  if (escaped === text) return undefined
  return tryParseObject(escaped)
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Repair 2: a `subagent_type` sitting beside `operation` moves into it. */
function moveStraySubagentType(value: Record<string, unknown>): Record<string, unknown> {
  const operation = value.operation
  if (!isRecord(operation) || !("subagent_type" in value)) return value
  const { subagent_type: stray, ...rest } = value
  // An explicit nested value wins: the stray key is only dropped, never allowed
  // to override what the envelope already says.
  const merged = operation.subagent_type === undefined ? { ...operation, subagent_type: stray } : operation
  return { ...rest, operation: merged }
}

/** Repair 3: a flat bag with no `operation` key is wrapped in the envelope. */
function wrapFlatOperation(value: Record<string, unknown>): Record<string, unknown> {
  if ("operation" in value) return value
  if (!("action" in value) && !("subagent_type" in value)) return value
  const { action, ...rest } = value
  return { operation: { action: action ?? "spawn", ...rest } }
}
