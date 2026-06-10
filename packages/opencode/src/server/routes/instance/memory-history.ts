import path from "path"
import os from "os"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Effect } from "effect"
import { Memory } from "@/memory"
import { History } from "@/history"
import { Config } from "@/config"
import { NotFoundError } from "@/storage"
import { MessageID, SessionID } from "@/session/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const MemorySearchResult = z
  .object({
    path: z.string(),
    snippet: z.string(),
    score: z.number(),
    scope: z.string(),
    scope_id: z.string(),
    type: z.string(),
  })
  .meta({ ref: "MemorySearchResult" })

const MemoryFile = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .meta({ ref: "MemoryFile" })

const HistoryKind = z.enum(["user_text", "assistant_text", "tool_input", "tool_error", "reasoning", "tool_output"])

const HistorySearchHit = z
  .object({
    part_id: z.string(),
    session_id: z.string(),
    message_id: z.string(),
    project_id: z.string(),
    kind: HistoryKind,
    tool_name: z.string().nullable(),
    snippet: z.string(),
    score: z.number(),
    time_created: z.number(),
  })
  .meta({ ref: "HistorySearchHit" })

const HistoryMessagePart = z.object({
  part_id: z.string(),
  type: z.string(),
  role: z.enum(["user", "assistant"]),
  tool_name: z.string().nullable(),
  text: z.string(),
})

const HistoryMessageContext = z
  .object({
    message_id: z.string(),
    matched: z.boolean(),
    time_created: z.number(),
    parts: z.array(HistoryMessagePart),
  })
  .meta({ ref: "HistoryMessageContext" })

const HistoryAround = z
  .object({
    session_id: z.string(),
    messages: z.array(HistoryMessageContext),
  })
  .meta({ ref: "HistoryAround" })

const memorySearchQuery = z.object({
  query: z.string().describe("FTS query (BM25 over markdown bodies)"),
  scope: z.enum(["global", "projects", "sessions", "cc"]).optional(),
  scope_id: z.string().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().optional(),
})

const memoryFileQuery = z.object({
  path: z.string().describe("Absolute path from a memory.search hit"),
})

const historySearchQuery = z.object({
  query: z.string().describe("FTS query over conversation trajectory"),
  scope: z.enum(["project", "global"]).optional(),
  session_id: SessionID.zod.optional(),
  kind: z.string().optional().describe("Comma-separated history kinds (e.g. user_text,assistant_text)"),
  tool_name: z.string().optional(),
  time_after: z.coerce.number().optional(),
  time_before: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
})

const historyAroundQuery = z.object({
  message_id: MessageID.zod,
  before: z.coerce.number().optional(),
  after: z.coerce.number().optional(),
})

function resolveAllowedMemoryPath(input: { absPath: string; root: string; ccBase?: string }) {
  const normalized = path.resolve(input.absPath)
  const root = path.resolve(input.root)
  if (normalized === root || normalized.startsWith(root + path.sep)) return normalized
  if (input.ccBase) {
    const cc = path.resolve(input.ccBase)
    if (normalized === cc || normalized.startsWith(cc + path.sep)) return normalized
  }
  throw new NotFoundError({ message: `Memory file not found: ${input.absPath}` })
}

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/search",
      describeRoute({
        summary: "Search project memory",
        description:
          "BM25 full-text search over indexed memory markdown (MEMORY.md, checkpoint.md, notes, task progress, optional Claude Code memory).",
        operationId: "memory.search",
        responses: {
          200: {
            description: "Ranked memory hits",
            content: {
              "application/json": {
                schema: resolver(MemorySearchResult.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", memorySearchQuery),
      async (c) =>
        jsonRequest("MemoryRoutes.search", c, function* () {
          const memory = yield* Memory.Service
          const q = c.req.valid("query")
          return yield* memory.search({
            query: q.query,
            scope: q.scope,
            scope_id: q.scope_id,
            type: q.type,
            limit: q.limit,
          })
        }),
    )
    .get(
      "/file",
      describeRoute({
        summary: "Read a memory file",
        description: "Return the full markdown body for an absolute path returned by memory.search.",
        operationId: "memory.file.get",
        responses: {
          200: {
            description: "Memory file contents",
            content: {
              "application/json": {
                schema: resolver(MemoryFile),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("query", memoryFileQuery),
      async (c) =>
        jsonRequest("MemoryRoutes.file", c, function* () {
          const memory = yield* Memory.Service
          const config = yield* Config.Service
          const cfg = yield* config.get()
          const root = yield* memory.root()
          const ccBase = cfg.memory?.cc_index ? path.join(os.homedir(), ".claude", "projects") : undefined
          const absPath = resolveAllowedMemoryPath({
            absPath: c.req.valid("query").path,
            root,
            ccBase,
          })
          const exists = yield* Effect.promise(() => Bun.file(absPath).exists())
          if (!exists) throw new NotFoundError({ message: `Memory file not found: ${absPath}` })
          const content = yield* Effect.promise(() => Bun.file(absPath).text())
          return { path: absPath, content }
        }),
    ),
)

export const HistoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/search",
      describeRoute({
        summary: "Search conversation history",
        description:
          "BM25 full-text search over indexed session trajectory (user/assistant text, tool I/O, reasoning).",
        operationId: "history.search",
        responses: {
          200: {
            description: "Ranked trajectory hits",
            content: {
              "application/json": {
                schema: resolver(HistorySearchHit.array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", historySearchQuery),
      async (c) =>
        jsonRequest("HistoryRoutes.search", c, function* () {
          const history = yield* History.Service
          const q = c.req.valid("query")
          const kind = q.kind
            ?.split(",")
            .map((k) => k.trim())
            .filter(Boolean) as z.infer<typeof HistoryKind>[] | undefined
          return yield* history.search({
            query: q.query,
            scope: q.scope,
            session_id: q.session_id,
            kind,
            tool_name: q.tool_name,
            time_after: q.time_after,
            time_before: q.time_before,
            limit: q.limit,
          })
        }),
    )
    .get(
      "/around",
      describeRoute({
        summary: "Get message context around an anchor",
        description:
          "Load neighboring messages for a trajectory search hit (same window as the history tool around operation).",
        operationId: "history.around",
        responses: {
          200: {
            description: "Message window",
            content: {
              "application/json": {
                schema: resolver(HistoryAround),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("query", historyAroundQuery),
      async (c) =>
        jsonRequest("HistoryRoutes.around", c, function* () {
          const history = yield* History.Service
          const q = c.req.valid("query")
          return yield* history.around({
            message_id: q.message_id,
            before: q.before,
            after: q.after,
          })
        }),
    ),
)
