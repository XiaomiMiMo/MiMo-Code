import { indexImportedParts } from "../history/import"
import path from "path"
import { closeSync, existsSync, openSync, readSync } from "fs"
import { Slug } from "@mimo-ai/shared/util/slug"
import { Glob } from "@mimo-ai/shared/util/glob"
import { Global } from "../global"
import { Log, Filesystem } from "../util"
import { Database, eq, and, inArray, sql } from "../storage"
import { ProjectTable } from "../project/project.sql"
import { ProjectID } from "../project/schema"
import { resolveMainGitDir, resolveProjectId } from "../project/project-id"
import { ProviderID, ModelID } from "../provider/schema"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { ExternalImportTable } from "./external-import.sql"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as QueueSync from "../inbox/sync"

const log = Log.create({ service: "claude-import" })

// Folder-name encoding Claude Code uses for a cwd (diagnostics only; scanning uses a glob).
export function encodeDir(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

function splitModel(model?: string) {
  if (!model) return { providerID: ProviderID.anthropic, modelID: ModelID.make("unknown") }
  const idx = model.indexOf("/")
  if (idx === -1) return { providerID: ProviderID.anthropic, modelID: ModelID.make(model) }
  return { providerID: ProviderID.make(model.slice(0, idx)), modelID: ModelID.make(model.slice(idx + 1)) }
}

function tokensFrom(usage: any): MessageV2.Assistant["tokens"] {
  const u = usage ?? {}
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: 0,
    cache: { read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 },
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === "object" && "type" in b && b.type === "text" ? (b as any).text : JSON.stringify(b)))
      .join("\n")
  return content == null ? "" : JSON.stringify(content)
}

type Built = { info: MessageV2.Info; parts: { part: MessageV2.Part; time: number }[] }
// The state a tool result gives the tool part it answers.
type Settle = (part: MessageV2.ToolPart) => MessageV2.ToolPart["state"]

// Yields the lines of the first `limit` bytes of a file, reading one chunk at a time, so a
// transcript is never held in memory as a whole (#1671). Synchronous because the import stores
// messages inside a database transaction, which cannot await.
export function* lines(file: string, limit: number, chunkSize = 1 << 20): Generator<string> {
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.allocUnsafe(chunkSize)
    const decoder = new TextDecoder()
    let pending: string[] = []
    let offset = 0
    while (offset < limit) {
      const read = readSync(fd, buf, 0, Math.min(chunkSize, limit - offset), offset)
      if (read === 0) break
      offset += read
      const text = decoder.decode(buf.subarray(0, read), { stream: true })
      let start = 0
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        pending.push(text.slice(start, end))
        yield pending.join("")
        pending = []
        start = end + 1
      }
      if (start < text.length) pending.push(text.slice(start))
    }
    const tail = pending.join("") + decoder.decode()
    if (tail) yield tail
  } finally {
    closeSync(fd)
  }
}

