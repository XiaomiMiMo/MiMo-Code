// Fetch a provider's model catalog directly from its HTTP endpoint during the
// custom-provider setup wizard. The TUI runs in a Bun process with full network
// access (no CORS), so we can hit `{baseURL}/models` with the key the user just
// typed — no server round-trip and no SDK regeneration required.
//
// Two wire formats are covered, selected by the AI-SDK adapter package:
//   - @ai-sdk/anthropic → Anthropic's /v1/models (x-api-key + anthropic-version),
//     response items carry `display_name`.
//   - everything else (@ai-sdk/openai, @ai-sdk/openai-compatible) → OpenAI-style
//     /v1/models (Bearer auth), response items carry only `id`.
// Both return `{ data: [{ id }] }`, so parsing is shared.

export interface ProviderModel {
  id: string
  name: string
}

const ANTHROPIC_VERSION = "2023-06-01"
const FETCH_TIMEOUT_MS = 8000

export async function fetchProviderModels(adapter: string, baseURL: string, apiKey: string): Promise<ProviderModel[]> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`
  const headers: Record<string, string> =
    adapter === "@ai-sdk/anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${apiKey}` }

  const response = await fetch(url, {
    headers: { ...headers, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new Error(`Model list request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }

  const json = (await response.json()) as
    | { data?: { id?: string; display_name?: string; name?: string }[] }
    | { id?: string; display_name?: string; name?: string }[]
  const data = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : []
  return data
    .filter(
      (item): item is { id: string; display_name?: string; name?: string } =>
        typeof item.id === "string" && item.id.length > 0,
    )
    .map((item) => ({ id: item.id, name: item.display_name ?? item.name ?? item.id }))
}
