import { expect, test } from "bun:test"
import type { Provider } from "../../src/provider"
import {
  AUDIO_MODEL_RUNTIME_ENV,
  audioModelRuntimeEnv,
  childProcessBaseEnv,
  publishAudioModelRuntimeEnv,
} from "../../src/provider/model-runtime-env"

function provider(input: {
  id: string
  key?: string
  baseURL?: string
  models: Array<{ id: string; apiID?: string; audio?: boolean; status?: "active" | "deprecated" }>
}): Provider.Info {
  return {
    id: input.id,
    name: input.id,
    source: "api",
    env: [],
    key: input.key,
    options: input.baseURL ? { baseURL: input.baseURL } : {},
    models: Object.fromEntries(input.models.map((item) => [item.id, {
      id: item.id,
      providerID: input.id,
      name: item.id,
      family: "test",
      api: { id: item.apiID ?? item.id, url: "https://catalog.example/v1", npm: "@ai-sdk/openai-compatible" },
      status: item.status ?? "active",
      headers: {},
      options: {},
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1, output: 1 },
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: true,
        toolcall: false,
        input: { text: true, audio: item.audio ?? false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      variants: {},
    }])) as Provider.Info["models"],
  } as unknown as Provider.Info
}

test("dedicated mimo-v2.5-asr wins over other ASR and audio-capable models", () => {
  const runtime = audioModelRuntimeEnv({
    openai: provider({
      id: "openai",
      key: "openai-secret",
      models: [{ id: "whisper-1" }, { id: "gpt-audio", audio: true }],
    }),
    xiaomi: provider({
      id: "xiaomi",
      key: "mimo-secret",
      baseURL: "https://router.example/v1/",
      models: [{ id: "mimo-v2.5" , audio: true }, { id: "mimo-v2.5-asr" }],
    }),
  })

  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.apiKey]).toBe("mimo-secret")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.baseURL]).toBe("https://router.example/v1")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.model]).toBe("mimo-v2.5-asr")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.provider]).toBe("xiaomi")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.kind]).toBe("asr")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.protocol]).toBe("openai-chat-audio")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.candidates]).not.toContain("secret")
})

test("falls back to an authenticated audio-input model", () => {
  const runtime = audioModelRuntimeEnv({
    xiaomi: provider({ id: "xiaomi", key: "key", models: [{ id: "mimo-v2.5", audio: true }] }),
  })
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.model]).toBe("mimo-v2.5")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.kind]).toBe("audio")
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.protocol]).toBe("openai-chat-audio")
})

test("projects Whisper-compatible dedicated ASR with the transcription protocol", () => {
  const runtime = audioModelRuntimeEnv({
    openai: provider({ id: "openai", key: "key", baseURL: "https://api.openai.com/v1", models: [{ id: "whisper-1" }] }),
  })
  expect(runtime[AUDIO_MODEL_RUNTIME_ENV.protocol]).toBe("openai-audio-transcriptions")
})

test("ignores providers without credentials and deprecated candidates", () => {
  expect(audioModelRuntimeEnv({
    anonymous: provider({ id: "anonymous", models: [{ id: "anonymous-asr" }] }),
    old: provider({ id: "old", key: "key", models: [{ id: "old-asr", status: "deprecated" }] }),
  })).toEqual({})
})

test("child environment removes the broad auth payload and keeps only projected credentials", () => {
  const env = childProcessBaseEnv(
    { PATH: "/bin", MIMOCODE_AUTH_CONTENT: "contains-many-provider-secrets" },
    { [AUDIO_MODEL_RUNTIME_ENV.apiKey]: "scoped-key" },
  )
  expect(env.MIMOCODE_AUTH_CONTENT).toBeUndefined()
  expect(env.PATH).toBe("/bin")
  expect(env[AUDIO_MODEL_RUNTIME_ENV.apiKey]).toBe("scoped-key")
})

test("publishing replaces stale model-runtime variables after provider changes", () => {
  const target: NodeJS.ProcessEnv = {
    [AUDIO_MODEL_RUNTIME_ENV.model]: "stale-asr",
    [AUDIO_MODEL_RUNTIME_ENV.apiKey]: "stale-key",
  }
  publishAudioModelRuntimeEnv(target, {
    xiaomi: provider({ id: "xiaomi", key: "fresh-key", models: [{ id: "mimo-v2.5", audio: true }] }),
  })
  expect(target[AUDIO_MODEL_RUNTIME_ENV.model]).toBe("mimo-v2.5")
  expect(target[AUDIO_MODEL_RUNTIME_ENV.apiKey]).toBe("fresh-key")
  publishAudioModelRuntimeEnv(target, {})
  expect(target[AUDIO_MODEL_RUNTIME_ENV.model]).toBeUndefined()
  expect(target[AUDIO_MODEL_RUNTIME_ENV.apiKey]).toBeUndefined()
})