// Builds messages from transcript entries one entry at a time. A message goes to `emit` as soon
// as it is complete, so the caller can store it and let it go; a tool result that arrives after
// its message was emitted goes to `update`, with the id of the stored part.
function parser(sessionId: SessionID, emit: (message: Built) => void, update: (id: PartID, settle: Settle) => void) {
  let cwd: string | undefined
  let version: string | undefined
  let timeCreated: number | undefined
  let timeUpdated = 0
  let title: string | undefined
  let count = 0

  // Tool calls of the message being built. Once a message is emitted only the ids of its tool
  // parts are kept, so finished tool output does not pile up here.
  const toolByCall = new Map<string, { part: MessageV2.ToolPart; start: number }>()
  const storedCalls = new Map<string, { id: PartID; start: number }>()
  let current: Built | null = null
  let lastUserId: MessageID | null = null
  let lastModel = splitModel(undefined)

  const push = (message: Built) => {
    count++
    emit(message)
    for (const { part } of message.parts) {
      if (part.type !== "tool") continue
      const ref = toolByCall.get(part.callID)
      if (!ref || ref.part !== part) continue
      toolByCall.delete(part.callID)
      storedCalls.set(part.callID, { id: part.id, start: ref.start })
    }
  }
  const flushAssistant = () => {
    if (current) push(current)
    current = null
  }

  function add(entry: any) {
    if (entry.type !== "user" && entry.type !== "assistant") return
    const t = entry.timestamp ? Date.parse(entry.timestamp) : Date.now()
    if (!cwd && entry.cwd) cwd = entry.cwd
    if (!version && entry.version) version = entry.version
    if (timeCreated === undefined) timeCreated = t
    timeUpdated = Math.max(timeUpdated, t)

    const msg = entry.message
    if (!msg) return

    if (entry.type === "user") {
      const content = msg.content
      const blocks: any[] = typeof content === "string" ? [] : Array.isArray(content) ? content : []

      for (const r of blocks.filter((b) => b?.type === "tool_result")) {
        const ref = toolByCall.get(r.tool_use_id) ?? storedCalls.get(r.tool_use_id)
        if (!ref) continue
        const out = stringifyToolContent(r.content)
        const settle: Settle = (part) =>
          r.is_error
            ? { status: "error", input: part.state.input ?? {}, error: out, time: { start: ref.start, end: t } }
            : {
                status: "completed",
                input: part.state.input ?? {},
                output: out,
                title: part.tool,
                metadata: {},
                time: { start: ref.start, end: t },
              }
        if ("part" in ref) ref.part.state = settle(ref.part)
        else update(ref.id, settle)
      }

      const textBlocks =
        typeof content === "string"
          ? content.trim()
            ? [content]
            : []
          : blocks.filter((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim()).map((b) => b.text)
      const imageBlocks = blocks.filter((b) => b?.type === "image" && b.source)
      if (textBlocks.length === 0 && imageBlocks.length === 0) return

      flushAssistant()
      const id = MessageID.ascending()
      const parts: Built["parts"] = []
      for (const txt of textBlocks)
        parts.push({ part: { id: PartID.ascending(), sessionID: sessionId, messageID: id, type: "text", text: txt }, time: t })
      for (const b of imageBlocks) {
        const mime = b.source.media_type ?? "image/png"
        const url = b.source.type === "base64" ? `data:${mime};base64,${b.source.data}` : (b.source.url ?? "")
        if (url) parts.push({ part: { id: PartID.ascending(), sessionID: sessionId, messageID: id, type: "file", mime, url }, time: t })
      }
      const info: MessageV2.User = {
        id,
        sessionID: sessionId,
        role: "user",
        agent: "main",
        time: { created: t },
        model: { providerID: lastModel.providerID, modelID: lastModel.modelID },
      }
      push({ info, parts })
      lastUserId = id
      if (!title) {
        const candidate = textBlocks.find((x) => x.trim() && !x.trim().startsWith("<"))
        if (candidate) title = candidate.trim().replace(/\s+/g, " ").slice(0, 100)
      }
      return
    }

    // assistant
    const model = splitModel(msg.model)
    lastModel = model
    if (!lastUserId) {
      const uid = MessageID.ascending()
      push({
        info: {
          id: uid,
          sessionID: sessionId,
          role: "user",
          agent: "main",
          time: { created: t },
          model: { providerID: model.providerID, modelID: model.modelID },
        },
        parts: [],
      })
      lastUserId = uid
    }
    if (!current || current.info.role !== "assistant" || current.info.parentID !== lastUserId) {
      flushAssistant()
      const info: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: sessionId,
        role: "assistant",
        time: { created: t, completed: t },
        parentID: lastUserId,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "main",
        path: { cwd: cwd ?? entry.cwd ?? "", root: cwd ?? entry.cwd ?? "" },
        cost: 0,
        tokens: tokensFrom(msg.usage),
      }
      current = { info, parts: [] }
    }
    const aInfo = current.info as MessageV2.Assistant
    aInfo.time.completed = t
    aInfo.tokens = tokensFrom(msg.usage)
    const mid = current.info.id
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === "thinking" || b?.type === "reasoning") {
        current.parts.push({
          part: { id: PartID.ascending(), sessionID: sessionId, messageID: mid, type: "reasoning", text: b.thinking ?? b.text ?? "", time: { start: t, end: t } },
          time: t,
        })
      } else if (b?.type === "text" && typeof b.text === "string") {
        current.parts.push({ part: { id: PartID.ascending(), sessionID: sessionId, messageID: mid, type: "text", text: b.text }, time: t })
      } else if (b?.type === "tool_use") {
        const part: MessageV2.ToolPart = {
          id: PartID.ascending(),
          sessionID: sessionId,
          messageID: mid,
          type: "tool",
          callID: b.id,
          tool: b.name,
          state: { status: "pending", input: b.input ?? {}, raw: JSON.stringify(b.input ?? {}) },
        }
        current.parts.push({ part, time: t })
        toolByCall.set(b.id, { part, start: t })
      }
    }
  }

  // The session header, or undefined when the transcript holds no message.
  function finish() {
    flushAssistant()
    if (count === 0) return undefined
    return {
      cwd: cwd ?? "",
      version,
      title: title ?? "Claude Code session",
      timeCreated: timeCreated ?? Date.now(),
      timeUpdated: timeUpdated || timeCreated || Date.now(),
    }
  }

  return { add, finish }
}

