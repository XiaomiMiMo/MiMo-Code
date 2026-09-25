import { indexImportedParts } from "../../history/import"
import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@mimo-ai/sdk/v2"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Database, eq } from "../../storage"
import { isDeepStrictEqual } from "node:util"
import { SessionTable, MessageTable, PartTable } from "../../session/session.sql"
import { Instance } from "../../project/instance"
import { ShareNext } from "../../share"
import { EOL } from "os"
import { Filesystem } from "../../util"
import { AppRuntime } from "@/effect/app-runtime"
import * as QueueSync from "../../turn-queue/sync"

/** Discriminated union returned by the ShareNext API (GET /api/shares/:id/data) */
export type ShareData =
  | { type: "session"; data: SDKSession }
  | { type: "message"; data: Message }
  | { type: "part"; data: Part }
  | { type: "session_diff"; data: unknown }
  | { type: "model"; data: unknown }

/** Extract share ID from a share URL like https://opncd.ai/share/abc123 */
export function parseShareUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/share\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

export function shouldAttachShareAuthHeaders(shareUrl: string, accountBaseUrl: string): boolean {
  try {
    return new URL(shareUrl).origin === new URL(accountBaseUrl).origin
  } catch {
    return false
  }
}

/**
 * Transform ShareNext API response (flat array) into the nested structure for local file storage.
 *
 * The API returns a flat array: [session, message, message, part, part, ...]
 * Local storage expects: { info: session, messages: [{ info: message, parts: [part, ...] }, ...] }
 *
 * This groups parts by their messageID to reconstruct the hierarchy before writing to disk.
 */
export function transformShareData(shareData: ShareData[]): {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
} | null {
  const sessionItem = shareData.find((d) => d.type === "session")
  if (!sessionItem) return null

  const messageMap = new Map<string, Message>()
  const partMap = new Map<string, Part[]>()

  for (const item of shareData) {
    if (item.type === "message") {
      messageMap.set(item.data.id, item.data)
    } else if (item.type === "part") {
      if (!partMap.has(item.data.messageID)) {
        partMap.set(item.data.messageID, [])
      }
      partMap.get(item.data.messageID)!.push(item.data)
    }
  }

  if (messageMap.size === 0) return null

  return {
    info: sessionItem.data,
    messages: Array.from(messageMap.values()).map((msg) => ({
      info: msg,
      parts: partMap.get(msg.id) ?? [],
    })),
  }
}

