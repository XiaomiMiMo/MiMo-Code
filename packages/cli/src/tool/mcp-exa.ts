import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

// The hosted MCP `tools` parameter replaces the server's default set instead
// of appending to it, so both tools the engine calls must be listed or the
// other one comes back as "Unknown tool".
const BASE_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,get_code_context_exa"

const URL = process.env.EXA_API_KEY
  ? `${BASE_URL}&exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : BASE_URL

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String,
      }),
    ),
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

// JSON-RPC failures such as "Unknown tool" arrive as bare JSON, or as SSE data
// lines carrying an `error` member instead of `result`. Surfacing them as text
// keeps a provider-side tool removal from looking like "no results".
const jsonRpcError = (raw: string): string | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
  if (typeof error?.message !== "string") return undefined
  const code = typeof error.code === "number" ? ` (code ${error.code})` : ""
  return `Exa request failed: ${error.message}${code}`
}

export const parseSse = Effect.fn("McpExa.parseSse")(function* (body: string) {
  const data: string[] = []
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) data.push(line.substring(6))
  }
  if (data.length === 0) {
    // JSON-RPC failures arrive as bare JSON without SSE framing; anything else
    // is not a tool result.
    return jsonRpcError(body)
  }
  for (const raw of data) {
    const failure = jsonRpcError(raw)
    if (failure) return failure
    const decoded = yield* decode(raw)
    if (decoded.result.content[0]?.text) return decoded.result.content[0].text
  }
  return undefined
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const CodeArgs = Schema.Struct({
  query: Schema.String,
  tokensNum: Schema.Number,
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(URL).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error(`${tool} request timed out`)) }),
      )
    const body = yield* response.text
    return yield* parseSse(body)
  })
