import path from "path"
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { Slug } from "@mimo-ai/shared/util/slug"
import { Glob } from "@mimo-ai/shared/util/glob"
import { Global } from "../global"
import { Log, Filesystem } from "../util"
import { Database, eq, and, inArray } from "../storage"
import { ProjectTable } from "../project/project.sql"
import { ProjectID } from "../project/schema"
import { resolveMainGitDir, resolveProjectId } from "../project/project-id"
import { ProviderID, ModelID } from "../provider/schema"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { ExternalImportTable } from "./external-import.sql"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"

const log = Log.create({ service: "codex-import" })

type Built = { info: MessageV2.Info; parts: { part: MessageV2.Part; time: number }[] }

function parseTimestamp(ts: string | undefined): number {
  if (!ts) return Date.now()
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? Date.now() : ms
}

function resolveProject(cwd: string): { id: ProjectID; worktree: string; vcs: string | null } {
  if (!cwd || !existsSync(cwd)) return { id: ProjectID.global, worktree: cwd || "/", vcs: null }
  if (!resolveMainGitDir(cwd)) return { id: ProjectID.global, worktree: cwd, vcs: null }
  return { id: resolveProjectId(cwd), worktree: cwd, vcs: "git" }
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return { raw }
    }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  return {}
}

export function parse(text: string, sessionId: SessionID) {
  const entries = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  if (entries.length === 0) return undefined

  let cwd: string | undefined
  let version: string | undefined
  let sessionUuid: string | undefined
  let timeCreated: number | undefined
  let timeUpdated = 0
  let title: string | undefined

  const messages: Built[] = []
  const toolByCallId = new Map<string, { part: MessageV2.ToolPart; start: number }>()
  let current: Built | null = null
  let lastUserId: MessageID | null = null

  const flushAssistant = () => {
    if (current) messages.push(current)
    current = null
  }

  // Open (or reuse) the assistant message that reasoning / tool calls attach to.
  // Codex emits reasoning and tool calls before the assistant text — and sometimes
  // before any assistant message at all — so we must materialize the assistant here
  // rather than dropping the part when nothing is open yet.
  const ensureAssistant = (ts: number): Built => {
    if (!lastUserId) {
      const uid = MessageID.ascending()
      messages.push({
        info: {
          id: uid,
          sessionID: sessionId,
          role: "user",
          agent: "main",
          time: { created: ts },
          model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("unknown") },
        },
        parts: [],
      })
      lastUserId = uid
    }
    if (!current || current.info.role !== "assistant") {
      flushAssistant()
      const info: MessageV2.Assistant = {
        id: MessageID.ascending(),
        sessionID: sessionId,
        role: "assistant",
        time: { created: ts, completed: ts },
        parentID: lastUserId,
        modelID: ModelID.make("unknown"),
        providerID: ProviderID.make("openai"),
        mode: "build",
        agent: "main",
        path: { cwd: cwd ?? "", root: cwd ?? "" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      current = { info, parts: [] }
    }
    ;(current.info as MessageV2.Assistant).time.completed = ts
    return current
  }

  for (const entry of entries) {
    const type = entry.type as string
    const payload = entry.payload as Record<string, unknown> | undefined
    const ts = parseTimestamp(entry.timestamp as string)
    if (timeCreated === undefined) timeCreated = ts
    timeUpdated = Math.max(timeUpdated, ts)

    if (type === "session_meta" && payload) {
      cwd = payload.cwd as string | undefined
      version = `codex-${payload.cli_version ?? "unknown"}`
      sessionUuid = payload.id as string | undefined
      const metaTs = parseTimestamp(payload.timestamp as string)
      if (timeCreated === undefined || metaTs < timeCreated) timeCreated = metaTs
      continue
    }

    if (type !== "response_item" || !payload) continue

    const itemType = payload.type as string

    if (itemType === "message") {
      const role = payload.role as string
      const content = (payload.content as Array<Record<string, unknown>>) ?? []

      if (role === "user" || role === "developer") {
        const textBlocks = content
          .filter((c) => (c.type === "input_text" || c.type === "text") && typeof c.text === "string" && (c.text as string).trim())
          .map((c) => c.text as string)
        if (textBlocks.length === 0) continue

        flushAssistant()
        const id = MessageID.ascending()
        const parts: Built["parts"] = textBlocks.map((txt) => ({
          part: { id: PartID.ascending(), sessionID: sessionId, messageID: id, type: "text" as const, text: txt },
          time: ts,
        }))
        const info: MessageV2.User = {
          id,
          sessionID: sessionId,
          role: "user",
          agent: "main",
          time: { created: ts },
          model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("unknown") },
        }
        messages.push({ info, parts })
        lastUserId = id
        if (!title) {
          const candidate = textBlocks.find((x) => x.trim() && !x.trim().startsWith("<"))
          if (candidate) title = candidate.trim().replace(/\s+/g, " ").slice(0, 100)
        }
        continue
      }

      if (role === "assistant") {
        const assistant = ensureAssistant(ts)

        for (const c of content) {
          if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string" && (c.text as string).trim()) {
            assistant.parts.push({
              part: { id: PartID.ascending(), sessionID: sessionId, messageID: assistant.info.id, type: "text", text: c.text as string },
              time: ts,
            })
          }
        }
        continue
      }
      continue
    }

    if (itemType === "reasoning") {
      const assistant = ensureAssistant(ts)
      const summary = payload.summary as Array<Record<string, unknown>> | undefined
      const summaryText = summary?.map((s) => s.text ?? "").join("") ?? ""
      if (summaryText.trim()) {
        assistant.parts.push({
          part: {
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: assistant.info.id,
            type: "reasoning",
            text: summaryText,
            time: { start: ts, end: ts },
          },
          time: ts,
        })
      }
      continue
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const assistant = ensureAssistant(ts)
      const callId = payload.call_id as string ?? PartID.ascending()
      const name = payload.name as string ?? "unknown"
      const input = itemType === "function_call"
        ? parseArguments(payload.arguments)
        : { raw: (payload.input as string) ?? "" }
      const part: MessageV2.ToolPart = {
        id: PartID.ascending(),
        sessionID: sessionId,
        messageID: assistant.info.id,
        type: "tool",
        callID: callId,
        tool: name,
        state: { status: "pending", input, raw: JSON.stringify(input) },
      }
      assistant.parts.push({ part, time: ts })
      toolByCallId.set(callId, { part, start: ts })
      continue
    }

    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      const callId = payload.call_id as string
      const ref = callId ? toolByCallId.get(callId) : undefined
      if (!ref) continue
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "")
      ref.part.state = {
        status: "completed",
        input: ref.part.state.input ?? {},
        output,
        title: ref.part.tool,
        metadata: {},
        time: { start: ref.start, end: ts },
      }
      continue
    }
  }

  flushAssistant()

  if (messages.length === 0) return undefined

  return {
    cwd: cwd ?? "",
    version: version ?? "codex",
    sessionUuid,
    title: title ?? "Codex session",
    timeCreated: timeCreated ?? Date.now(),
    timeUpdated: timeUpdated || timeCreated || Date.now(),
    messages,
  }
}

