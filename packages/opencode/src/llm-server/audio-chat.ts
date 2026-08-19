import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider } from "@/provider"
import { Log } from "@/util"

const log = Log.create({ service: "llm-server.audio-chat" })

/**
 * Audio through `POST /v1/chat/completions`, for providers that carry it there
 * instead of on OpenAI's dedicated audio endpoints.
 *
 * Two conventions exist in the wild and a skill should not have to know which one
 * its model uses:
 *
 *  - OpenAI's own: `POST /v1/audio/speech` returns raw bytes,
 *    `POST /v1/audio/transcriptions` takes multipart. The AI SDK models this, and
 *    `Provider.getSpeech` covers it.
 *  - Audio-in-chat-completions: MiMo's TTS/ASR, `gpt-4o-audio-preview`, Gemini's
 *    audio-out models. Synthesis text goes in an ASSISTANT message and the audio
 *    comes back base64 inside `message.audio`; transcription sends an
 *    `input_audio` content part and reads the transcript out of `message.content`.
 *
 * The AI SDK cannot carry the second one: `@ai-sdk/openai-compatible`'s response
 * schema has no `audio` field at all (its eight `audio` references are all on the
 * INPUT side, building `input_audio`), so any audio a provider returns is dropped
 * before `streamText` yields anything. Measured against the real MiMo endpoint: a
 * model declared with audio output was refused by both routes, and declared with
 * text output it produced an opaque 502.
 *
 * So this module talks HTTP directly. That is a deliberate, contained exception to
 * "always go through the SDK", and it does not weaken the credential boundary: the
 * key is read from the provider's own config INSIDE this process and never travels
 * to the caller, exactly as it does when the SDK builds a request.
 */

