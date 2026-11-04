import type { ModelMessage } from "ai"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { normalizeToolResult } from "./tool-result"
import { neutralizeHarnessTags } from "@/tool/mcp-tool-search"
import { Effect } from "effect"
import * as Storage from "@/storage/storage"
import { createHash } from "node:crypto"
import { Log } from "@/util"

const log = Log.create({ service: "mcp.app-context" })

export interface AppContextValue {
  content?: CallToolResult["content"]
  structuredContent?: Record<string, unknown>
}
// One slot per App server: a newer View of the same App supersedes older ones instead of accumulating.
const key = (session: string, server: string) => [
  "mcp-app-context",
  session,
  createHash("sha256").update(server).digest("hex"),
]
const empty = (value: AppContextValue) =>
  !value.content?.length && (value.structuredContent === undefined || !Object.keys(value.structuredContent).length)
export const updateAppContext = (session: string, server: string, value: AppContextValue) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    if (empty(value)) yield* storage.remove(key(session, server))
    else yield* storage.write(key(session, server), value)
  })
/** Context is advisory: an unreadable slot is skipped rather than failing the model call. */
export const readAppContext = (session: string) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const keys = yield* storage.list(["mcp-app-context", session])
    const values = yield* Effect.forEach(keys, (key) =>
      storage.read<AppContextValue>(key).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("skip unreadable App context", { key, error })
          }).pipe(Effect.as(undefined)),
        ),
      ),
    )
    return values.filter((value): value is AppContextValue => !!value && !empty(value))
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn("App context unavailable", { session, error })
      }).pipe(Effect.as([] as AppContextValue[])),
    ),
  )

/**
 * App context is third-party state, not the user's words: it is fenced as host-injected
 * and its text cannot close or forge the fence. Media stays as model content parts.
 */
export function appContextMessages(values: AppContextValue[]): ModelMessage[] {
  return values.map((value) => {
    const normalized = normalizeToolResult({ content: value.content ?? [], structuredContent: value.structuredContent })
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<system-reminder>",
            "Current MCP App context, provided by an open MCP App rather than typed by the user:",
            neutralizeHarnessTags(normalized.output),
            "</system-reminder>",
          ].join("\n"),
        },
        ...normalized.attachments.map((item) =>
          item.mime.startsWith("image/")
            ? { type: "image" as const, image: new URL(item.url), mediaType: item.mime }
            : { type: "file" as const, data: new URL(item.url), mediaType: item.mime },
        ),
      ],
    }
  })
}
