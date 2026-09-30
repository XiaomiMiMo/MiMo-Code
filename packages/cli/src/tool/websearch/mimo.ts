import { Duration, Effect, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1"

export const QUOTA_EXCEEDED =
  "Web search quota exhausted (free tier limit reached). Top up or manage your plan at https://platform.xiaomimimo.com/console/plugin, or use `webfetch` with a relevant URL instead."

const Annotation = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  site_name: Schema.optional(Schema.NullOr(Schema.String)),
  publish_time: Schema.optional(Schema.NullOr(Schema.String)),
})
type Annotation = Schema.Schema.Type<typeof Annotation>

const Annotations = Schema.Array(Annotation)

const Frame = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              annotations: Schema.optional(Schema.NullOr(Annotations)),
            }),
          ),
        ),
        message: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              annotations: Schema.optional(Schema.NullOr(Annotations)),
            }),
          ),
        ),
      }),
    ),
  ),
})

const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(Frame))

function buildUrl(baseUrl: string) {
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")
  if (base.endsWith("/chat/completions")) return base
  return (base.endsWith("/v1") ? base : `${base}/v1`) + "/chat/completions"
}

function formatSources(annotations: ReadonlyArray<Annotation>) {
  const lines = annotations.flatMap((a) => {
    if (!a.url) return []
    const head = [a.title, a.site_name, a.publish_time].filter(Boolean).join(" · ")
    return [`- ${head || a.url}`, `  ${a.url}`, ...(a.summary ? [`  ${a.summary}`] : [])]
  })
  return lines.length > 0 ? ["Sources:", ...lines].join("\n") : undefined
}

function extractAnnotations(line: string): Effect.Effect<ReadonlyArray<Annotation> | undefined> {
  if (!line.startsWith("data:")) return Effect.succeed(undefined)
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return Effect.succeed(undefined)
  return decodeFrame(payload).pipe(
    Effect.map((frame) => {
      const choice = frame.choices?.[0]
      const list = choice?.delta?.annotations ?? choice?.message?.annotations
      return list && list.length > 0 ? list : undefined
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const call = (
  http: HttpClient.HttpClient,
  baseUrl: string,
  apiKey: string,
  query: string,
  modelId: string,
  timeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(buildUrl(baseUrl)).pipe(
      HttpClientRequest.setHeader("api-key", apiKey),
      HttpClientRequest.accept("text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({
        model: modelId,
        messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search", max_keyword: 3, force_search: true, limit: 5 }],
        max_completion_tokens: 256,
        temperature: 1.0,
        top_p: 0.95,
        stream: true,
        thinking: { type: "disabled" },
      }),
    )

    const annotations = yield* HttpClientResponse.stream(HttpClient.filterStatusOk(http).execute(request)).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect(extractAnnotations),
      Stream.filter((value): value is ReadonlyArray<Annotation> => value !== undefined),
      Stream.runHead,
      Effect.catchIf(
        (err) => err.reason._tag === "StatusCodeError" && err.reason.response.status === 409,
        () => Effect.succeed(QUOTA_EXCEEDED),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.die(new Error("xiaomi web_search request timed out")),
      }),
    )

    if (typeof annotations === "string") return annotations
    if (annotations._tag === "None") return undefined
    return formatSources(annotations.value)
  })
