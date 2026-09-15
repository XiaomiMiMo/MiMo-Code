import { cleanDataUrls } from "./media"
import { previewToolOutput } from "../tool/truncate"

/**
 * History index preview — same pure path as tool call results
 * (`tool/truncate.previewToolOutput`). Strip data-URLs first so binary
 * payloads do not consume the tool-result byte/line budget.
 */
export function previewForIndex(text: string): string {
  return previewToolOutput(cleanDataUrls(text, undefined, "index")).content
}

export function boundedJson(value: unknown): string {
  return previewForIndex(JSON.stringify(value ?? ""))
}

export { previewToolOutput }
export { MAX_BYTES as INDEX_MAX_BYTES, MAX_LINES as INDEX_MAX_LINES } from "../tool/truncate"
