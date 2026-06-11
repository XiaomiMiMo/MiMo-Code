export function jsonByteLength(value: unknown): number {
  try {
    const str = JSON.stringify(value)
    if (typeof str !== "string") return 0
    return Buffer.byteLength(str, "utf8")
  } catch {
    return 0
  }
}
