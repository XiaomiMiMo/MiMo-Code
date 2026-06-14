import { Effect } from "effect"
import z from "zod"
import { Memory } from "@/memory"
import DESCRIPTION from "./memory.txt"
import * as Tool from "./tool"

const parameters = z.object({
  operation: z.enum(["search"]).default("search").describe("Memory operation to perform"),
  query: z.string().describe("Search query (BM25 over markdown bodies)"),
  scope: z.enum(["global", "projects", "sessions", "cc"]).optional().describe("Filter by memory scope"),
  scope_id: z
    .string()
    .optional()
    .describe("Filter by scope id (e.g., session id, task id, project id hash)"),
  type: z
    .string()
    .optional()
    .describe("Filter by memory type (pinned, snapshot, learning, progress, free, ...)"),
  limit: z.number().optional().describe("Max results (default 10)"),
})

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>) =>
        Effect.gen(function* () {
          const results = yield* memory.search({
            query: args.query,
            scope: args.scope,
            scope_id: args.scope_id,
            type: args.type,
            limit: args.limit,
          })
          if (results.length === 0) {
            return {
              title: `Memory search: 0 results`,
              output: [
                `No matches for "${args.query}".`,
                ``,
                `0 results does NOT mean it was never recorded. Escalate before giving up:`,
                `1. Retry with FEWER / more distinctive terms — queries are OR-joined and`,
                `   ranked, so 1-2 rare words (an exact ID, function name, flag) beat a long`,
                `   descriptive phrase. Drop generic words ("config", "params", "database").`,
                `2. For a LITERAL string the tokenizer splits (URLs like postgres://…, ports`,
                `   like 5433, paths) — Grep the memory dir directly; FTS can't see it.`,
                `3. For VERBATIM recall of something a summary may have glossed over (exact`,
                `   command, the user's precise wording) — use the history tool (raw`,
                `   conversation), which keeps original messages.`,
                `Widen scope progressively: session → project → global → history.`,
              ].join("\n"),
              metadata: { count: 0 },
            }
          }
          const lines = [
            `Found ${results.length} match${results.length === 1 ? "" : "es"} (BM25-ranked, best first).`,
            `A hit here is authoritative — use it even if a parallel/sibling query returned nothing.`,
            `If you need the FULL body (snippets are truncated), Read the path.`,
            `If you need an EXACT literal (a connection string, port, token, full command line, path) and the snippet/body only paraphrases or partially shows it, the curated memory may have dropped the precise form — query the history tool for the original message, which holds it verbatim.`,
            ``,
          ]
          for (const r of results) {
            lines.push(`### ${r.path}`)
            lines.push(
              `Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`,
            )
            lines.push(r.snippet)
            lines.push("")
          }
          return {
            title: `Memory search: ${results.length} result${results.length === 1 ? "" : "s"}`,
            output: lines.join("\n"),
            metadata: { count: results.length },
          }
        }),
    }
  }),
)
