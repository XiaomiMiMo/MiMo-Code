import { test, expect, describe } from "bun:test"
import { ModelCapability } from "../../src/provider/capability-registry"
import type { Provider } from "../../src/provider"

// Minimal Provider.Model shaped fixture. Only the fields the registry reads are
// meaningful; the rest satisfy the type.
function model(input: {
  id: string
  providerID?: string
  npm?: string
  name?: string
  text?: boolean
  image?: boolean
  audio?: boolean
}): Provider.Model {
  return {
    id: input.id,
    providerID: input.providerID ?? "mimo",
    name: input.name ?? input.id,
    api: { npm: input.npm ?? "@ai-sdk/openai-compatible", id: input.id },
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: {
        text: input.text ?? true,
        image: input.image ?? false,
        audio: input.audio ?? false,
        video: false,
        pdf: false,
      },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
    limit: { context: 8000, output: 2000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } as unknown as Provider.Model
}

const AUDIO_WAV = { modality: "audio" as const, mimeType: "audio/wav", bytes: 960_000 }
const TEXT = { modality: "text" as const, bytes: 12 }

describe("adapter declarations", () => {
  test("google adapters declare audio supported for any audio MIME", () => {
    for (const npm of ["@ai-sdk/google", "@ai-sdk/google-vertex"]) {
      const declaration = ModelCapability.adapterDeclaration(npm)
      expect(declaration.audio.support).toBe("supported")
      expect(declaration.audio.mimeTypes).toBe("any")
    }
  })

  test("openai-compatible declares audio supported only for wav/mp3/mpeg", () => {
    const declaration = ModelCapability.adapterDeclaration("@ai-sdk/openai-compatible")
    expect(declaration.audio.support).toBe("supported")
    expect(declaration.audio.mimeTypes).toEqual(["audio/wav", "audio/mp3", "audio/mpeg"])
  })

  test("anthropic and bedrock adapters declare audio KNOWN-ABSENT, not unknown", () => {
    for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic", "@ai-sdk/amazon-bedrock"]) {
      expect(ModelCapability.adapterDeclaration(npm).audio.support).toBe("unsupported")
    }
  })

  test("an undeclared adapter reports audio as unknown rather than guessing", () => {
    const declaration = ModelCapability.adapterDeclaration("@ai-sdk/some-future-provider")
    expect(declaration.audio.support).toBe("unknown")
    // Text and image stay usable so an unknown adapter is not locked out of
    // ordinary sampling.
    expect(declaration.text.support).toBe("supported")
    expect(declaration.image.support).toBe("supported")
  })

  test("a missing npm falls back to the undeclared declaration", () => {
    expect(ModelCapability.adapterDeclaration(undefined).audio.support).toBe("unknown")
  })
})

describe("model declaration ANDs the model gate with the adapter gate", () => {
  test("adapter can carry audio but model does not declare it → unsupported", () => {
    const subject = model({ id: "g", npm: "@ai-sdk/google", audio: false })
    expect(ModelCapability.modelDeclaration(subject, "audio").support).toBe("unsupported")
  })

  test("model declares audio and adapter can carry it → supported", () => {
    const subject = model({ id: "g", npm: "@ai-sdk/google", audio: true })
    expect(ModelCapability.modelDeclaration(subject, "audio").support).toBe("supported")
  })

  test("model declares audio but adapter cannot carry it → unsupported", () => {
    const subject = model({ id: "claude", npm: "@ai-sdk/anthropic", audio: true })
    expect(ModelCapability.modelDeclaration(subject, "audio").support).toBe("unsupported")
  })

  test("model declares audio but adapter support is unknown → unknown", () => {
    const subject = model({ id: "future", npm: "@ai-sdk/unheard-of", audio: true })
    expect(ModelCapability.modelDeclaration(subject, "audio").support).toBe("unknown")
  })
})

describe("rejectionFor", () => {
  test("accepts a 16kHz mono WAV on an audio-capable openai-compatible model", () => {
    const subject = model({ id: "mimo-v2.5", audio: true })
    expect(ModelCapability.rejectionFor(subject, [TEXT, AUDIO_WAV])).toBeUndefined()
  })

  test("rejects an audio MIME the adapter does not accept", () => {
    const subject = model({ id: "mimo-v2.5", audio: true })
    const reason = ModelCapability.rejectionFor(subject, [
      { modality: "audio", mimeType: "audio/flac", bytes: 1000 },
    ])
    expect(reason).toEqual({ kind: "mime-unsupported", modality: "audio", mimeType: "audio/flac" })
  })

  test("rejects content over the declared byte cap", () => {
    const subject = model({ id: "mimo-v2.5", audio: true })
    const bytes = ModelCapability.DEFAULT_MAX_MEDIA_BYTES + 1
    const reason = ModelCapability.rejectionFor(subject, [{ modality: "audio", mimeType: "audio/wav", bytes }])
    expect(reason).toEqual({
      kind: "too-large",
      modality: "audio",
      bytes,
      maxBytes: ModelCapability.DEFAULT_MAX_MEDIA_BYTES,
    })
  })

  test("distinguishes known-absent from unknown in the rejection reason", () => {
    const absent = model({ id: "claude", npm: "@ai-sdk/anthropic", audio: true })
    expect(ModelCapability.rejectionFor(absent, [AUDIO_WAV])).toEqual({
      kind: "modality-unsupported",
      modality: "audio",
    })
    const unproven = model({ id: "future", npm: "@ai-sdk/unheard-of", audio: true })
    expect(ModelCapability.rejectionFor(unproven, [AUDIO_WAV])).toEqual({
      kind: "modality-unknown",
      modality: "audio",
    })
  })
})

