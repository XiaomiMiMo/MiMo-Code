export const TEXT_LOOP_BUFFER_SIZE = 5
export const TEXT_LOOP_TRIGGER_COUNT = 3
export const TEXT_LOOP_MAX_RECOVERY = 0

export function normalizeForLoopDetection(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(let me |i'll |i will |let's )/i, "")
    .slice(0, 200)
}

export function detectTextLoop(buffer: string[], triggerCount: number): boolean {
  if (buffer.length < triggerCount) return false
  const tail = buffer.slice(-triggerCount)
  return tail.every((t) => t === tail[0])
}
