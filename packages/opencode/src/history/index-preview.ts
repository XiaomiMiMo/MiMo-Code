import { previewToolOutput } from "../tool/truncate"

/** History index preview — same pure path as tool call results (`tool/truncate.previewToolOutput`). */
export function previewForIndex(text: string): string {
  return previewToolOutput(text).content
}

export function boundedJson(value: unknown): string {
  return previewForIndex(JSON.stringify(value ?? ""))
}

export { previewToolOutput }
export { MAX_BYTES as INDEX_MAX_BYTES, MAX_LINES as INDEX_MAX_LINES } from "../tool/truncate"
