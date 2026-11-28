// JSON helpers shared by the Connect client.
//
// Connect signs and digests request bodies as RFC 8785 canonical JSON (JCS).
// Bodies sent by this client only contain objects, arrays, strings, safe
// integers, booleans and null, so the number rule reduces to "integers only";
// anything else is rejected rather than serialized differently from the service.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function canonical(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical JSON only carries safe integers")
    return String(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  // JCS orders object members by the UTF-16 code units of their names.
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, "base64url"))
}

export async function sha256(bytes: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input))
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

export class WireJsonTooDeep extends Error {}

/** UTF-8 failures and a leading BOM are not rewritten into valid JSON. */
export function decodeWireUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Strict integer JSON object; check the entire wire text before classifying a depth failure. */
export function parseObject(text: string, maxDepth = Infinity): Record<string, unknown> {
  const scan = scanWireJson(text)
  if (!scan.object || !scan.integers) throw new SyntaxError("invalid wire JSON object")
  if (scan.depth > maxDepth) throw new WireJsonTooDeep("wire JSON too deep")
  return JSON.parse(text)
}

/** A control frame or a bus line. The caller owns depth discard and its diagnostic. */
export function parseWireFrame(text: string, bus: boolean): unknown {
  const scan = scanWireJson(text)
  if (!bus && !scan.integers) throw new SyntaxError("invalid wire JSON number")
  const value: unknown = JSON.parse(text)
  // Bus lines beyond mirror depth use general JSON number syntax even when not mirror-rows.
  // Within that depth, only decoded text/mirror-rows publications use the general syntax.
  if (bus && !scan.integers && scan.depth <= 68 && !isMirrorRowsPublication(value)) {
    throw new SyntaxError("invalid wire JSON number")
  }
  return value
}

function isMirrorRowsPublication(value: unknown): boolean {
  const push = object(object(value)?.push)
  const data = object(object(push?.pub)?.data)
  return data?.lane === "text" && object(data.frame)?.type === "mirror-rows"
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Iterative lexical pass: number spelling and duplicate names are lost by JSON.parse. */
function scanWireJson(text: string): { object: boolean; depth: number; integers: boolean } {
  const whitespace = /[ \t\r\n]*/y
  const string = /"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
  const atom = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y
  const loneSurrogate = /[\uD800-\uDFFF]/u
  const unsignedInteger = /^(?:0|[1-9][0-9]*)$/
  const open: (Set<string> | null)[] = [] // null = array
  let at = 0
  let depth = 0
  let integers = true

  function invalid(): never {
    throw new SyntaxError("invalid wire JSON")
  }
  function space(): void {
    whitespace.lastIndex = at
    whitespace.test(text)
    at = whitespace.lastIndex
  }
  function readString(key: boolean): string {
    string.lastIndex = at
    const token = string.exec(text)?.[0]
    if (token == null) invalid()
    at = string.lastIndex
    // The Unicode regex sees pairs as one code point. Unpaired escaped or raw surrogates are not wire strings.
    const decoded: string = key || token.includes("\\u") ? JSON.parse(token) : token
    if (loneSurrogate.test(decoded)) invalid()
    return decoded
  }
  function member(keys: Set<string>): void {
    space()
    const key = readString(true)
    if (keys.has(key)) invalid()
    keys.add(key)
    space()
    if (text[at++] !== ":") invalid()
  }
  function value(): void {
    for (;;) {
      space()
      const first = text[at]
      if (first === "{" || first === "[") {
        at++
        depth = Math.max(depth, open.length + 1)
        space()
        if (text[at] === (first === "{" ? "}" : "]")) {
          at++
          return
        }
        const keys = first === "{" ? new Set<string>() : null
        open.push(keys)
        if (keys) member(keys)
        continue
      }
      if (first === '"') {
        readString(false)
        return
      }
      atom.lastIndex = at
      const token = atom.exec(text)?.[0]
      if (token == null) invalid()
      at = atom.lastIndex
      if (first !== "t" && first !== "f" && first !== "n") {
        integers &&= unsignedInteger.test(token) && Number.isSafeInteger(Number(token))
      }
      return
    }
  }

  space()
  const rootObject = text[at] === "{"
  for (;;) {
    value()
    for (;;) {
      space()
      if (open.length === 0) {
        if (at !== text.length) invalid()
        return { object: rootObject, depth, integers }
      }
      const keys = open.at(-1)!
      const delimiter = text[at++]
      if (delimiter === (keys ? "}" : "]")) {
        open.pop()
        continue
      }
      if (delimiter !== ",") invalid()
      if (keys) member(keys)
      break
    }
  }
}

/**
 * Whether `value` stays within `maxDepth` nesting levels (root object/array is
 * level 1; each nested object or array adds 1, connect-protocol R63).
 */
export function withinDepth(value: unknown, maxDepth: number): boolean {
  if (typeof value !== "object" || value === null) return true
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > maxDepth) return false
    const node = current.node
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === "object" && item !== null) stack.push({ node: item, depth: current.depth + 1 })
      }
    } else if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node)) {
        if (typeof item === "object" && item !== null) stack.push({ node: item, depth: current.depth + 1 })
      }
    }
  }
  return true
}
