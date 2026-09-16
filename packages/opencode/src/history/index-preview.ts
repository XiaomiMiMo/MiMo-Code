import { previewToolOutput } from "../tool/truncate"
import { cleanDataUrls } from "./media"

/**
 * History index preview — same pure path as tool call results
 * (`tool/truncate.previewToolOutput`). Strip data-URLs first so binary
 * payloads do not consume the tool-result byte/line budget.
 */
export function previewForIndex(
  text: string,
  options?: Parameters<typeof previewToolOutput>[1],
): string {
  return previewToolOutput(cleanDataUrls(text, undefined, "index"), options).content
}

export function boundedJson(value: unknown, options?: Parameters<typeof previewToolOutput>[1]): string {
  return previewForIndex(JSON.stringify(value ?? ""), options)
}

export { previewToolOutput }
export { MAX_BYTES as INDEX_MAX_BYTES, MAX_LINES as INDEX_MAX_LINES } from "../tool/truncate"
