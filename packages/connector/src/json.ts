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

export function fromBase64url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"))
}

export async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input))
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

/** Parse a JSON object; anything else (array, scalar, malformed text) is rejected. */
export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object")
  return value as Record<string, unknown>
}
