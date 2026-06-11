import z from "zod"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import * as McpExa from "../mcp-exa"
import * as MimoWebsearch from "./mimo"
import { Auth } from "@/auth"
import { Provider } from "@/provider"
import DESCRIPTION from "./websearch.txt"

const WEBFETCH_FALLBACK =
  "Web search unavailable. Use `webfetch` with a relevant URL instead, or enable the Web Search plugin at https://platform.xiaomimimo.com/console/plugin."
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

const Parameters = z.object({
  query: z.string().describe("Websearch query"),
  numResults: z.number().optional().describe("Number of search results to return (default: 8)"),
  timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
  livecrawl: z
    .enum(["fallback", "preferred"])
    .optional()
    .describe(
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
    ),
  type: z
    .enum(["auto", "fast", "deep"])
    .optional()
    .describe("Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"),
  contextMaxCharacters: z
    .number()
    .optional()
    .describe("Maximum characters for context string optimized for LLMs (default: 10000)"),
})

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const auth = yield* Auth.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              timeout: params.timeout,
            },
          })

          const model = (ctx.extra as { model?: Provider.Model })?.model
          const timeout = params.timeout === undefined ? undefined : Math.min(params.timeout * 1000, MAX_TIMEOUT)

          const result =
            model?.providerID === "xiaomi"
              ? yield* Effect.catchCause(
                  Effect.gen(function* () {
                    const info = yield* auth.get("xiaomi")
                    if (!info || info.type !== "api") return undefined
                    return yield* MimoWebsearch.call(
                      http,
                      model.api.url,
                      info.key,
                      params.query,
                      "mimo-v2.5",
                      timeout ?? "30 seconds",
                    )
                  }),
                  () => Effect.succeed(undefined),
                )
              : yield* McpExa.call(
                  http,
                  "web_search_exa",
                  McpExa.SearchArgs,
                  {
                    query: params.query,
                    type: params.type || "auto",
                    numResults: params.numResults || 8,
                    livecrawl: params.livecrawl || "fallback",
                    contextMaxCharacters: params.contextMaxCharacters,
                  },
                  timeout ?? "25 seconds",
                )

          return {
            output: result ?? WEBFETCH_FALLBACK,
            title: `Web search: ${params.query}`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
