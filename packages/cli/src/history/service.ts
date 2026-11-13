import { Context, Effect, Layer } from "effect"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Database } from "../storage"
import { MessageTable, PartTable, SessionTable } from "../session/session.sql"
import { detail, page, summary } from "./media"
import { projection } from "./projection"
import type { PartID } from "../session/schema"
import type { MessageID } from "../session/schema"
import type { MessageV2 } from "../session/message-v2"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { buildFtsQuery } from "./fts-query"
import { basePartId } from "./chunk"
import { layer as writerLayer, Service as WriterService } from "./writer"
import { createHash } from "node:crypto"
import * as Semantic from "../semantic/candidates"
import { extract } from "./extract"

export type SearchHit = {
  part_id: string
  session_id: string
  message_id: string
  project_id: string
  tool_name: string | null
  snippet: string
  score: number
  time_created: number
}

export type HybridSearchHit = SearchHit | (Omit<SearchHit, "score"> & { bm25_score?: number; rank: number; retrieval: "fts" | "semantic" | "hybrid" })

export type MessagePart = {
  part_id: string
  type: string
  role: "user" | "assistant"
  tool_name: string | null
  text: string
}

export type MessageContext = {
  message_id: string
  matched: boolean
  time_created: number
  parts: MessagePart[]
}

export interface Interface {
  /** Optional rank-fused retrieval; unavailable results leave exact FTS search authoritative. */
  readonly hybridSearch: (input: Parameters<Interface["search"]>[0] & { signal?: AbortSignal }) => Effect.Effect<HybridSearchHit[]>
  readonly get: (input: {
    part_id: string
    offset?: number
    length?: number
  }) => Effect.Effect<(ReturnType<typeof page> & ReturnType<typeof detail>) | undefined, Error>

  readonly search: (input: {
    query: string
    scope?: "project" | "global"
    session_id?: string
    /** Internal retrieval guard; omitted by the public History tool. */
    exclude_session_id?: string
    /** Internal actor isolation; omitted by the public History tool. */
    agent_id?: string
    tool_name?: string
    time_after?: number
    time_before?: number
    limit?: number
  }) => Effect.Effect<SearchHit[]>

