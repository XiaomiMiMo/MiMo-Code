import type { Provider } from "@/provider"

/**
 * Model Capability Registry.
 *
 * MCP itself publishes no model list and no modality discovery, so a
 * `sampling/createMessage` request cannot be routed by guessing. This registry
 * is the single place that answers "can THIS model, through THIS adapter,
 * actually accept THIS content?".
 *
 * Two independent gates are ANDed:
 *
 *  1. The MODEL gate — `model.capabilities.input.{text,image,audio}`, sourced
 *     from models.dev metadata or the user's own `/modalities` config.
 *  2. The ADAPTER gate — whether the ai-sdk package behind the model can
 *     actually serialize that media. A model may accept audio while the adapter
 *     wired up for it cannot carry audio bytes; sending anyway would silently
 *     degrade the request.
 *
 * The adapter gate is deliberately TRI-STATE. "unsupported" is a claim we can
 * substantiate; "unknown" means we have no evidence either way and refuse to
 * invent one. Both are ineligible (fail closed) but they are reported
 * distinctly so an operator can tell "this cannot work" from "we do not know".
 */

export type Modality = "text" | "image" | "audio"

export type Support = "supported" | "unsupported" | "unknown"

/** What a single adapter accepts for a single modality. */
export interface ModalityDeclaration {
  readonly support: Support
  /** Accepted MIME types. `"any"` means every MIME within the modality prefix. */
  readonly mimeTypes: ReadonlyArray<string> | "any"
  /** Per-item cap on DECODED bytes. */
  readonly maxBytes: number
}

export interface AdapterDeclaration {
  readonly text: ModalityDeclaration
  readonly image: ModalityDeclaration
  readonly audio: ModalityDeclaration
  /** Why this declaration reads the way it does. Surfaced in errors and docs. */
  readonly evidence: string
}

/**
 * Client-side safety cap on inline media, NOT a claim about any provider's real
 * limit (no provider we wire up documents one we can read from metadata). It
 * exists so a hostile or buggy MCP server cannot push an unbounded payload
 * through the sampling path. 20 MiB comfortably clears the target use case: 30s
 * of 16 kHz mono 16-bit PCM WAV is ~0.92 MiB.
 */
export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024

/** Text is capped far lower — a prompt, not a payload. */
export const DEFAULT_MAX_TEXT_BYTES = 1 * 1024 * 1024

const SAFE_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"]
// Mirrors OPENAI_AUDIO_MIMES in src/session/tool-attachment.ts — the set the
// OpenAI-compatible chat adapter can serialize as input_audio.
const OPENAI_AUDIO_MIMES = ["audio/wav", "audio/mp3", "audio/mpeg"]

const TEXT_SUPPORTED: ModalityDeclaration = {
  support: "supported",
  mimeTypes: "any",
  maxBytes: DEFAULT_MAX_TEXT_BYTES,
}

const IMAGE_SUPPORTED: ModalityDeclaration = {
  support: "supported",
  mimeTypes: SAFE_IMAGE_MIMES,
  maxBytes: DEFAULT_MAX_MEDIA_BYTES,
}

function absent(mimeTypes: ReadonlyArray<string> | "any" = []): ModalityDeclaration {
  return { support: "unsupported", mimeTypes, maxBytes: 0 }
}

function unknown(): ModalityDeclaration {
  return { support: "unknown", mimeTypes: [], maxBytes: 0 }
}

/**
 * Per-adapter declarations, keyed by the ai-sdk npm package on `model.api.npm`.
 *
 * Every audio verdict below was verified by driving the INSTALLED adapter with an
 * `audio/*` file part and observing the serialized request body (or the thrown
 * `functionality not supported` error). Those observations are locked in by
 * test/provider/capability-registry-wire.test.ts, which fails if an adapter
 * upgrade changes the behaviour this table asserts. The verdicts also agree with
 * the routing logic this repo already ships in `src/session/tool-attachment.ts`.
 */
