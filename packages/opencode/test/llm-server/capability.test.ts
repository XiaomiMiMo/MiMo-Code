import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AppRuntime } from "../../src/effect/app-runtime"
import { LLMServerCapability } from "../../src/llm-server/capability"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * Resolving a CAPABILITY rather than a model name is what lets a skill be portable: one
 * that hard-codes `mimo-v2.5-tts` is bound to a single installation, one that asks for
 * `speech` runs wherever something can synthesize.
 *
 * `provideTmpdirInstance` is not used here because the resolver reaches services through
 * `AppRuntime`, exactly as it does in production; a tmpdir instance with config is all it
 * needs.
 */

function config(models: Record<string, { input: string[]; output: string[] }>, npm = "@ai-sdk/openai-compatible") {
  return {
    provider: {
      p: {
        name: "P",
        npm,
        options: { apiKey: "k", baseURL: "http://127.0.0.1:1/v1" },
        models: Object.fromEntries(
          Object.entries(models).map(([id, m]) => [
            id,
            {
              name: id,
              modalities: { input: m.input as ("text" | "audio" | "image")[], output: m.output as ("text" | "audio")[] },
            },
          ]),
        ),
      },
    },
  }
}

async function resolve(capability: LLMServerCapability.Capability, cfg: ReturnType<typeof config>) {
  await using tmp = await tmpdir({ config: cfg })
  // `return await`, not `return`: `await using` disposes the tmpdir when this block exits,
  // and without the await that happens while bootstrap is still reading the config file.
  return await Instance.provide({
    directory: tmp.path,
    // Same bootstrap the server's instance middleware performs; without it the provider
    // table is empty and every lookup answers "nothing configured".
    init: () => AppRuntime.runPromise(InstanceBootstrap),
    fn: async () => {
      const matches = await LLMServerCapability.resolve(capability)
      // Scoped to this fixture's provider. The resolver legitimately sees every provider
      // the machine has configured, so asserting on the whole list would test the
      // developer's own config rather than the resolver.
      return matches.filter((m) => m.ref.startsWith("p/")).map((m) => ({ ref: m.ref, dedicated: m.dedicated }))
    },
  })
}

describe("capability resolution", () => {
  test("finds a speech model by what it does", async () => {
    const found = await resolve(
      "speech",
      config({
        tts: { input: ["text"], output: ["audio"] },
        chat: { input: ["text"], output: ["text"] },
      }),
    )
    expect(found).toEqual([{ ref: "p/tts", dedicated: true }])
  })

  test("finds a dedicated ASR model and ranks it ahead of a multimodal one", async () => {
    // Both can transcribe; the dedicated one has a fixed contract, so it goes first. The
    // `dedicated` flag is reported so a caller knows which it got.
    const found = await resolve(
      "transcription",
      config({
        asr: { input: ["audio"], output: ["text"] },
        multimodal: { input: ["text", "audio"], output: ["text"] },
      }),
    )
    expect(found).toEqual([
      { ref: "p/asr", dedicated: true },
      { ref: "p/multimodal", dedicated: false },
    ])
  })

  test("falls back to a multimodal model when no dedicated ASR is configured", async () => {
    const found = await resolve(
      "transcription",
      config({
        multimodal: { input: ["text", "audio"], output: ["text"] },
        chat: { input: ["text"], output: ["text"] },
      }),
    )
    expect(found).toEqual([{ ref: "p/multimodal", dedicated: false }])
  })

  test("does not offer a plain chat model for transcription", async () => {
    const found = await resolve("transcription", config({ chat: { input: ["text"], output: ["text"] } }))
    expect(found).toEqual([])
  })

  test("does not offer an audio model whose package cannot carry audio", async () => {
    // `@ai-sdk/google` has no speech factory and speaks `:generateContent`, so a token
    // scoped to this model could never work. Offering it would be worse than finding
    // nothing.
    const found = await resolve(
      "speech",
      config({ tts: { input: ["text"], output: ["audio"] } }, "@ai-sdk/google"),
    )
    expect(found).toEqual([])
  })

  test("still offers a multimodal fallback on a non-OpenAI-shaped package", async () => {
    // The multimodal path goes through the SDK, which works for any package it supports —
    // unlike the dedicated-ASR path, which needs the raw transport.
    const found = await resolve(
      "transcription",
      config({ multimodal: { input: ["text", "audio"], output: ["text"] } }, "@ai-sdk/google"),
    )
    expect(found).toEqual([{ ref: "p/multimodal", dedicated: false }])
  })

  test("keeps audio models out of the chat answer", async () => {
    const found = await resolve(
      "chat",
      config({
        tts: { input: ["text"], output: ["audio"] },
        asr: { input: ["audio"], output: ["text"] },
        chat: { input: ["text"], output: ["text"] },
      }),
    )
    expect(found.map((f) => f.ref)).toEqual(["p/chat"])
  })

  test("orders reproducibly rather than by config or registry order", async () => {
    // Reproducibility is the property worth guaranteeing, not a specific order: the
    // configured DEFAULT model ranks first by design, and `Provider.defaultModel` picks by
    // id descending, so which of two equals wins depends on the installation rather than
    // on the alphabet. Asserting a fixed order here would be asserting the fixture.
    const cfg = config({
      zebra: { input: ["text"], output: ["text"] },
      alpha: { input: ["text"], output: ["text"] },
    })
    const first = await resolve("chat", cfg)
    const second = await resolve("chat", cfg)
    expect(first.map((f) => f.ref).sort()).toEqual(["p/alpha", "p/zebra"])
    expect(second.map((f) => f.ref)).toEqual(first.map((f) => f.ref))
  })
})

describe("explaining an empty answer", () => {
  test("says what to declare when nothing of that kind exists", async () => {
    await using tmp = await tmpdir({ config: config({ chat: { input: ["text"], output: ["text"] } }) })
    const message = await Instance.provide({
      directory: tmp.path,
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: async () => LLMServerCapability.explain("speech", await LLMServerCapability.all()),
    })
    expect(message).toContain("no speech model is configured")
    expect(message).toContain('"output": ["audio"]')
  })

  test("distinguishes unreachable from absent, and names the package", async () => {
    // The failure a config author cannot otherwise see: the model IS declared, but this
    // server has no transport for it.
    await using tmp = await tmpdir({
      config: config({ tts: { input: ["text"], output: ["audio"] } }, "@ai-sdk/google"),
    })
    const message = await Instance.provide({
      directory: tmp.path,
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: async () => LLMServerCapability.explain("speech", await LLMServerCapability.all()),
    })
    expect(message).toContain("none is reachable")
    expect(message).toContain("@ai-sdk/google")
  })
})