  readonly around: (input: {
    message_id: string
    before?: number
    after?: number
  }) => Effect.Effect<{ session_id: string; messages: MessageContext[] }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/History") {}

const HARD_CAP = 50
const SEMANTIC_ALLOWED_CAP = 200_000
const SEMANTIC_KINDS = ["user_text", "assistant_text", "summary_text", "compaction"] as const

function semanticBypass(query: string): boolean {
  const value = query.trim()
  if (!value) return true
  if (/^(?:ses|msg|prt|part)_[A-Za-z0-9_-]+$/i.test(value)) return true
  if (/^[a-f0-9]{7,64}$/i.test(value)) return true
  if (/(?:^|\s)--?[A-Za-z][\w-]*(?:=\S+)?(?:\s|$)/.test(value)) return true
  if (/(?:^|[A-Za-z]:)[/\\]/.test(value) || /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|md|json|ya?ml|toml)(?::\d+(?::\d+)?)?$/i.test(value)) return true
  if (/^\s*(?:at\s+.+\(.+\)|Traceback \(most recent call last\):|(?:\w+Error|Exception):)/m.test(value)) return true
  return !/\s/.test(value) && /[.$:#<>()[\]{}]/.test(value)
}

type Row = {
  part_id: string
  session_id: string
  message_id: string
  project_id: string
  tool_name: string | null
  snippet: string
  score: number
  time_created: number
}

export const defaultLayer: Layer.Layer<Service | WriterService, never, never> = Layer.suspend(() =>
  Layer.mergeAll(layer, writerLayer).pipe(Layer.provide(Bus.defaultLayer)),
)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const search = Effect.fn("History.search")(function* (input: Parameters<Interface["search"]>[0]) {
      const { fts: ftsQuery } = buildFtsQuery(input.query)
      if (!ftsQuery) return []

      const limit = Math.min(input.limit ?? 10, HARD_CAP)
      const conditions: string[] = []
      const params: (string | number)[] = []

      const scope = input.scope ?? "project"
      if (scope === "project") {
        conditions.push("history_fts.project_id = ?")
        params.push(Instance.project.id)
      }

      if (input.session_id) {
        conditions.push("history_fts.session_id = ?")
        params.push(input.session_id)
      }
      if (input.exclude_session_id) {
        conditions.push("history_fts.session_id <> ?")
        params.push(input.exclude_session_id)
      }
      const agentID = input.agent_id === undefined ? undefined : input.agent_id || "main"
      if (agentID) {
        conditions.push("EXISTS (SELECT 1 FROM message history_message WHERE history_message.id = history_fts.message_id AND COALESCE(NULLIF(history_message.agent_id, ''), 'main') = ?)")
        params.push(agentID)
      }
      if (input.tool_name) {
        conditions.push("history_fts.tool_name = ?")
        params.push(input.tool_name)
      }
      if (input.time_after !== undefined) {
        conditions.push("history_fts.time_created >= ?")
        params.push(input.time_after)
      }
      if (input.time_before !== undefined) {
        conditions.push("history_fts.time_created <= ?")
        params.push(input.time_before)
      }

      const whereClause = conditions.length ? `AND ${conditions.join(" AND ")}` : ""
      // CROSS JOIN fixes the loop order in SQLite: MATCH once, then rowid lookup.
      // Node SQLite may otherwise scan a project first and rerun MATCH per row.
      const sqlText = `
        SELECT history_fts.part_id, history_fts.session_id, history_fts.message_id,
               history_fts.project_id, history_fts.tool_name,
               history_fts.time_created,
               history_fts.body AS body_full,
               bm25(history_fts_idx) AS score
        FROM history_fts_idx
        CROSS JOIN history_fts ON history_fts.rowid = history_fts_idx.rowid
        WHERE 1=1
          ${ftsQuery ? "AND history_fts_idx MATCH ?" : ""}
          ${whereClause}
        ORDER BY score
        LIMIT ?
      `
      // `prepare` rather than `query`: both bun:sqlite and node:sqlite expose it with the same
      // `.all(...positionalParams)` shape, so this path works under either driver (`#db`
      // resolves to node:sqlite outside Bun). See the same note in memory/service.ts.
      const rows = Database.Client()
        .$client.prepare(sqlText)
        .all(ftsQuery, ...params, limit) as Row[]
      const seen = new Set<string>()
      const hits = []
      for (const r of rows) {
        const partId = basePartId(r.part_id)
        if (seen.has(partId)) continue
        seen.add(partId)
        const bodyFull = String((r as { body_full?: string }).body_full ?? "")
        // C15: locate with FTS-like tokens (AND/punct phrases; Han isolated; NFD map).
        const map: number[] = []
        const chars: string[] = []
        for (let i = 0; i < bodyFull.length; i++) {
          const folded = (bodyFull[i] ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
          for (const c of folded) { chars.push(c); map.push(i) }
        }
        const hayN = chars.join("")
        const qn = input.query.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        const segments = qn.split(/[、，,。.；;：:！!？?（）()【】\[\]「」“”"'|/\\]+/).map((s) => s.trim()).filter(Boolean)
        let hitAt = -1
        const tokenizePhrase = (w: string) =>
          w.split(/(?<=\p{Script=Han})|(?=\p{Script=Han})|_/u).filter(Boolean)
        const findSeq = (tokens: string[]) => {
          const isHan = (s: string) => s.length === 1 && /\p{Script=Han}/u.test(s)
          const re = new RegExp(
            tokens.map((w, i) => {
              const body = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              const sep = i === 0 ? "" : isHan(tokens[i - 1]!) || isHan(w) ? "[^\\p{L}\\p{N}]*" : "[^\\p{L}\\p{N}]+"
              return sep + body
            }).join(""),
            "giu",
          )
          const badEdge = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c) && !/\p{Script=Han}/u.test(c)
          let m: RegExpExecArray | null
          while ((m = re.exec(hayN))) {
            const s = m.index
            const e = s + m[0].length
            const first = tokens[0]!
            const last = tokens[tokens.length - 1]!
            if (!isHan(first) && badEdge(hayN[s - 1])) continue
            if (!isHan(last) && badEdge(hayN[e])) continue
            return map[s] ?? -1
          }
          return -1
        }
        // Structure matches buildFtsQuery: punct segments → AND; each space-separated
        // word is one phrase. Han–Han may run together; Latin tokens need a real break.
        for (const seg of segments) {
          const words = seg.match(/[\p{L}\p{N}_]+/gu) ?? []
          if (!words.length) continue
          if (segments.length >= 2 || words.length === 1 || !/\s/.test(seg)) {
            // one phrase (punct segment or single/contiguous word group)
            const at = findSeq(tokenizePhrase(words.join("_")))
            if (at >= 0 && (hitAt < 0 || at < hitAt)) hitAt = at
          } else {
            // space-separated multi-word AND: each word is its own phrase
            for (const w of words) {
              const at = findSeq(tokenizePhrase(w))
              if (at >= 0 && (hitAt < 0 || at < hitAt)) hitAt = at
            }
          }
        }
        const winStart = Math.max(0, hitAt - 200)
        const snippet = bodyFull.slice(winStart, winStart + 1000)
        hits.push({
          part_id: partId,
          session_id: r.session_id,
          message_id: r.message_id,
          project_id: r.project_id,
          tool_name: r.tool_name,
          snippet: summary(snippet),
          score: -r.score,
          time_created: r.time_created,
        })
        if (hits.length >= limit) break
      }
      return hits
    })

    const hybridSearch = Effect.fn("History.hybridSearch")(function* (input: Parameters<Interface["search"]>[0] & { signal?: AbortSignal }) {
      const lexical = yield* search(input)
      const lexicalFallback = (): HybridSearchHit[] => lexical
      // Keep exact identifiers, paths, flags, code symbols, hashes, and traces on the
      // established lexical path so punctuation and separators retain their meaning.
      if (semanticBypass(input.query)) return lexicalFallback()

      const scopeFilters: string[] = []
      const scopeParams: (string | number)[] = []
      if ((input.scope ?? "project") === "project") { scopeFilters.push("s.project_id = ?"); scopeParams.push(Instance.project.id) }
      if (input.session_id) { scopeFilters.push("p.session_id = ?"); scopeParams.push(input.session_id) }
      if (input.exclude_session_id) { scopeFilters.push("p.session_id <> ?"); scopeParams.push(input.exclude_session_id) }
      const agentID = input.agent_id === undefined ? undefined : input.agent_id || "main"
      if (agentID) { scopeFilters.push("COALESCE(NULLIF(m.agent_id, ''), 'main') = ?"); scopeParams.push(agentID) }
      if (input.tool_name) { scopeFilters.push("json_extract(p.data, '$.tool') = ?"); scopeParams.push(input.tool_name) }
      const scopeWhere = scopeFilters.map((item) => `AND ${item}`).join(" ")
      // Read only eligible live part IDs and scalar metadata. Exceeding the provider's
      // hard bound falls back to exact FTS instead of searching an arbitrary prefix.
      const partRows = Database.Client().$client.prepare(`
        SELECT p.id AS part_id, p.session_id, p.message_id, s.project_id,
               COALESCE(NULLIF(m.agent_id, ''), 'main') AS agent_id,
               json_extract(p.data, '$.tool') AS tool_name, p.time_created
        FROM part p JOIN session s ON s.id = p.session_id JOIN message m ON m.id = p.message_id
        WHERE 1=1 ${scopeWhere}
        LIMIT ?
      `).all(...scopeParams, SEMANTIC_ALLOWED_CAP + 1) as Array<{
        part_id: string; session_id: string; message_id: string; project_id: string; agent_id: string;
        tool_name: string | null; time_created: number
      }>
      if (partRows.length > SEMANTIC_ALLOWED_CAP) return lexicalFallback()
      const currentByPart = new Map(partRows.map((row) => [row.part_id, row]))
      const ftsFilters: string[] = ["kind IN (?, ?, ?, ?)"]
      const ftsParams: (string | number)[] = [...SEMANTIC_KINDS]
      if ((input.scope ?? "project") === "project") { ftsFilters.push("project_id = ?"); ftsParams.push(Instance.project.id) }
      if (input.session_id) { ftsFilters.push("session_id = ?"); ftsParams.push(input.session_id) }
      if (input.exclude_session_id) { ftsFilters.push("session_id <> ?"); ftsParams.push(input.exclude_session_id) }
      if (agentID) {
        ftsFilters.push("EXISTS (SELECT 1 FROM message history_message WHERE history_message.id = history_fts.message_id AND COALESCE(NULLIF(history_message.agent_id, ''), 'main') = ?)")
        ftsParams.push(agentID)
      }
      if (input.tool_name) { ftsFilters.push("tool_name = ?"); ftsParams.push(input.tool_name) }
      if (input.time_after !== undefined) { ftsFilters.push("time_created >= ?"); ftsParams.push(input.time_after) }
      if (input.time_before !== undefined) { ftsFilters.push("time_created <= ?"); ftsParams.push(input.time_before) }
      const ftsWhere = ftsFilters.map((item) => `AND ${item}`).join(" ")
      // This is one bounded, indexed scope scan. Chunk IDs remain exact source IDs;
      // no per-part OR/GLOB join can degrade into a corpus-wide nested loop.
      const ftsRows = Database.Client().$client.prepare(`
        SELECT part_id, session_id, message_id, project_id, tool_name, time_created, kind
        FROM history_fts
        WHERE 1=1 ${ftsWhere}
        LIMIT ?
      `).all(...ftsParams, SEMANTIC_ALLOWED_CAP + 1) as Array<{
        part_id: string; session_id: string; message_id: string; project_id: string;
        tool_name: string | null; time_created: number; kind: string
      }>
      if (!ftsRows.length || ftsRows.length > SEMANTIC_ALLOWED_CAP) return lexicalFallback()
      const allowedRows = ftsRows.filter((row) => {
        const current = currentByPart.get(basePartId(row.part_id) as PartID)
        if (!current) return false
        if (current.session_id !== row.session_id || current.message_id !== row.message_id || current.project_id !== row.project_id || current.tool_name !== row.tool_name) return false
        if ((input.scope ?? "project") === "project" && current.project_id !== Instance.project.id) return false
        if (input.session_id && current.session_id !== input.session_id) return false
        if (input.exclude_session_id && current.session_id === input.exclude_session_id) return false
        if (agentID && current.agent_id !== agentID) return false
        if (input.tool_name && current.tool_name !== input.tool_name) return false
        return true
      })
      const allowed = [...new Set(allowedRows.map((row) => row.part_id))].sort()
      if (!allowed.length) return lexicalFallback()
      const semantic = yield* Effect.tryPromise({
        try: () => Semantic.search({ corpus: "traj", query: input.query, allowed, limit: Math.min(input.limit ?? 10, HARD_CAP), signal: input.signal }),
        catch: () => new Error("Semantic history search failed"),
      }).pipe(Effect.catch(() => Effect.succeed({ status: "unavailable" as const })))
      if (semantic.status !== "ok") return lexicalFallback()
      // Re-read authoritative original part and message data after the provider call.
      // FTS is an asynchronous preview and cannot establish freshness by itself.
      const candidateSources = [...new Set(semantic.hits.slice(0, HARD_CAP).map((candidate) => candidate.source).filter((source) => allowed.includes(source)))]
      if (!candidateSources.length) return lexicalFallback()
      const liveFtsRows = Database.Client().$client.prepare(`
        SELECT part_id, session_id, message_id, project_id, tool_name, time_created, kind
        FROM history_fts
        WHERE part_id IN (${candidateSources.map(() => "?").join(",")})
      `).all(...candidateSources) as Array<{
        part_id: string; session_id: string; message_id: string; project_id: string;
        tool_name: string | null; time_created: number; kind: string
      }>
      const ftsBySource = new Map(liveFtsRows.map((row) => [row.part_id, row]))
      const candidateBases = [...new Set(candidateSources.map((source) => basePartId(source)))].map((id) => id as PartID)
      if (!candidateBases.length) return lexicalFallback()
      const liveRows = Database.use((db) => db
        .select({
          part_id: PartTable.id,
          session_id: PartTable.session_id,
          message_id: PartTable.message_id,
          project_id: SessionTable.project_id,
          part: PartTable.data,
          role: sql<"user" | "assistant">`json_extract(${MessageTable.data}, '$.role')`,
          summary: sql<boolean>`json_extract(${MessageTable.data}, '$.summary')`,
          agent_id: sql<string>`COALESCE(NULLIF(${MessageTable.agent_id}, ''), 'main')`,
          time_created: PartTable.time_created,
        })
        .from(PartTable)
        .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
        .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
        .where(inArray(PartTable.id, candidateBases))
        .all())
      const liveByPart = new Map(liveRows.map((row) => [row.part_id, row]))
      const semHits: SearchHit[] = []
      const seenSemantic = new Set<string>()
      for (const candidate of semantic.hits) {
        const source = basePartId(candidate.source)
        const ftsRow = ftsBySource.get(candidate.source)
        const row = liveByPart.get(source as PartID)
        if (!row || !ftsRow || seenSemantic.has(source)) continue
        if (candidate.partID && basePartId(candidate.partID) !== source) continue
        if (!allowed.includes(candidate.source)) continue
        if (candidate.sessionID !== row.session_id || candidate.messageID !== row.message_id || candidate.time !== ftsRow.time_created) continue
        if (ftsRow.session_id !== row.session_id || ftsRow.message_id !== row.message_id || ftsRow.project_id !== row.project_id) continue
        if (candidate.kind !== ftsRow.kind) continue
        if ((input.scope ?? "project") === "project" && row.project_id !== Instance.project.id) continue
        if (input.session_id && row.session_id !== input.session_id) continue
        if (input.exclude_session_id && row.session_id === input.exclude_session_id) continue
        if (agentID && row.agent_id !== agentID) continue
        if (input.time_after !== undefined && ftsRow.time_created < input.time_after) continue
        if (input.time_before !== undefined && ftsRow.time_created > input.time_before) continue
        const current = extract({ ...row.part, id: row.part_id, sessionID: row.session_id, messageID: row.message_id } as unknown as MessageV2.Part, row.role, { summary: row.summary })
        if (!current || !SEMANTIC_KINDS.includes(current.kind as (typeof SEMANTIC_KINDS)[number])) continue
        if (ftsRow.tool_name !== current.tool_name) continue
        if (input.tool_name && current.tool_name !== input.tool_name) continue
        if (candidate.kind !== current.kind || !current.body.includes(candidate.text)) continue
        const signature = createHash("sha1").update(candidate.text, "utf8").digest("hex").slice(0, 12)
        if (!candidate.text || signature !== candidate.signature) continue
        seenSemantic.add(source)
        semHits.push({ part_id: source, session_id: row.session_id, message_id: row.message_id, project_id: row.project_id, tool_name: current.tool_name, snippet: summary(candidate.text), score: 0, time_created: ftsRow.time_created })
      }
      if (!semHits.length) return lexicalFallback()
      const limit = Math.min(input.limit ?? 10, HARD_CAP)
      const fused = new Map<string, { hit: SearchHit; score: number; bm25_score?: number; lexicalRank: number; semanticRank: number }>()
      const add = (hit: SearchHit, rank: number, source: "lexical" | "semantic") => {
        const value = fused.get(hit.part_id) ?? { hit, score: 0, lexicalRank: Number.MAX_SAFE_INTEGER, semanticRank: Number.MAX_SAFE_INTEGER }
        value.score += 1 / (60 + rank)
        if (source === "lexical") { value.lexicalRank = rank; value.bm25_score = hit.score }
        else { value.semanticRank = rank; if (value.lexicalRank === Number.MAX_SAFE_INTEGER) value.hit = hit }
        fused.set(hit.part_id, value)
      }
      lexical.forEach((hit, index) => add(hit, index + 1, "lexical"))
      semHits.forEach((hit, index) => add(hit, index + 1, "semantic"))
      return [...fused.values()].sort((a, b) => b.score - a.score || Math.min(a.lexicalRank, a.semanticRank) - Math.min(b.lexicalRank, b.semanticRank) || a.hit.part_id.localeCompare(b.hit.part_id)).slice(0, limit).map((item, index) => {
        const { score, ...hit } = item.hit
        const bm25_score = item.bm25_score ?? (item.lexicalRank < Number.MAX_SAFE_INTEGER ? score : undefined)
        return {
        ...hit,
        ...(bm25_score === undefined ? {} : { bm25_score }),
        rank: index + 1,
        retrieval: item.lexicalRank < Number.MAX_SAFE_INTEGER ? item.semanticRank < Number.MAX_SAFE_INTEGER ? "hybrid" as const : "fts" as const : "semantic" as const,
      }
      })
    })

    const around = Effect.fn("History.around")(function* (input: Parameters<Interface["around"]>[0]) {
      const before = input.before ?? 5
      const after = input.after ?? 5
      const anchor = Database.use((db) =>
        db
          .select({
            id: MessageTable.id,
            session_id: MessageTable.session_id,
            time_created: MessageTable.time_created,
          })
          .from(MessageTable)
          .where(eq(MessageTable.id, input.message_id as MessageID))
          .get(),
      )
      if (!anchor) return { session_id: "", messages: [] }

      const beforeRows = Database.use((db) =>
        db
          .select({
            id: MessageTable.id,
            time_created: MessageTable.time_created,
            role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
          })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, anchor.session_id),
              sql`(${MessageTable.time_created} < ${anchor.time_created} OR (${MessageTable.time_created} = ${anchor.time_created} AND ${MessageTable.id} <= ${anchor.id}))`,
            ),
          )
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(before + 1)
          .all(),
      )
      const afterRows = Database.use((db) =>
        db
          .select({
            id: MessageTable.id,
            time_created: MessageTable.time_created,
            role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
          })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, anchor.session_id),
              sql`(${MessageTable.time_created} > ${anchor.time_created} OR (${MessageTable.time_created} = ${anchor.time_created} AND ${MessageTable.id} > ${anchor.id}))`,
            ),
          )
          .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
          .limit(after)
          .all(),
      )

      const messages = [...beforeRows.reverse(), ...afterRows]
      if (messages.length === 0) return { session_id: anchor.session_id, messages: [] }
      const parts = Database.use((db) =>
        db
          .select(projection(true))
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, anchor.session_id),
              sql`${PartTable.message_id} IN (${sql.join(
                messages.map((m) => sql`${m.id}`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(asc(PartTable.message_id), asc(PartTable.id))
          .all(),
      )

      const byMessage = new Map<string, typeof parts>()
      for (const p of parts) {
        const list = byMessage.get(p.message_id) ?? []
        list.push(p)
        byMessage.set(p.message_id, list)
      }
      // Non-LLM search projection: PartID-asc is fine. Compose head order is a
      // MessageV2 hydrate invariant for prompt/fork prefixes (see
      // promoteComposeProtocolFirst); history summaries do not feed those paths.

      const out: MessageContext[] = messages.map((m) => {
        const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant"
        const partsHere = (byMessage.get(m.id) ?? []).map((p) => {
          const d = p.data as {
            type: string
            text?: string
            tool?: string
            state?: { input?: unknown; output?: unknown; error?: string }
          }
          const text = detail(d, false).text
          return {
            part_id: p.id,
            type: d.type,
            role,
            tool_name: d.type === "tool" ? (d.tool ?? null) : null,
            text: summary(text),
          }
        })
        return {
          message_id: m.id,
          matched: m.id === input.message_id,
          time_created: m.time_created,
          parts: partsHere,
        }
      })

      return { session_id: anchor.session_id, messages: out }
    })

    const get = Effect.fn("History.get")(function* (input: Parameters<Interface["get"]>[0]) {
      const row = Database.use((db) =>
        db
          .select({ data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.id, basePartId(input.part_id) as PartID))
          .get(),
      )
      if (!row) return undefined
      const result = detail(row.data)
      const slice = yield* Effect.try({
        try: () => page(result.text, input.offset, input.length),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      return { ...result, ...slice }
    })

    return Service.of({ search, hybridSearch, around, get })
  }),
)