const ADAPTERS: Record<string, AdapterDeclaration> = {
  "@ai-sdk/openai-compatible": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: { support: "supported", mimeTypes: OPENAI_AUDIO_MIMES, maxBytes: DEFAULT_MAX_MEDIA_BYTES },
    // Observed: wav/mp3/mpeg serialize to `input_audio`; flac and ogg throw
    // "'audio media type ...' functionality not supported".
    evidence: "@ai-sdk/openai-compatible@3 serializes wav/mp3/mpeg as input_audio and rejects other audio",
  },
  "@ai-sdk/google": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: { support: "supported", mimeTypes: "any", maxBytes: DEFAULT_MAX_MEDIA_BYTES },
    // Observed: any audio/* passes through as `inlineData` with its MIME intact.
    evidence: "@ai-sdk/google passes any audio/* through as inlineData",
  },
  "@ai-sdk/google-vertex": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: { support: "supported", mimeTypes: "any", maxBytes: DEFAULT_MAX_MEDIA_BYTES },
    evidence: "@ai-sdk/google-vertex shares the @ai-sdk/google content conversion",
  },
  "@ai-sdk/anthropic": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: absent(),
    // Observed: an audio/wav part throws "'media type: audio/wav' functionality
    // not supported" while image/png serializes fine. Known-absent, not unproven.
    evidence: "@ai-sdk/anthropic throws 'media type: audio/wav' functionality not supported",
  },
  "@ai-sdk/google-vertex/anthropic": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: absent(),
    evidence: "@ai-sdk/google-vertex/anthropic shares the @ai-sdk/anthropic content conversion",
  },
  "@ai-sdk/amazon-bedrock": {
    text: TEXT_SUPPORTED,
    image: IMAGE_SUPPORTED,
    audio: absent(),
    evidence: "tool-attachment.ts:49-53,69-71 exclude @ai-sdk/amazon-bedrock from every audio route",  // no direct wire probe; routing logic is the evidence
  },
}

/**
 * Adapters with no entry above. Text and image are still declared supported
 * because every ai-sdk language model carries text, and image parts are a
 * baseline `LanguageModelV3` file part that adapters reject loudly rather than
 * silently mangle. Audio is `unknown`: we have no evidence, so we say so.
 */
const UNDECLARED: AdapterDeclaration = {
  text: TEXT_SUPPORTED,
  image: IMAGE_SUPPORTED,
  audio: unknown(),
  evidence: "no capability declaration for this adapter; audio support is unproven, not disproven",
}

export function adapterDeclaration(npm: string | undefined): AdapterDeclaration {
  if (!npm) return UNDECLARED
  return ADAPTERS[npm] ?? UNDECLARED
}

/** Adapter packages carrying an explicit declaration. Exported for docs/tests. */
export function declaredAdapters(): ReadonlyArray<string> {
  return Object.keys(ADAPTERS)
}

function modelGate(model: Provider.Model, modality: Modality): boolean {
  if (modality === "text") return model.capabilities.input.text
  if (modality === "image") return model.capabilities.input.image
  return model.capabilities.input.audio
}

/**
 * The effective declaration for a model: the adapter declaration narrowed by
 * the model's own declared input modalities. A model that does not declare a
 * modality is `unsupported` for it regardless of what its adapter could carry.
 */
export function modelDeclaration(model: Provider.Model, modality: Modality): ModalityDeclaration {
  const adapter = adapterDeclaration(model.api.npm)[modality]
  if (!modelGate(model, modality)) {
    return { support: "unsupported", mimeTypes: [], maxBytes: 0 }
  }
  return adapter
}

/** One piece of content a sampling request wants to send. */
export interface ContentRequirement {
  readonly modality: Modality
  readonly mimeType?: string
  /** Decoded size in bytes. */
  readonly bytes: number
}

export type RejectionReason =
  | { readonly kind: "modality-unsupported"; readonly modality: Modality }
  | { readonly kind: "modality-unknown"; readonly modality: Modality }
  | { readonly kind: "mime-unsupported"; readonly modality: Modality; readonly mimeType: string }
  | {
      readonly kind: "too-large"
      readonly modality: Modality
      readonly bytes: number
      readonly maxBytes: number
    }

export interface Rejection {
  readonly model: string
  readonly reason: RejectionReason
}

export function describeRejection(reason: RejectionReason): string {
  if (reason.kind === "modality-unsupported") return `does not accept ${reason.modality} input`
  if (reason.kind === "modality-unknown") return `has no declared ${reason.modality} support`
  if (reason.kind === "mime-unsupported") return `does not accept ${reason.mimeType}`
  return `content is ${reason.bytes} bytes, over the ${reason.maxBytes} byte limit for ${reason.modality}`
}

export function modelRef(model: Provider.Model): string {
  return `${model.providerID}/${model.id}`
}

