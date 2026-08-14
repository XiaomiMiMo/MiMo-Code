import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider } from "@/provider"

/**
 * Resolve a CAPABILITY to a configured model.
 *
 * This is the piece that lets a skill declare what it needs rather than which model to
 * use. A skill that hard-codes `mimo-v2.5-tts` is bound to one person's configuration;
 * one that asks for `speech` runs anywhere something can synthesize. `Provider` already
 * resolves by capability internally — `getVisionModel`, `getSmallModel` — so this
 * follows an established shape rather than inventing one.
 *
 * The answer also has to account for whether this SERVER can serve the model, not just
 * whether the model exists. A speech model on a provider whose package speaks neither
 * the SDK's speech API nor OpenAI chat completions is unreachable, and offering it would
 * hand the caller a token that cannot work.
 */

export type Capability = "chat" | "speech" | "transcription"

/**
 * Packages this server can carry audio for.
 *
 * `@ai-sdk/openai` and `@ai-sdk/azure` expose a native speech factory; all three speak
 * OpenAI chat completions, which is the fallback transport. Everything else in the
 * family — Anthropic's `/v1/messages`, Google's `:generateContent`, Bedrock's signed
 * API — can carry neither, so a model there is not offerable however it is declared.
 */
const AUDIO_CAPABLE_NPM = ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/openai-compatible"]

type Candidate = { ref: string; model: Provider.Model; dedicated: boolean }

function candidates(capability: Capability, model: Provider.Model, ref: string): Candidate | undefined {
  const kind = Provider.modelKind(model)
  if (capability === "chat") {
    return kind === "language" ? { ref, model, dedicated: true } : undefined
  }
  if (capability === "speech") {
    if (kind !== "speech") return undefined
    return AUDIO_CAPABLE_NPM.includes(model.api.npm) ? { ref, model, dedicated: true } : undefined
  }
  // Transcription accepts two shapes. A dedicated ASR model needs the raw transport, so
  // it is only offerable on an audio-capable package; a multimodal model that can hear
  // goes through the SDK, which works for any package — see `transcribe`.
  if (kind === "transcription") {
    return AUDIO_CAPABLE_NPM.includes(model.api.npm) ? { ref, model, dedicated: true } : undefined
  }
  if (kind === "language" && model.capabilities.input.audio) {
    return { ref, model, dedicated: false }
  }
  return undefined
}

export async function resolve(capability: Capability) {
  const listed = await all()
  // The configured default is the only non-arbitrary choice for chat. Without it the
  // answer is whatever sorts first, which for a real installation was
  // `anthropic-mify/ppio/pa/claude-haiku-4-5` — alphabetical noise, not a decision.
  const preferred = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const chosen = yield* (yield* Provider.Service).defaultModel()
      return `${chosen.providerID}/${chosen.modelID}`
    }),
  ).catch(() => undefined)

  return listed
    .flatMap((entry) => candidates(capability, entry.model, entry.ref) ?? [])
    .sort((a, b) => {
      // Dedicated before fallback, then the configured default, then by ref so the choice
      // is reproducible rather than dependent on config or registry ordering.
      if (a.dedicated !== b.dedicated) return a.dedicated ? -1 : 1
      if (a.ref === preferred) return -1
      if (b.ref === preferred) return 1
      return a.ref.localeCompare(b.ref)
    })
}

/**
 * Human-readable reason nothing matched, aimed at whoever has to fix the config.
 *
 * Distinguishes "no such model" from "the model exists but this server cannot reach it",
 * because those need different actions and the second is invisible otherwise.
 */
export function explain(capability: Capability, all: { ref: string; model: Provider.Model }[]) {
  const declared = all.filter((entry) => {
    const kind = Provider.modelKind(entry.model)
    if (capability === "speech") return kind === "speech"
    if (capability === "transcription") return kind === "transcription" || entry.model.capabilities.input.audio
    return kind === "language"
  })
  if (declared.length === 0) {
    return capability === "chat"
      ? "no chat model is configured"
      : `no ${capability} model is configured; declare one with modalities, e.g. ` +
          (capability === "speech"
            ? `"modalities": { "input": ["text"], "output": ["audio"] }`
            : `"modalities": { "input": ["audio"], "output": ["text"] }`)
  }
  return (
    `${declared.length} ${capability} model(s) are configured but none is reachable through this server: ` +
    `${declared.map((d) => `${d.ref} (${d.model.api.npm})`).join(", ")}. ` +
    `Audio requires a provider package that exposes a native audio model or speaks OpenAI chat completions`
  )
}

export async function all() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const providers = yield* (yield* Provider.Service).list()
      return Object.entries(providers).flatMap(([providerID, provider]) =>
        Object.entries(provider.models).map(([modelID, model]) => ({ ref: `${providerID}/${modelID}`, model })),
      )
    }),
  )
}

export * as LLMServerCapability from "./capability"
