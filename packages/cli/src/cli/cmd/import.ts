import { indexImportedParts } from "../../history/import"
import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@mimo-ai/sdk/v2"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { bootstrap } from "../bootstrap"
import { Database, eq } from "../../storage"
import { isDeepStrictEqual } from "node:util"
import { SessionTable, MessageTable, PartTable } from "../../session/session.sql"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import { Filesystem } from "../../util"
import * as QueueSync from "../../inbox/sync"

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
          currentQueue.receipts.every((receipt) => receipt.state === "settled" && receipt.consumed && receipt.outcome === null &&
            receipt.idempotency_key === QueueSync.historyReceiptKey("cli", info.id, receipt.input_message_id as string))
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
        const partInfo = MessageV2.Part.parse(part)
        if (partInfo.type === "tool" && partInfo.execution === "not-started") delete partInfo.execution
        const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
        const current = tx.select().from(PartTable).where(eq(PartTable.id, partId)).get()
        if (current && (current.data.type === "tool" || partInfo.type === "tool")) {
          if (current.session_id !== row.id || current.message_id !== messageID ||
            current.data.type !== "tool" || partInfo.type !== "tool") throw new Error("Imported tool identity mismatch")
          const previous = MessageV2.ToolPart.parse({ ...current.data, id: current.id, sessionID: current.session_id, messageID: current.message_id })
          if (previous.callID !== partInfo.callID) throw new Error("Imported tool call identity mismatch")
        }
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
  describe: "import session data from local JSON without starting runs or transferring live process ownership",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to local JSON file",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    if (/^https?:\/\//i.test(args.file)) {
      UI.error("Import accepts local JSON files only")
      process.exitCode = 1
      return
    }
    await bootstrap(process.cwd(), async () => {
      type ExportData = {
        info: SDKSession
        messages: Array<{
          info: Message
          parts: Part[]
        }>
        queue?: unknown
      }

      const exportData = await Filesystem.readJson<ExportData>(args.file).catch(() => undefined)
      if (!exportData) {
        process.stdout.write(`File not found: ${args.file}`)
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
