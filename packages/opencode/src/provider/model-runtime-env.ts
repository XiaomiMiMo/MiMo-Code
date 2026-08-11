import type { Info as ProviderInfo, Model } from "./provider"

export const AUDIO_MODEL_RUNTIME_ENV = {
  apiKey: "MIMOCODE_AUDIO_MODEL_API_KEY",
  baseURL: "MIMOCODE_AUDIO_MODEL_BASE_URL",
  model: "MIMOCODE_AUDIO_MODEL_ID",
  provider: "MIMOCODE_AUDIO_MODEL_PROVIDER",
  kind: "MIMOCODE_AUDIO_MODEL_KIND",
  protocol: "MIMOCODE_AUDIO_MODEL_PROTOCOL",
  candidates: "MIMOCODE_AUDIO_MODEL_CANDIDATES",
} as const

export type AudioModelCandidate = {
  provider: string
  model: string
  kind: "asr" | "audio"
  protocol: "openai-chat-audio" | "openai-audio-transcriptions"
  baseURL: string
}

const ASR_MODEL_ID = /(^|[-_.])(asr|whisper|speech[-_.]?to[-_.]?text|transcri(?:be|ption))($|[-_.])/i

function candidateKind(model: Model): AudioModelCandidate["kind"] | undefined {
  if (ASR_MODEL_ID.test(model.id) || ASR_MODEL_ID.test(model.api.id)) return "asr"
  if (model.capabilities.input.audio) return "audio"
  return undefined
}

function candidateProtocol(
  model: Model,
  kind: AudioModelCandidate["kind"],
): AudioModelCandidate["protocol"] | undefined {
  const npm = model.api.npm.toLowerCase()
  const openAICompatible = npm.includes("openai") || npm.includes("openrouter")
  if (!openAICompatible) return undefined
  const id = `${model.id} ${model.api.id}`
  if (/mimo[-_.]?v?2[.]5[-_.]?asr/i.test(id)) return "openai-chat-audio"
  if (kind === "asr" && /whisper/i.test(id)) return "openai-audio-transcriptions"
  if (kind === "asr" && !model.capabilities.input.audio) return "openai-audio-transcriptions"
  return "openai-chat-audio"
}

function providerBaseURL(provider: ProviderInfo, model: Model): string {
  const configured = provider.options.baseURL
  if (typeof configured === "string" && configured.trim()) return configured.trim().replace(/\/+$/, "")
  return String(model.api.url || "").trim().replace(/\/+$/, "")
}

function rank(candidate: AudioModelCandidate): number {
  if (candidate.kind === "asr" && /(^|[-_.])mimo[-_.]?v?2[.]5[-_.]?asr($|[-_.])/i.test(candidate.model)) return 0
  if (candidate.kind === "asr") return 1
  return 2
}

/**
 * Project the active provider registry into the minimum environment needed by
 * a local audio-processing command. The complete auth store is deliberately
 * not returned: children receive one selected API credential plus public model
 * metadata, never MIMOCODE_AUTH_CONTENT.
 */
export function audioModelRuntimeEnv(
  providers: Record<string, ProviderInfo>,
): Record<string, string> {
  const candidates: Array<AudioModelCandidate & { key: string }> = []
  for (const provider of Object.values(providers)) {
    const key = typeof provider.key === "string" && provider.key.trim()
      ? provider.key.trim()
      : typeof provider.options.apiKey === "string" && provider.options.apiKey.trim()
        ? provider.options.apiKey.trim()
        : ""
    if (!key) continue
    for (const model of Object.values(provider.models)) {
      if (model.status === "deprecated") continue
      const kind = candidateKind(model)
      if (!kind) continue
      const protocol = candidateProtocol(model, kind)
      if (!protocol) continue
      const baseURL = providerBaseURL(provider, model)
      if (!baseURL) continue
      candidates.push({ provider: provider.id, model: model.api.id || model.id, kind, protocol, baseURL, key })
    }
  }

  candidates.sort((left, right) =>
    rank(left) - rank(right) ||
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
  )
  const selected = candidates[0]
  if (!selected) return {}
  const publicCandidates: AudioModelCandidate[] = candidates.map(({ key: _key, ...candidate }) => candidate)
  return {
    [AUDIO_MODEL_RUNTIME_ENV.apiKey]: selected.key,
    [AUDIO_MODEL_RUNTIME_ENV.baseURL]: selected.baseURL,
    [AUDIO_MODEL_RUNTIME_ENV.model]: selected.model,
    [AUDIO_MODEL_RUNTIME_ENV.provider]: selected.provider,
    [AUDIO_MODEL_RUNTIME_ENV.kind]: selected.kind,
    [AUDIO_MODEL_RUNTIME_ENV.protocol]: selected.protocol,
    [AUDIO_MODEL_RUNTIME_ENV.candidates]: JSON.stringify(publicCandidates),
  }
}

export function childProcessBaseEnv(
  env: NodeJS.ProcessEnv,
  runtime: Record<string, string>,
): Record<string, string | undefined> {
  const projected = { ...env, ...runtime }
  delete projected.MIMOCODE_AUTH_CONTENT
  return projected
}

export function publishAudioModelRuntimeEnv(
  env: NodeJS.ProcessEnv,
  providers: Record<string, ProviderInfo>,
): Record<string, string> {
  for (const name of Object.values(AUDIO_MODEL_RUNTIME_ENV)) delete env[name]
  const projected = audioModelRuntimeEnv(providers)
  Object.assign(env, projected)
  return projected
}
