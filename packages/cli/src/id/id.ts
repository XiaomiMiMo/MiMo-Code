import z from "zod"
import { randomBytes } from "crypto"

const prefixes = {
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
  workflow: "wf",
} as const

export function schema(prefix: keyof typeof prefixes) {
  return z.string().startsWith(prefixes[prefix])
}

// Payload after `{prefix}_` is always 26 chars.
// v1 (legacy): 12 hex (48-bit time*4096+counter) + 14 base62.
//   Date.now()*4096 is now 53 bits, so v1 kept only the low 48 and wrapped
//   every 2^36 ms (~795 days). The 26th wrap was 2026-08-14T19:19:55.136Z.
// v2: `{g|-}` + 16 hex (64-bit) + 9 base62.
//   `g` > `f` so ascending v2 sorts after every v1 id.
//   `-` < `0` so descending v2 sorts before every v1 id.
const LENGTH = 26
const TIME_BYTES = 8

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(TIME_BYTES)
  for (let i = 0; i < TIME_BYTES; i++) {
    timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
  }

  const mark = direction === "descending" ? "-" : "g"
  // Session IDs are copied into the resume command. Session lists primarily
  // order by update time, so keep this user-facing payload hexadecimal instead
  // of exposing the v2 sort marker.
  if (prefix === prefixes.session) {
    return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - TIME_BYTES * 2)
  }

  return prefix + "_" + mark + timeBytes.toString("hex") + randomBase62(LENGTH - 1 - TIME_BYTES * 2)
}

/** Extract timestamp from an ascending ID. Does not work with descending IDs. */
export function timestamp(id: string, now = Date.now()): number {
  const prefix = id.split("_")[0]
  const body = id.slice(prefix.length + 1)
  const v2 = body[0] === "g" || body[0] === "-"
  const raw = Number(BigInt("0x" + (v2 ? body.slice(1, 17) : body.slice(0, 12))) / BigInt(0x1000))
  if (v2) return raw
  // v1 stored ts % 2^36. Restore the latest cycle that does not exceed `now`.
  const cycle = 2 ** 36
  const recovered = Math.floor(now / cycle) * cycle + raw
  return recovered > now ? recovered - cycle : recovered
}

export * as Identifier from "./id"