export type ImportStats = {
  scanned: number
  imported: number
  resynced: number
  skipped: number
  errors: string[]
}

export async function run(opts?: { force?: boolean }): Promise<ImportStats> {
  const root = path.join(Global.Path.home, ".codex", "sessions")
  const stats: ImportStats = { scanned: 0, imported: 0, resynced: 0, skipped: 0, errors: [] }
  if (!existsSync(root)) return stats

  const files = await Glob.scan("**/*.jsonl", { cwd: root, absolute: true })
  for (const file of files) {
    stats.scanned++
    try {
      const sourceKey = path.basename(file, ".jsonl")
      const st = Filesystem.stat(file)
      if (!st) {
        stats.skipped++
        continue
      }
      const mtime = Math.floor(Number(st.mtimeMs))
      let existing = Database.use((db) =>
        db
          .select()
          .from(ExternalImportTable)
          .where(and(eq(ExternalImportTable.source, "codex"), eq(ExternalImportTable.source_key, sourceKey)))
          .get(),
      )
      if (existing && existing.source_mtime === mtime && !opts?.force) {
        stats.skipped++
        continue
      }

      let existingUpdated: number | undefined
      if (existing) {
        const sess = Database.use((db) =>
          db.select({ updated: SessionTable.time_updated }).from(SessionTable).where(eq(SessionTable.id, existing!.session_id)).get(),
        )
        if (!sess) {
          Database.use((db) =>
            db
              .delete(ExternalImportTable)
              .where(and(eq(ExternalImportTable.source, "codex"), eq(ExternalImportTable.source_key, existing!.source_key)))
              .run(),
          )
          existing = undefined
        } else {
          existingUpdated = sess.updated
        }
      }

      const sessionId = existing ? existing.session_id : SessionID.descending()
      const parsed = parse(await readFile(file, "utf-8"), sessionId)
      if (!parsed || parsed.messages.length === 0) {
        stats.skipped++
        continue
      }

      const project = resolveProject(parsed.cwd)
      const now = Date.now()
      const messageIds = parsed.messages.map((m) => m.info.id)

      Database.transaction((tx) => {
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
          if (existing.message_ids?.length) {
            for (let i = 0; i < existing.message_ids.length; i += 500)
              tx.delete(MessageTable)
                .where(inArray(MessageTable.id, existing.message_ids.slice(i, i + 500)))
                .run()
          } else {
            tx.delete(MessageTable).where(eq(MessageTable.session_id, sessionId)).run()
          }
          tx.update(SessionTable)
            .set({
              project_id: project.id,
              directory: parsed.cwd,
              version: parsed.version,
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
              title: parsed.title,
              version: parsed.version,
              time_created: parsed.timeCreated,
              time_updated: parsed.timeUpdated,
            })
            .run()
        }

        for (const m of parsed.messages) {
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
          }
        }

        tx.insert(ExternalImportTable)
          .values({
            source: "codex",
            source_key: sourceKey,
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
      })

      if (existing) stats.resynced++
      else stats.imported++
    } catch (e) {
      stats.errors.push(`${file}: ${e}`)
    }
  }

  if (stats.imported + stats.resynced > 0 || stats.errors.length > 0)
    log.info("codex import", { ...stats, errors: stats.errors.length })
  return stats
}

export * as CodexImport from "./codex-import"
