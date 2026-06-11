import { Effect } from "effect"
import z from "zod"
import { History } from "@/history"
import DESCRIPTION from "./history.txt"
import * as Tool from "./tool"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

const KIND = z.enum([
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_error",
  "reasoning",
  "tool_output",
])

// around() output can easily be tens of KB (multi-message contexts with full
// part bodies including reasoning/tool blocks). Capping below the global
// MAX_BYTES nudges agents toward "search → message_id → targeted Read" instead
// of one giant inline dump. Only history.around uses this; other tools keep
// the framework default.
const AROUND_MAX_BYTES = 20 * 1024

const parameters = z.object({
  operation: z.enum(["search", "around"]).describe("search: FTS BM25; around: pull message context"),
  // search params
  query: z.string().optional().describe("FTS query (BM25 over text/tool bodies). Required for operation=search."),
  scope: z.enum(["project", "global"]).optional().describe("Default project."),
  session_id: z.string().optional(),
  kind: z.array(KIND).optional(),
  tool_name: z.string().optional().describe("Filter to a specific tool (e.g. Bash, Read)"),
  time_after: z.number().optional().describe("Unix ms"),
  time_before: z.number().optional(),
  limit: z.number().optional().describe("Max 50, default 10"),
  // around params
  message_id: z.string().optional().describe("Anchor message id. Required for operation=around."),
  before: z.number().optional().describe("Default 5"),
  after: z.number().optional().describe("Default 5"),
})

export const HistoryTool = Tool.define(
  "history",
  Effect.gen(function* () {
    const history = yield* History.Service
    const truncate = yield* Truncate.Service
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx) =>
        Effect.gen(function* () {
          if (args.operation === "search") {
            if (!args.query) {
              return {
                title: "History search: missing query",
                output: "operation=search requires a `query` argument.",
                metadata: { count: 0 },
              }
            }
            const hits = yield* history.search({
              query: args.query,
              scope: args.scope,
              session_id: args.session_id,
              kind: args.kind,
              tool_name: args.tool_name,
              time_after: args.time_after,
              time_before: args.time_before,
              limit: args.limit,
            })
            if (hits.length === 0) {
              return {
                title: "History search: 0 matches",
                output: `0 matches for "${args.query}". Try memory search if you haven't, or broaden the query.`,
                metadata: { count: 0 },
              }
            }
            const lines = [`Found ${hits.length} match${hits.length === 1 ? "" : "es"}:`, ""]
            for (const h of hits) {
              const kindLabel = h.tool_name ? `${h.kind} · ${h.tool_name}` : h.kind
              lines.push(`### ${h.session_id} ${h.message_id}  (${kindLabel})`)
              lines.push(`Time: ${new Date(h.time_created).toISOString()}, Score: ${h.score.toFixed(3)}`)
              lines.push(h.snippet)
              lines.push("")
            }
            return {
              title: `History search: ${hits.length} match${hits.length === 1 ? "" : "es"}`,
              output: lines.join("\n"),
              metadata: { count: hits.length },
            }
          }

          // operation=around
          if (!args.message_id) {
            return {
              title: "History around: missing message_id",
              output: "operation=around requires a `message_id` argument.",
              metadata: { count: 0 },
            }
          }
          const around = yield* history.around({
            message_id: args.message_id,
            before: args.before,
            after: args.after,
          })
          if (around.messages.length === 0) {
            return {
              title: "History around: anchor not found",
              output: `No message with id ${args.message_id}.`,
              metadata: { count: 0 },
            }
          }
          const lines = [
            `Session ${around.session_id}, ${around.messages.length} messages (anchor ${args.message_id}):`,
            "",
          ]
          for (const m of around.messages) {
            const prefix = m.matched ? ">>>" : "---"
            lines.push(`${prefix} ${m.message_id} (${new Date(m.time_created).toISOString()})`)
            for (const p of m.parts) {
              const head = p.tool_name ? `${p.type} (${p.tool_name})` : p.type
              lines.push(`  ${p.role} · ${head}:`)
              lines.push(p.text.split("\n").map((l) => `    ${l}`).join("\n"))
            }
            lines.push("")
          }
          const rawOutput = lines.join("\n")
          // around() output is naturally large; cap below the framework default
          // and let the truncation file fallback handle the overflow. The
          // metadata.truncated set here also opts us out of tool.ts wrap's
          // global truncate call (see tool.ts:110).
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(rawOutput, { maxBytes: AROUND_MAX_BYTES }, agent)
          return {
            title: `History around ${args.message_id}`,
            output: truncated.content,
            metadata: {
              count: around.messages.length,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }),
    }
  }),
)
