import { Effect } from "effect"
import z from "zod"
import { History } from "@/history"
import { Provider } from "@/provider"
import { routeToolAttachment } from "@/session/tool-attachment"
import { cleanDataUrls, page } from "@/history/media"
import DESCRIPTION from "./history.txt"
import * as Tool from "./tool"

const parameters = z
  .object({
    operation: z.enum(["search", "around", "get"]),
    query: z.string().optional(),
    scope: z.enum(["project", "global"]).optional(),
    session_id: z.string().optional(),
    kind: z
      .array(z.enum(["user_text", "assistant_text", "tool_input", "tool_error", "reasoning", "tool_output"]))
      .min(1)
      .optional(),
    tool_name: z.string().optional(),
    time_after: z.number().finite().optional(),
    time_before: z.number().finite().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    message_id: z.string().optional(),
    before: z.number().int().min(0).max(50).optional(),
    after: z.number().int().min(0).max(50).optional(),
    part_id: z.string().optional(),
    offset: z.number().int().min(0).optional().describe("UTF-16 cursor; use next_offset from the previous page"),
    length: z.number().int().min(1).max(8000).optional().describe("Default 4000"),
    attachment: z.string().min(1).optional().describe("Explicit single attachment locator from get"),
  })
  .strict()

const BUDGET = 19500
const OMIT = "[More summaries omitted; narrow search/around or call get on the part_id you need.]"
const ANCHOR_TRUNCATED = "[Anchor truncated; remaining parts omitted — call get on the part_id you need.]"

function bounded(lines: string[]) {
  const result: string[] = []
  let bytes = 0
  let truncated = false
  for (const line of lines) {
    if (bytes + Buffer.byteLength(line) + 1 > BUDGET) {
      truncated = true
      break
    }
    result.push(line)
    bytes += Buffer.byteLength(line) + 1
  }
  if (truncated) result.push(OMIT)
  return { text: result.join("\n"), truncated }
}

// Keep the anchor even when it alone exceeds the budget: fully when it fits,
// otherwise partial (message header + as many part lines as fit). Fill the
// remaining budget around it in chronological order.
function aroundBlocks(
  messages: Array<{
    matched: boolean
    message_id: string
    time_created: number
    parts: Array<{ part_id: string; role: string; type: string; text: string }>
  }>,
) {
  const blocks = messages.map((m) => ({
    matched: m.matched,
    lines: [
      `${m.matched ? ">>>" : "---"} message_id=${m.message_id} time=${m.time_created}`,
      ...m.parts.map((p) => `part_id=${p.part_id} ${p.role} ${p.type}\n${p.text}`),
    ],
  }))
  const picked: typeof blocks = []
  let bytes = 0
  const limit = BUDGET - Buffer.byteLength(OMIT) - 1
  const take = (b: (typeof blocks)[number], allowPartial = false) => {
    const size = b.lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0)
    if (bytes + size <= limit) {
      picked.push(b)
      bytes += size
      return true
    }
    if (!allowPartial || b.lines.length === 0) return false
    // Partial anchor: keep the message_id header plus every part line that still
    // fits, reserving room for the truncation marker.
    const partial: string[] = []
    let used = 0
    const markerSize = Buffer.byteLength(ANCHOR_TRUNCATED) + 1
    for (const line of b.lines) {
      const lineSize = Buffer.byteLength(line) + 1
      if (bytes + used + lineSize + markerSize > limit) break
      partial.push(line)
      used += lineSize
    }
    if (partial.length === 0) {
      // Even the header does not fit after earlier picks — still force it in
      // so the caller can address this message; drop whatever else was picked.
      const header = b.lines[0]!
      picked.length = 0
      picked.push({ ...b, lines: [header] })
      bytes = Buffer.byteLength(header) + 1
      return true
    }
    picked.push({
      ...b,
      lines: [...partial, ANCHOR_TRUNCATED],
    })
    bytes += used + markerSize
    return true
  }
  const anchor = blocks.find((b) => b.matched)
  if (anchor) take(anchor, true)
  for (const b of blocks) {
    if (b === anchor) continue
    if (!take(b)) break
  }
  const truncated =
    picked.length < blocks.length || (anchor !== undefined && (picked[0] !== anchor || picked[0]!.lines.length !== anchor.lines.length))
  return { picked, truncated }
}