/**
 * Check one model against every content requirement. Returns the first reason
 * the model cannot serve the request, or `undefined` when it can.
 */
export function rejectionFor(
  model: Provider.Model,
  requirements: ReadonlyArray<ContentRequirement>,
): RejectionReason | undefined {
  for (const requirement of requirements) {
    const declaration = modelDeclaration(model, requirement.modality)
    if (declaration.support === "unknown") {
      return { kind: "modality-unknown", modality: requirement.modality }
    }
    if (declaration.support === "unsupported") {
      return { kind: "modality-unsupported", modality: requirement.modality }
    }
    if (requirement.mimeType && declaration.mimeTypes !== "any") {
      const mime = requirement.mimeType.toLowerCase()
      if (!declaration.mimeTypes.some((item) => item.toLowerCase() === mime)) {
        return { kind: "mime-unsupported", modality: requirement.modality, mimeType: requirement.mimeType }
      }
    }
    if (requirement.bytes > declaration.maxBytes) {
      return {
        kind: "too-large",
        modality: requirement.modality,
        bytes: requirement.bytes,
        maxBytes: declaration.maxBytes,
      }
    }
  }
  return undefined
}

export interface ModelHint {
  readonly name?: string
}

export interface SelectionInput {
  /** Every model the user has actually configured credentials for. */
  readonly models: ReadonlyArray<Provider.Model>
  readonly requirements: ReadonlyArray<ContentRequirement>
  /** Advisory, in server-preference order. Ranks eligible models; never widens. */
  readonly hints?: ReadonlyArray<ModelHint>
  /** Existing model-selection strategy's answer, used when no hint matches. */
  readonly fallback?: Provider.Model
}

export type SelectionResult =
  | {
      readonly ok: true
      readonly model: Provider.Model
      /** How the winner was chosen. */
      readonly via: "hint" | "fallback" | "first-eligible"
      /** The hint that matched, when `via` is "hint". */
      readonly hint?: string
    }
  | {
      readonly ok: false
      /** Every configured model and why it was rejected. */
      readonly rejections: ReadonlyArray<Rejection>
      readonly requirements: ReadonlyArray<ContentRequirement>
    }

function hintMatches(model: Provider.Model, hint: string): boolean {
  const needle = hint.toLowerCase()
  const id = model.id.toLowerCase()
  const ref = modelRef(model).toLowerCase()
  const name = model.name.toLowerCase()
  if (id === needle || ref === needle || name === needle) return true
  // The spec treats a hint name as a substring that MAY match loosely.
  return id.includes(needle) || ref.includes(needle) || name.includes(needle)
}

function exactHintMatch(model: Provider.Model, hint: string): boolean {
  const needle = hint.toLowerCase()
  return model.id.toLowerCase() === needle || modelRef(model).toLowerCase() === needle
}

function stableOrder(models: ReadonlyArray<Provider.Model>): Provider.Model[] {
  return [...models].sort((a, b) => modelRef(a).localeCompare(modelRef(b)))
}

/**
 * FILTER THEN RANK. Eligibility is decided purely by capability + configured
 * credentials; only the surviving set is then ordered by the server's hints.
 * A hint can never make an ineligible model eligible.
 */
export function selectModel(input: SelectionInput): SelectionResult {
  const eligible: Provider.Model[] = []
  const rejections: Rejection[] = []

  for (const model of stableOrder(input.models)) {
    const reason = rejectionFor(model, input.requirements)
    if (reason) rejections.push({ model: modelRef(model), reason })
    else eligible.push(model)
  }

  if (eligible.length === 0) {
    return { ok: false, rejections, requirements: input.requirements }
  }

  for (const hint of input.hints ?? []) {
    const name = hint.name
    if (!name) continue
    const exact = eligible.find((model) => exactHintMatch(model, name))
    if (exact) return { ok: true, model: exact, via: "hint", hint: name }
    const loose = eligible.find((model) => hintMatches(model, name))
    if (loose) return { ok: true, model: loose, via: "hint", hint: name }
  }

  // No hint landed on an eligible model: defer to the existing selection
  // strategy when its answer is itself eligible, else take the first eligible
  // model in a deterministic order.
  const fallback = input.fallback
  if (fallback && eligible.some((model) => modelRef(model) === modelRef(fallback))) {
    return { ok: true, model: fallback, via: "fallback" }
  }
  return { ok: true, model: eligible[0], via: "first-eligible" }
}

export * as ModelCapability from "./capability-registry"