export function storeImportedSession(
  info: Session.Info,
  messages: readonly { info: unknown; parts: readonly unknown[] }[],
  queue?: unknown,
) {
  const snapshot = queue === undefined ? undefined : QueueSync.SnapshotSchema.parse(queue)
  if (snapshot && snapshot.sessionID !== info.id) throw new Error("Imported queue belongs to another session")
  const row = Session.toRow(info)
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()
  const parsed = messages.map((message) => {
    const msg = MessageV2.Info.parse(message.info)
    if (!snapshot && msg.role === "user") delete msg.queueAdmission
    if (msg.sessionID !== info.id || messageIDs.has(msg.id)) throw new Error(`Invalid imported message: ${msg.id}`)
    messageIDs.add(msg.id)
    const parts = message.parts.map((value) => {
      const part = MessageV2.Part.parse(value)
      if (part.sessionID !== info.id || part.messageID !== msg.id || partIDs.has(part.id))
        throw new Error(`Invalid imported part: ${part.id}`)
      partIDs.add(part.id)
      return part
    }).sort((a, b) => a.id.localeCompare(b.id))
    return { info: { ...msg, agentID: msg.agentID ?? "main" }, parts }
  }).sort((a, b) => a.info.id.localeCompare(b.info.id))
  Database.transaction((tx) => {
    const existing = tx.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get()
    if (existing) {
      const current = Array.from(MessageV2.stream(info.id, { agentID: "*" })).map((message) => ({
        info: { ...message.info, agentID: message.info.agentID ?? "main" },
        parts: message.parts.sort((a, b) => a.id.localeCompare(b.id)),
      })).sort((a, b) => a.info.id.localeCompare(b.info.id))
      const currentQueue = QueueSync.capture(info.id, tx)
      const queueMatches = snapshot
        ? isDeepStrictEqual(currentQueue, {
          ...snapshot,
          receipts: [...snapshot.receipts].sort((a, b) => a.id.localeCompare(b.id)),
          lanes: [...snapshot.lanes].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
        })
        : currentQueue.receipts.length === parsed.filter((message) => message.info.role === "user").length &&
          currentQueue.receipts.every((receipt) => receipt.intent.kind === "prompt" && receipt.state === "settled" && receipt.consumed && receipt.outcome === null &&
            receipt.idempotency_key === QueueSync.historyReceiptKey("cli", info.id, receipt.intent.messageID as string))
      if (!isDeepStrictEqual(Session.toRow(Session.fromRow(existing)), row) || !isDeepStrictEqual(current, parsed) || !queueMatches)
        throw new Error(`Imported session conflicts with existing session: ${info.id}`)
      return
    }
    tx.insert(SessionTable).values(row).run()
    for (const msg of parsed) {
      const { id, sessionID: _, agentID, ...msgData } = msg.info
      tx.insert(MessageTable)
        .values({ id, session_id: row.id, agent_id: agentID, time_created: msg.info.time.created, data: msgData })
        .run()
      for (const part of msg.parts) {
        const { id: partId, sessionID: _s, messageID, ...partData } = part
        tx.insert(PartTable)
          .values({ id: partId, message_id: messageID, session_id: row.id, data: partData })
          .run()
      }
      indexImportedParts(tx, msg.parts.map((part) => part.id))
    }
    if (snapshot) QueueSync.applySnapshot(snapshot, tx)
    else QueueSync.materializeHistory({
      sessionID: info.id, source: "cli", sourceKey: info.id, messages: parsed.map((message) => message.info),
    }, tx)
  }, { behavior: "immediate" })
}

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON or URL without starting runs or transferring live process ownership",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: SDKSession
            messages: Array<{
              info: Message
              parts: Part[]
            }>
            queue?: unknown
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        const slug = parseShareUrl(args.file)
        if (!slug) {
          const baseUrl = await AppRuntime.runPromise(ShareNext.Service.use((svc) => svc.url()))
          process.stdout.write(`Invalid URL format. Expected: ${baseUrl}/share/<slug>`)
          process.stdout.write(EOL)
          return
        }

        const parsed = new URL(args.file)
        const baseUrl = parsed.origin
        const req = await AppRuntime.runPromise(ShareNext.Service.use((svc) => svc.request()))
        const headers = shouldAttachShareAuthHeaders(args.file, req.baseUrl) ? req.headers : {}

        const dataPath = req.api.data(slug)
        let response = await fetch(`${baseUrl}${dataPath}`, {
          headers,
        })

        if (!response.ok && dataPath !== `/api/share/${slug}/data`) {
          response = await fetch(`${baseUrl}/api/share/${slug}/data`, {
            headers,
          })
        }

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const shareData: ShareData[] = await response.json()
        const transformed = transformShareData(shareData)

        if (!transformed) {
          process.stdout.write(`Share not found or empty: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = transformed
      } else {
        exportData = await Filesystem.readJson<NonNullable<typeof exportData>>(args.file).catch(() => undefined)
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      const info = Session.Info.parse({
        ...exportData.info,
        title: exportData.info.title || "Untitled",
        titleSource: exportData.queue === undefined ? (exportData.info.title ? "user" : "fallback") : exportData.info.titleSource,
        titleRevision: exportData.queue === undefined ? 0 : exportData.info.titleRevision,
        projectID: Instance.project.id,
      })
      storeImportedSession(info, exportData.messages, exportData.queue)

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
