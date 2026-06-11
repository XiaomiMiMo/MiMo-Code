import { timingSafeEqual } from "node:crypto"

export function timingSafeStringEqual(input: string, expected: string) {
  const inputBytes = Buffer.from(input)
  const expectedBytes = Buffer.from(expected)

  if (inputBytes.byteLength !== expectedBytes.byteLength) {
    timingSafeEqual(expectedBytes, expectedBytes)
    return false
  }

  return timingSafeEqual(inputBytes, expectedBytes)
}
