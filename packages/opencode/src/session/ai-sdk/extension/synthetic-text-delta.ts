import type { SyntheticTextDelta } from "./types"

/**
 * Wrap a `toTextDelta` chunk into the Renderer's `SyntheticTextDelta` part so
 * the JSON output can record that a provider text chunk was synthesized into
 * a single part, and so the UI stream can emit a balanced
 * `text-start`/`text-delta`/`text-end` triple around it.
 */
export function makeSyntheticTextDelta(text: string): SyntheticTextDelta {
  return {
    type: "synthetic",
    syntheticType: "text-delta",
    text,
    source: "ai-sdk",
  }
}