/** A type predicate rather than a cast, so each narrowing is checked, not claimed. */
function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export class AudioChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Where to send a raw request, resolved from the provider's own configuration. */
async function endpoint(providerID: string) {
  const info = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const providers = yield* (yield* Provider.Service).list()
      return Object.entries(providers).find(([id]) => id === providerID)?.[1]
    }),
  )
  if (!info) throw new AudioChatError(404, `Unknown provider \`${providerID}\``)

  const options: Record<string, unknown> = info.options ?? {}
  const base = text(options["baseURL"])
  if (!base) {
    // Without a baseURL there is nothing to talk to. The SDK would have defaulted to
    // the vendor's public host; guessing that here would send credentials somewhere
    // the operator never named.
    throw new AudioChatError(
      501,
      `Provider \`${providerID}\` has no baseURL configured, so audio cannot be carried over chat completions`,
    )
  }
  const key = text(options["apiKey"]) ?? info.key
  const extra = options["headers"]
  return {
    url: `${base.replace(/\/$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      // Header values that are not strings cannot be sent; dropping them beats
      // stringifying an object into a header the provider will not understand.
      ...(fields(extra)
        ? Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => text(entry[1]) !== undefined))
        : {}),
    },
  }
}

async function post(providerID: string, body: unknown, abort: AbortSignal) {
  const target = await endpoint(providerID)
  const response = await fetch(target.url, {
    method: "POST",
    headers: target.headers,
    body: JSON.stringify(body),
    signal: abort,
  })
  const text = await response.text()
  if (!response.ok) {
    log.error("upstream audio call failed", { providerID, status: response.status })
    // 502, matching the chat path: from the caller's side an upstream refusal is the
    // provider's failure, not a mistake in their own request.
    throw new AudioChatError(502, upstreamMessage(text) ?? `upstream returned ${response.status}`)
  }
  return parse(text)
}

function parse(body: string): Record<string, unknown> {
  const value: unknown = (() => {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  })()
  if (!fields(value)) throw new AudioChatError(502, "upstream returned a body that is not a JSON object")
  return value
}

/**
 * Pull a human-readable message out of an upstream error body.
 *
 * `param` is appended when present because that is where the useful half lives on
 * this family of gateways: MiMo answers `message: "Param Incorrect"` with the actual
 * reason — "ASR request must not include text parts" — in `param`. Reporting only
 * `message` hid the cause behind a phrase that says nothing.
 */
function upstreamMessage(body: string) {
  const value: unknown = (() => {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  })()
  if (!fields(value) || !fields(value["error"])) return undefined
  const message = text(value["error"]["message"])
  const param = text(value["error"]["param"])
  if (!message) return param
  return param && param.length > 0 ? `${message}: ${param}` : message
}

function firstMessage(body: Record<string, unknown>) {
  const choices = body["choices"]
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AudioChatError(502, "upstream returned no choices")
  }
  const choice = choices[0]
  if (!fields(choice) || !fields(choice["message"])) {
    throw new AudioChatError(502, "upstream returned a choice with no message")
  }
  return choice["message"]
}

/**
 * A preset name passes through; a reference sample must arrive as a `data:` URL.
 *
 * The vendor reads the container from that prefix, so bare base64 with a known format is
 * given one rather than sent as-is and rejected for a reason the caller cannot see. A bare
 * payload with no format is left alone: guessing wav would mislabel whatever it really is,
 * and the vendor's own error is then the honest answer.
 */
function voiceField(voice: string, sampleFormat?: string) {
  if (!sampleFormat || voice.startsWith("data:")) return voice
  return `data:${sampleFormat === "mp3" || sampleFormat === "mpeg" ? "audio/mpeg" : "audio/wav"};base64,${voice}`
}

/**
 * Synthesize by putting the text in an assistant message.
 *
 * That placement is the convention's requirement, not a preference: MiMo's docs are
 * explicit that target text in a `user` message is not synthesized. Style guidance
 * is what the `user` message is for, which lines up with `instructions` on the
 * OpenAI-shaped request this serves.
 */
export async function synthesize(input: {
  providerID: string
  modelID: string
  text: string
  /**
   * Preset voice name, or a reference sample for cloning.
   *
   * One field because that is what the vendor convention uses for both: a preset is a name, a
   * clone is the sample itself. `sampleFormat` disambiguates the second case when the payload
   * is bare base64 rather than a `data:` URL.
   */
  voice?: string
  sampleFormat?: string
  format?: string
  instructions?: string
  abort: AbortSignal
}) {
  log.info("audio-over-chat synthesis", {
    providerID: input.providerID,
    model: input.modelID,
    characters: input.text.length,
  })

  const body = await post(
    input.providerID,
    {
      model: input.modelID,
      messages: [
        ...(input.instructions ? [{ role: "user", content: input.instructions }] : []),
        { role: "assistant", content: input.text },
      ],
      audio: {
        // `wav` rather than the provider's default, so the bytes are self-describing
        // and the response content type can be trusted downstream.
        format: input.format ?? "wav",
        ...(input.voice ? { voice: voiceField(input.voice, input.sampleFormat) } : {}),
      },
    },
    input.abort,
  )

  const audio = firstMessage(body)["audio"]
  if (!fields(audio)) {
    // Names what was attempted, because this is the shape of failure when a provider
    // speaks OpenAI chat completions but does NOT use the audio-in-message convention:
    // the call succeeds and simply answers with text. Reporting only "no audio" would
    // read as the provider misbehaving rather than as a convention mismatch.
    throw new AudioChatError(
      502,
      "upstream accepted the request but returned no audio in `message.audio`; " +
        "this provider speaks OpenAI chat completions but may not carry synthesized audio there",
    )
  }
  const data = text(audio["data"])
  if (data === undefined || data.length === 0) {
    throw new AudioChatError(502, "upstream returned an empty audio payload")
  }
  return { audio: Buffer.from(data, "base64"), format: input.format ?? "wav" }
}

/**
 * Transcribe by sending an `input_audio` content part.
 *
 * The transcript arrives as ordinary message content, so unlike synthesis this half
 * would be expressible through the SDK — except that the language hint travels as a
 * top-level `asr_options`, which the SDK has no way to emit. Keeping both halves on
 * the same path also keeps one explanation instead of two.
 */
export async function transcribe(input: {
  providerID: string
  modelID: string
  audio: Uint8Array
  mediaType: string
  language?: string
  /** Set for a multimodal model, which needs telling what to do with the audio. */
  instruction?: string
  /**
   * Suppress the model's thinking.
   *
   * A reasoning model asked to transcribe otherwise emits the transcript as
   * `reasoning_content` with `content: null` some of the time, which no consumer can
   * rely on. `thinking: {type: "disabled"}` is MiMo's control for it — an
   * Anthropic-style field on an OpenAI-shaped endpoint, which is exactly the
   * combination `@ai-sdk/openai-compatible` cannot express: its provider options are
   * validated against a closed schema with no `thinking` and no extra-body escape.
   * Being on the raw path is what makes sending it possible at all.
   *
   * Measured: three consecutive runs with it disabled all returned the transcript in
   * `content` with `reasoning_tokens: 0`.
   */
  disableThinking?: boolean
  abort: AbortSignal
}) {
  log.info("audio-over-chat transcription", {
    providerID: input.providerID,
    model: input.modelID,
    bytes: input.audio.byteLength,
    mediaType: input.mediaType,
  })

  const body = await post(
    input.providerID,
    {
      model: input.modelID,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: `data:${input.mediaType};base64,${Buffer.from(input.audio).toString("base64")}` },
            },
            // A dedicated ASR endpoint REFUSES text parts; a multimodal model requires
            // one. The caller of this function knows which it is talking to.
            ...(input.instruction ? [{ type: "text", text: input.instruction }] : []),
          ],
        },
      ],
      // `asr_options` belongs to the dedicated endpoint only.
      ...(input.instruction ? {} : input.language ? { asr_options: { language: input.language } } : {}),
      ...(input.disableThinking ? { thinking: { type: "disabled" } } : {}),
      ...(input.instruction ? { max_tokens: 4096 } : {}),
    },
    input.abort,
  )

  const message = firstMessage(body)
  const content = text(message["content"])
  if (content === undefined || content.length === 0) {
    // Distinguish the case that actually happens. A reasoning model asked to transcribe
    // sometimes puts the whole answer in `reasoning_content` with `content: null`, and
    // reading that as the transcript is NOT safe — on other calls the same field held
    // "The user wants a verbatim transcription… The audio contains the phrase: …". So the
    // answer names what happened instead of guessing, and points at the fix.
    if (text(message["reasoning_content"]) !== undefined) {
      throw new AudioChatError(
        502,
        "model returned its answer as reasoning rather than content, so no transcript can be read; " +
          "thinking could not be suppressed for this model — configure a dedicated speech-to-text model " +
          "for a stable contract",
      )
    }
    throw new AudioChatError(502, "upstream returned no transcript text")
  }
  return { text: content }
}

export * as AudioChat from "./audio-chat"
