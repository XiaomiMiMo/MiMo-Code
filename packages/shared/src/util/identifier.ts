import { randomBytes } from "crypto"

export namespace Identifier {
  // Payload is always 26 chars. v1 was 12 hex + 14 base62 (48-bit, wraps
  // every 2^36 ms). v2 is `{g|-}` + 16 hex + 9 base62 so lexicographic order
  // stays compatible with existing v1 ids: `g` > `f`, `-` < `0`.
  const LENGTH = 26
  const TIME_BYTES = 8

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending() {
    return create(false)
  }

  export function descending() {
    return create(true)
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

  export function create(descending: boolean, timestamp?: number): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(TIME_BYTES)
    for (let i = 0; i < TIME_BYTES; i++) {
      timeBytes[i] = Number((now >> BigInt(56 - 8 * i)) & BigInt(0xff))
    }

    const mark = descending ? "-" : "g"
    return mark + timeBytes.toString("hex") + randomBase62(LENGTH - 1 - TIME_BYTES * 2)
  }
}