// Reads the first `size` bytes of a transcript, hands every message to `emit` / `update` without
// keeping it, and returns the session header.
function scan(
  file: string,
  size: number,
  sessionId: SessionID,
  emit: (message: Built) => void,
  update: (id: PartID, settle: Settle) => void,
) {
  const p = parser(sessionId, emit, update)
  for (const raw of lines(file, size)) {
    const line = raw.trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    p.add(entry)
  }
  return p.finish()
}

function resolveProject(cwd: string): { id: ProjectID; worktree: string; vcs: string | null } {
  if (!cwd || !existsSync(cwd)) return { id: ProjectID.global, worktree: cwd || "/", vcs: null }
  if (!resolveMainGitDir(cwd)) return { id: ProjectID.global, worktree: cwd, vcs: null }
  return { id: resolveProjectId(cwd), worktree: cwd, vcs: "git" }
}

export async function run(opts?: { force?: boolean }) {
  const root = path.join(Global.Path.home, ".claude", "projects")
  const stats = { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] as string[] }
  if (!existsSync(root)) return stats

  const files = await Glob.scan("*/*.jsonl", { cwd: root, absolute: true })
  for (const file of files) {
    stats.scanned++
    try {
      const sourceUuid = path.basename(file, ".jsonl")
      const st = Filesystem.stat(file)
      if (!st) {
        stats.skipped++
        continue
      }
      const mtime = Math.floor(Number(st.mtimeMs))
      let existing = Database.use((db) =>
        db.select().from(ExternalImportTable).where(and(eq(ExternalImportTable.source, "cc"), eq(ExternalImportTable.source_key, sourceUuid))).get(),
      )
      if (existing && existing.source_mtime === mtime && !opts?.force) {
        stats.skipped++
        continue
      }

      const ownedMessageIDs = existing?.message_ids
      if (existing && ownedMessageIDs == null) throw new Error("Cannot resync: imported message ownership is missing")

      // Only reuse a prior import's session if that session still exists. If the
      // user deleted it in mimocode, drop the stale mapping and import fresh —
      // otherwise the update would touch zero rows and the inserts below would
      // fail the message→session foreign key.
      let existingUpdated: number | undefined
      if (existing) {
        const prior = existing
        const sess = Database.use((db) =>
          db.select({ updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, prior.session_id)).get(),
        )
        if (!sess) {
          Database.use((db) => db.delete(ExternalImportTable).where(and(eq(ExternalImportTable.source, "cc"), eq(ExternalImportTable.source_key, prior.source_key))).run())
          existing = undefined
        } else {
          existingUpdated = sess.updated
        }
      }

      const sessionId = existing ? existing.session_id : SessionID.descending()
      const messageIds: MessageID[] = []
      const partIds: PartID[] = []
      const infos: MessageV2.Info[] = []

      const imported = Database.transaction((tx) => {
        // The transcript is read a line at a time and each message is stored as soon as it is
        // built, instead of reading the whole file first (#1671). The session row needs the title
        // and times, known only at the end, so it is written last and foreign keys are checked at
        // commit. Reading stops at the size stat() returned while Claude Code may still append.
        tx.run(sql`PRAGMA defer_foreign_keys = ON`)
        const store = (m: Built) => {
          const { id, sessionID: _s, agentID: _a, ...data } = m.info
          tx.insert(MessageTable)
            .values({ id, session_id: sessionId, agent_id: "main", time_created: m.info.time.created, data })
            .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
            .run()
          for (const p of m.parts) {
            const { id: pid, sessionID: _ps, messageID: _pm, ...pdata } = p.part
            tx.insert(PartTable)
              .values({ id: pid, message_id: m.info.id, session_id: sessionId, time_created: p.time, data: pdata })
              .onConflictDoUpdate({ target: PartTable.id, set: { data: pdata } })
              .run()
            partIds.push(pid)
          }
          messageIds.push(id)
          infos.push(m.info)
        }
        const parsed = scan(file, Number(st.size), sessionId, store, (id, settle) => {
          const row = tx.select().from(PartTable).where(eq(PartTable.id, id)).get()
          const part = row && ({ ...row.data, id, sessionID: sessionId, messageID: row.message_id } as MessageV2.Part)
          if (!part || part.type !== "tool") return
          const { id: _id, sessionID: _s, messageID: _m, ...data } = { ...part, state: settle(part) }
          tx.update(PartTable).set({ data }).where(eq(PartTable.id, id)).run()
        })
        // No message: nothing was written.
        if (!parsed) return false
        const project = resolveProject(parsed.cwd)
        const now = Date.now()

        tx.insert(ProjectTable)
          .values({
            id: project.id,
            worktree: project.worktree,
            vcs: project.vcs,
            sandboxes: [],
            time_created: parsed.timeCreated,
            time_updated: parsed.timeUpdated,
          })
          .onConflictDoNothing()
          .run()

        if (existing) {
          for (let i = 0; i < ownedMessageIDs!.length; i += 500)
            tx.delete(MessageTable)
              .where(inArray(MessageTable.id, ownedMessageIDs!.slice(i, i + 500)))
              .run()
          // Preserve mimocode-owned metadata on re-sync: keep any user rename
          // (don't reset title — the Claude title is the immutable first prompt),
          // and never move time_updated backward past native activity.
          tx.update(SessionTable)
            .set({
              project_id: project.id,
              directory: parsed.cwd,
              version: parsed.version ?? "claude-code",
              time_updated: Math.max(existingUpdated ?? 0, parsed.timeUpdated),
            })
            .where(eq(SessionTable.id, sessionId))
            .run()
        } else {
          tx.insert(SessionTable)
            .values({
              id: sessionId,
              project_id: project.id,
              slug: Slug.create(),
              directory: parsed.cwd,
              title: parsed.title.trim() ? parsed.title : "Untitled",
              title_source: parsed.title.trim() ? "user" : "fallback",
              title_revision: 0,
              version: parsed.version ?? "claude-code",
              time_created: parsed.timeCreated,
              time_updated: parsed.timeUpdated,
            })
            .run()
        }

        indexImportedParts(tx, partIds)
        QueueSync.materializeHistory({
          sessionID: sessionId, source: "cc", sourceKey: sourceUuid,
          messages: infos, replacedMessageIDs: existing?.message_ids ?? [],
        }, tx)

        tx.insert(ExternalImportTable)
          .values({
            source: "cc",
            source_key: sourceUuid,
            session_id: sessionId,
            source_path: file,
            source_mtime: mtime,
            time_imported: now,
            message_ids: messageIds,
          })
          .onConflictDoUpdate({
            target: [ExternalImportTable.source, ExternalImportTable.source_key],
            set: { session_id: sessionId, source_path: file, source_mtime: mtime, time_imported: now, message_ids: messageIds },
          })
          .run()
        return true
      })
      if (!imported) {
        stats.skipped++
        continue
      }

      if (existing) stats.resynced++
      else stats.imported++
    } catch (e) {
      stats.errors.push(`${file}: ${e}`)
    }
  }

  if (stats.imported + stats.resynced > 0 || stats.errors.length > 0)
    log.info("claude import", { ...stats, errors: stats.errors.length })
  return stats
}

export * as ClaudeImport from "./claude-import"