describe("selectModel: filter then rank", () => {
  test("audio content with only text-capable models configured returns a structured error", () => {
    const models = [model({ id: "text-only-a" }), model({ id: "text-only-b" })]
    const result = ModelCapability.selectModel({ models, requirements: [TEXT, AUDIO_WAV] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    // Every configured model is accounted for, with a reason.
    expect(result.rejections.map((item) => item.model).sort()).toEqual(["mimo/text-only-a", "mimo/text-only-b"])
    for (const rejection of result.rejections) {
      expect(rejection.reason).toEqual({ kind: "modality-unsupported", modality: "audio" })
    }
    expect(result.requirements).toEqual([TEXT, AUDIO_WAV])
  })

  test("an exact hint on an eligible model wins", () => {
    const models = [model({ id: "other", audio: true }), model({ id: "mimo-v2.5", audio: true })]
    const result = ModelCapability.selectModel({
      models,
      requirements: [AUDIO_WAV],
      hints: [{ name: "mimo-v2.5" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("mimo-v2.5")
    expect(result.via).toBe("hint")
    expect(result.hint).toBe("mimo-v2.5")
  })

  test("a hint naming a model that exists but lacks the modality does NOT win", () => {
    // claude-x is configured and would match the hint by name, but cannot take
    // audio. A hint must rank among eligible models, never widen eligibility.
    const models = [
      model({ id: "claude-x", npm: "@ai-sdk/anthropic", audio: true }),
      model({ id: "mimo-v2.5", audio: true }),
    ]
    const result = ModelCapability.selectModel({
      models,
      requirements: [AUDIO_WAV],
      hints: [{ name: "claude-x" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("mimo-v2.5")
    // The hint did not land, so selection fell through to the ordinary strategy.
    expect(result.via).toBe("first-eligible")
  })

  test("a hint naming an unconfigured model falls through to the fallback", () => {
    const fallback = model({ id: "mimo-v2.5", audio: true })
    const models = [model({ id: "zzz-other", audio: true }), fallback]
    const result = ModelCapability.selectModel({
      models,
      requirements: [AUDIO_WAV],
      hints: [{ name: "gpt-not-configured" }],
      fallback,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("mimo-v2.5")
    expect(result.via).toBe("fallback")
  })

  test("hints are consulted in server-preference order", () => {
    const models = [model({ id: "first-choice", audio: true }), model({ id: "second-choice", audio: true })]
    const result = ModelCapability.selectModel({
      models,
      requirements: [AUDIO_WAV],
      hints: [{ name: "second-choice" }, { name: "first-choice" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("second-choice")
  })

  test("an ineligible fallback is not used; the first eligible model is", () => {
    const fallback = model({ id: "claude-x", npm: "@ai-sdk/anthropic", audio: true })
    const models = [fallback, model({ id: "aaa-audio", audio: true })]
    const result = ModelCapability.selectModel({ models, requirements: [AUDIO_WAV], fallback })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("aaa-audio")
    expect(result.via).toBe("first-eligible")
  })

  test("a loose hint matches by substring but only among eligible models", () => {
    const models = [model({ id: "mimo-v2.5-pro", audio: true })]
    const result = ModelCapability.selectModel({
      models,
      requirements: [AUDIO_WAV],
      hints: [{ name: "mimo-v2.5" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("mimo-v2.5-pro")
    expect(result.via).toBe("hint")
  })

  test("no configured models at all is a structured error with no rejections", () => {
    const result = ModelCapability.selectModel({ models: [], requirements: [TEXT] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.rejections).toEqual([])
  })

  /**
   * The `unknown` fail-closed path at the GATE, not just at the leaf.
   *
   * Measured: collapsing `unknown` into an eligible state (replacing
   * `rejectionFor`'s unknown branch with `continue`) left the
   * `adapterDeclaration` and `modelDeclaration` assertions above GREEN — they pin
   * the declaration table, not the decision — and `selectModel`, the function the
   * sampling handler actually calls, had no `unknown` case at all. Only
   * `rejectionFor`'s reason-kind assertion failed. These two tests put the
   * refusal itself under assertion.
   */
  test("an unknown-support model is refused by the gate, distinctly from known-absent", () => {
    const unproven = model({ id: "future", npm: "@ai-sdk/unheard-of", audio: true })
    const result = ModelCapability.selectModel({ models: [unproven], requirements: [TEXT, AUDIO_WAV] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.rejections).toEqual([
      { model: "mimo/future", reason: { kind: "modality-unknown", modality: "audio" } },
    ])
    // The operator-facing text separates "we do not know" from "this cannot
    // work". These two lines pin wording only; they are not sensitive to a
    // fail-open regression in the gate, which the assertions above cover.
    expect(ModelCapability.describeRejection(result.rejections[0].reason)).toBe("has no declared audio support")
    expect(ModelCapability.describeRejection({ kind: "modality-unsupported", modality: "audio" })).toBe(
      "does not accept audio input",
    )
  })

  test("a hint cannot promote an unknown-support model over an eligible one", () => {
    // The known-absent counterpart of this is asserted above; `unknown` needs its
    // own case because it is a different branch. A hint ranks eligible models and
    // must never widen eligibility to one whose support is merely unproven.
    const models = [
      model({ id: "future", npm: "@ai-sdk/unheard-of", audio: true }),
      model({ id: "mimo-v2.5", audio: true }),
    ]
    const result = ModelCapability.selectModel({ models, requirements: [AUDIO_WAV], hints: [{ name: "future" }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(String(result.model.id)).toBe("mimo-v2.5")
    expect(result.via).toBe("first-eligible")
  })
})