export const HistoryTool = Tool.define(
  "history",
  Effect.gen(function* () {
    const history = yield* History.Service
    const provider = yield* Provider.Service
    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx) =>
        Effect.gen(function* () {
          const reply = (output: string, count = 0, truncated = false) => ({
            title: `History ${args.operation}`,
            output,
            metadata: { count, truncated },
          })
          if (args.operation === "get") {
            if (!args.part_id) return reply("operation=get requires part_id.")
            const result = yield* history
              .get({ ...args, part_id: args.part_id })
              .pipe(Effect.catch((error) => Effect.succeed(error)))
            if (result instanceof Error) return reply(result.message)
            if (!result) return reply("Part not found.")
            if (args.attachment) {
              const attachment = result.attachments.find((x) => x.id === args.attachment)
              if (!attachment) return reply("Attachment not found; use get without attachment to list locators.")
              if (/^file:/i.test(attachment.url))
                return reply(
                  "Cannot display historical file:// media. Use read with normal path permissions; no file was read.",
                )
              const ref = [...ctx.messages]
                .reverse()
                .map((m) => m.info)
                .find((m) => m.role === "user")
              const model =
                (ctx.extra?.model as Provider.Model | undefined) ??
                (ref?.role === "user"
                  ? yield* provider
                      .getModel(ref.model.providerID, ref.model.modelID)
                      .pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
                  : undefined)
              if (!model || routeToolAttachment({ model, attachment, allowNative: true }) === "placeholder")
                return reply(
                  "Cannot display this attachment: current model capability or provider routing does not support it. Its content has not been viewed.",
                )
              return {
                ...reply("Requested attachment supplied through the media channel.", 1),
                attachments: [
                  { type: "file" as const, mime: attachment.mime, url: attachment.url, filename: attachment.filename },
                ],
              }
            }
            const locators = result.attachments.map(
              (a) => `attachment=${a.id} mime=${page(cleanDataUrls(a.mime), 0, 120, 240).text}`,
            )
            const list = page(bounded(locators).text, 0, 2000, 2000).text
            const ranges = ["inline", "tool", "file"]
              .map((kind) => {
                const count = result.attachments.filter((a) => a.id.startsWith(`${kind}:`)).length
                return `${kind}: ${count ? `0..${count - 1} (${count} attachments)` : "none"}`
              })
              .join("; ")
            return reply(
              `offset=${result.offset} next_offset=${result.next_offset} total_length=${result.total_length} has_more=${result.has_more}\n${result.has_more ? `Continue: history operation=get with the same part_id, offset=${result.next_offset}.` : "End of detail."}\n${result.text}\n\nAttachments (${result.attachments.length}; request one with attachment): ${ranges}\n${list}${Buffer.byteLength(locators.join("\n")) > 2000 ? "\n[Attachment list omitted beyond budget; all locators are in the pageable detail. Continue using next_offset to discover them.]" : ""}`,
              1,
            )
          }
          if (args.operation === "search") {
            if (!args.query) return reply("operation=search requires query.")
            const hits = yield* history.search({ ...args, query: args.query })
            if (!hits.length) return reply("0 matches. Broaden the query or use memory search.")
            const out = bounded([
              `Found ${hits.length} matches. Summaries only; use history operation=get part_id=... for full details.`,
              ...hits.map(
                (h) =>
                  `### session_id=${h.session_id} message_id=${h.message_id} part_id=${h.part_id} time=${h.time_created}\n${h.kind} ${h.tool_name ?? ""} score=${h.score.toFixed(3)}\n${h.snippet}`,
              ),
            ])
            return reply(out.text, hits.length, out.truncated)
          }
          if (!args.message_id) return reply("operation=around requires message_id.")
          const result = yield* history.around({ ...args, message_id: args.message_id })
          if (!result.messages.length) return reply("Anchor message not found.")
          const { picked, truncated } = aroundBlocks(result.messages)
          return reply(
            [
              `Session ${result.session_id}. Summaries only; use history operation=get part_id=... for full details.`,
              ...picked.flatMap((b) => b.lines),
              ...(truncated ? [OMIT] : []),
            ].join("\n"),
            result.messages.length,
            truncated,
          )
        }),
    }
  }),
)
