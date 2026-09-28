import { Effect, Schedule, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"

// https://docs.firecrawl.dev — point FIRECRAWL_API_URL at a self-hosted instance, which
// serves the same API and runs unauthenticated, so either variable on its own is enough
const endpoint = (path: string) =>
  (process.env.FIRECRAWL_API_URL || "https://api.firecrawl.dev").replace(/\/+$/, "") + path

export const enabled = () => !!(process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_URL)

// Firecrawl asks clients to back off on these and to wait out Retry-After when it is set.
// A Retry-After longer than we are willing to sit on would only burn the caller's timeout
// budget, so those are surfaced right away instead of retried.
// https://docs.firecrawl.dev/api-reference/errors
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const RETRY_AFTER_MAX = 10 * 1000 // 10 seconds
const MIN_API_TIMEOUT = 1000 // the API rejects anything shorter

const retryAfter = (err: HttpClientError.HttpClientError) => {
  const seconds = err.reason._tag === "StatusCodeError" ? Number(err.reason.response.headers["retry-after"]) : 0
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

const transient = (err: HttpClientError.HttpClientError) =>
  err.reason._tag === "StatusCodeError" &&
  RETRYABLE.has(err.reason.response.status) &&
  retryAfter(err) <= RETRY_AFTER_MAX

const ScrapeResult = Schema.Struct({
  data: Schema.Struct({
    markdown: Schema.optional(Schema.NullOr(Schema.String)),
    html: Schema.optional(Schema.NullOr(Schema.String)),
    // Firecrawl answers 200 even when the page itself did not load, so the status the
    // target returned has to be read separately: https://docs.firecrawl.dev/features/scrape
    metadata: Schema.optional(
      Schema.NullOr(Schema.Struct({ statusCode: Schema.optional(Schema.NullOr(Schema.Number)) })),
    ),
  }),
})

const SearchResult = Schema.Struct({
  data: Schema.Struct({
    web: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            url: Schema.String,
            title: Schema.optional(Schema.NullOr(Schema.String)),
            description: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
})

const decodeScrape = Schema.decodeUnknownEffect(Schema.fromJsonString(ScrapeResult))
const decodeSearch = Schema.decodeUnknownEffect(Schema.fromJsonString(SearchResult))

// POST to the API with retries on transient failures, reading at most maxBytes of the body
const post = (http: HttpClient.HttpClient, path: string, body: Record<string, unknown>, maxBytes: number) =>
  Effect.gen(function* () {
    const key = process.env.FIRECRAWL_API_KEY
    const request = HttpClientRequest.post(endpoint(path)).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe(body),
      (req) => (key ? HttpClientRequest.bearerToken(req, key) : req),
    )

    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.tapError((err) => (transient(err) ? Effect.sleep(retryAfter(err)) : Effect.void)),
        Effect.retry({
          while: transient,
          schedule: Schedule.exponential(500).pipe(Schedule.jittered),
          times: 2,
        }),
      )

    const contentLength = response.headers["content-length"]
    if (contentLength && parseInt(contentLength) > maxBytes) {
      throw new Error(`Firecrawl ${path} response is too large`)
    }
    const text = yield* response.text
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Firecrawl ${path} response is too large`)
    }
    return text
  })

export const scrape = (
  http: HttpClient.HttpClient,
  url: string,
  format: "markdown" | "html",
  timeout: number,
  maxBytes: number,
) =>
  Effect.gen(function* () {
    // the API's own timeout is in milliseconds and defaults to 60s, which would outlive
    // a short budget and cut a long one short
    const body = yield* post(
      http,
      "/v2/scrape",
      { url, formats: [format], timeout: Math.max(timeout, MIN_API_TIMEOUT) },
      maxBytes,
    )
    const result = yield* decodeScrape(body)
    const status = result.data.metadata?.statusCode
    if (status && status !== 304 && (status < 200 || status >= 300)) {
      throw new Error(`Firecrawl reached ${url} but the page returned ${status}`)
    }
    return (format === "html" ? result.data.html : result.data.markdown) ?? undefined
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error("firecrawl scrape request timed out")),
    }),
  )

const SEARCH_MAX_BYTES = 1024 * 1024 // results carry no page content, so this is generous

export const search = (http: HttpClient.HttpClient, query: string, limit: number, timeout: number) =>
  Effect.gen(function* () {
    const body = yield* post(
      http,
      "/v2/search",
      { query, limit, timeout: Math.max(timeout, MIN_API_TIMEOUT) },
      SEARCH_MAX_BYTES,
    )
    const results = (yield* decodeSearch(body)).data.web ?? []
    if (results.length === 0) return undefined
    return results
      .map((r) => {
        // descriptions are query-relevant highlights and can span several lines
        const description =
          r.description
            ?.trim()
            .split("\n")
            .map((line) => `  ${line}`) ?? []
        return [`- ${r.title || r.url}`, `  ${r.url}`, ...description].join("\n")
      })
      .join("\n")
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.die(new Error("firecrawl search request timed out")),
    }),
  )
