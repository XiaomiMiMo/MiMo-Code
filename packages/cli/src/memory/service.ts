import { Context, Effect, Layer } from "effect"
import path from "path"
import os from "os"
import * as fs from "fs/promises"
import { createHash } from "crypto"
import { and, or } from "drizzle-orm"
import { Global } from "../global"
import { Database, eq } from "../storage"
import { Config } from "../config"
import { reconcileMemory } from "./reconcile"
import { buildFtsQuery } from "./fts-query"
import { restoreSearchSnippet, SNIPPET_START, SNIPPET_END, SNIPPET_ELLIPSIS } from "./search-text"
import * as SemanticCandidates from "../semantic/candidates"
import { MemoryFtsTable } from "./fts.sql"

export type HybridResult = {
  path: string
  snippet: string
  scope: string
  scope_id: string
  type: string
  retrieval: "lexical" | "semantic" | "both"
  rank: number
  score?: number
}

type SearchRow = {
  path: string
  scope: string
  scope_id: string
  type: string
  snippet: string
  body: string
  score: number
}

type HybridScope = { scope: string; scope_id?: string }

function hybridScopeAuthorized(input: {
  scope?: string
  scope_id?: string
  current_project_id?: string
  current_session_id?: string
}): boolean {
  if (!input.scope) return true
  if (input.scope === "projects") {
    const hasCurrentIDs = !!input.current_project_id || !!input.current_session_id
    return hasCurrentIDs
      ? !!input.current_project_id && (!input.scope_id || input.scope_id === input.current_project_id)
      : !!input.scope_id
  }
  if (input.scope === "sessions") {
    const hasCurrentIDs = !!input.current_project_id || !!input.current_session_id
    return hasCurrentIDs
      ? !!input.current_session_id && (!input.scope_id || input.scope_id === input.current_session_id)
      : !!input.scope_id
  }
  return input.scope !== "projects" && input.scope !== "sessions"
}

function hybridLexicalScopes(input: {
  scope?: string
  scope_id?: string
  current_project_id?: string
  current_session_id?: string
}): HybridScope[] {
  if (input.scope) {
    const scope_id = input.scope_id ?? (input.scope === "projects" ? input.current_project_id : input.scope === "sessions" ? input.current_session_id : undefined)
    return [{ scope: input.scope, ...(scope_id ? { scope_id } : {}) }]
  }
  const scopes: HybridScope[] = [{ scope: "global" }]
  if (input.current_project_id) scopes.push({ scope: "projects", scope_id: input.current_project_id })
  if (input.current_session_id) scopes.push({ scope: "sessions", scope_id: input.current_session_id })
  if (!input.scope_id) return scopes
  return scopes.filter((scope) => scope.scope_id === input.scope_id)
}

function isExactIdentifierQuery(query: string): boolean {
  const value = query.trim()
  return (
    /(?:^|\b)(?:ses|msg|prt|tsk)_[a-z0-9_-]+\b/i.test(value) ||
    /\b[a-z]{2,8}_[a-z0-9]{8,}\b/i.test(value) ||
    /(?:^|\s)(?:\/|\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/])\S+/i.test(value) ||
    /(?:^|\s)[\w@.+-]+\.[a-z0-9]{1,8}(?=$|\s|[:),])/i.test(value) ||
    /(?:^|\s)--?[a-z][a-z0-9-]*(?:=[^\s]+)?(?=$|\s)/i.test(value) ||
    /\b[a-z_$][\w$]*(?:::[a-z_$][\w$]*|\.[a-z_$][\w$]*\s*\(|\s*\(\s*\))/i.test(value) ||
    /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(value) ||
    /^\s*[0-9a-f]{12,64}\s*$/i.test(value) ||
    /(?:Traceback \(most recent call last\)|\bat\s+.+\(|\bFile ".+", line \d+|\b[\w./\\-]+:\d+(?::\d+)?\b)/i.test(value)
  )
}

export interface Interface {
  readonly root: () => Effect.Effect<string>
  readonly reconcile: () => Effect.Effect<{ indexed: number; pruned: number }>
  readonly search: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
  }) => Effect.Effect<
    Array<{ path: string; snippet: string; score: number; scope: string; scope_id: string; type: string }>
  >
  readonly hybridSearch: (input: {
    query: string
    scope?: string
    scope_id?: string
    type?: string
    limit?: number
    signal?: AbortSignal
    feature?: SemanticCandidates.SemanticFeature
    current_project_id?: string
    current_session_id?: string
  }) => Effect.Effect<HybridResult[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Memory") {}

export const layer: Layer.Layer<Service, never, Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const root = path.join(Global.Path.data, "memory")
    const ccBase = path.join(os.homedir(), ".claude", "projects")

    const rootEff = Effect.fn("Memory.root")(function* () {
      return root
    })

    const reconcile = Effect.fn("Memory.reconcile")(function* () {
      const cfg = yield* config.get()
      const cc = cfg.memory?.cc_index ? ccBase : undefined
      return yield* Effect.promise(() => reconcileMemory({ mimo: root, cc }))
    })

    const search = Effect.fn("Memory.search")(function* (input: {
      query: string
      scope?: string
      scope_id?: string
      type?: string
      limit?: number
      hybrid_scopes?: HybridScope[]
    }) {
      // Lazy reconcile before search (covers off-tool writes); honour config flag.
      const cfg = yield* config.get()
      if (cfg.checkpoint?.memory_reconcile_on_search ?? true) {
        const cc = cfg.memory?.cc_index ? ccBase : undefined
        yield* Effect.promise(() => reconcileMemory({ mimo: root, cc }))
      }

      const limit = input.limit ?? 10
      // Build a token-level FTS5 query: punctuation becomes separators,
      // each alphanumeric run becomes a phrase-quoted literal, OR-joined.
      // See packages/cli/src/memory/fts-query.ts for the rationale.
      const ftsQuery = buildFtsQuery(input.query)
      if (!ftsQuery) return []

      // OR-join means a doc matching only a common word (e.g. every
      // checkpoint.md matches "checkpoint") still matches, but BM25 ranks it
      // far below a doc matching several rare query words. We drop the
      // common-word noise with a RELATIVE floor: keep results scoring at
      // least `ratio` of the top hit's score. Relative (not absolute)
      // because BM25 magnitudes are corpus-size-dependent — in a tiny corpus
      // every score collapses toward 0 (low IDF), so any fixed absolute floor
      // would wrongly wipe real hits. The #1 result is ALWAYS kept (a match
      // is a match even when BM25 can't discriminate). Default 0.15.
      // Configurable; 0 disables (keep all matches).
      const floorRatio = cfg.checkpoint?.memory_search_score_floor ?? 0.15

      // Construct WHERE clauses for scope/scope_id/type filtering
      const conditions: string[] = []
      const params: string[] = []
      if (input.scope) {
        conditions.push("memory_fts.scope = ?")
        params.push(input.scope)
      }
      if (input.scope_id) {
        conditions.push("memory_fts.scope_id = ?")
        params.push(input.scope_id)
      }
      if (input.type) {
        conditions.push("memory_fts.type = ?")
        params.push(input.type)
      }
      if (input.hybrid_scopes) {
        if (input.hybrid_scopes.length === 0) return []
        conditions.push(`(${input.hybrid_scopes.map((scope) => {
          if (scope.scope_id) {
            params.push(scope.scope, scope.scope_id)
            return "(memory_fts.scope = ? AND memory_fts.scope_id = ?)"
          }
          params.push(scope.scope)
          return "(memory_fts.scope = ?)"
        }).join(" OR ")})`)
      }
      const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : ""

      const sql = `
        SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type, memory_fts.body,
               snippet(memory_fts_idx, 0, ?, ?, ?, 32) AS snippet,
               bm25(memory_fts_idx) AS score
        FROM memory_fts_idx
        JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
        WHERE memory_fts_idx MATCH ?
        ${whereClause}
        ORDER BY score
        LIMIT ?
      `

      // Over-fetch (3x, capped) so the relative floor can trim common-word
      // noise without starving the list when there ARE enough real hits.
      const fetchLimit = Math.min(limit * 3, 50)
      // `prepare` rather than `query`: both bun:sqlite and node:sqlite expose it with the
      // same `.all(...positionalParams)` shape, so this path works under either driver
      // (`#db` resolves to node:sqlite outside Bun). `query`'s statement cache is Bun-only,
      // and caching buys little here — the SQL varies with the filter clause.
      const rows = Database.Client().$client.prepare(sql)
        .all(SNIPPET_START, SNIPPET_END, SNIPPET_ELLIPSIS, ftsQuery, ...params, fetchLimit) as SearchRow[]

      // FTS5 bm25() returns lower = better; convert to higher = better for caller
      const mapped = rows.map((r) => ({
        path: r.path,
        snippet: restoreSearchSnippet(r.body, r.snippet),
        score: -r.score,
        scope: r.scope,
        scope_id: r.scope_id,
        type: r.type,
      }))
      if (mapped.length === 0) return []
      // Rows are ORDER BY score (best first), so mapped[0] is the top hit.
      // Always keep it; drop trailing rows below `floorRatio` of its score.
      const topScore = mapped[0].score
      const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity
      return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
    })

    const hybridSearch = Effect.fn("Memory.hybridSearch")(function* (input: {
      query: string
      scope?: string
      scope_id?: string
      type?: string
      limit?: number
      signal?: AbortSignal
      feature?: SemanticCandidates.SemanticFeature
      current_project_id?: string
      current_session_id?: string
    }) {
      if (!hybridScopeAuthorized(input)) return []
      // Lexical retrieval remains the complete fallback and retains its BM25 score.
      const lexicalScopes = hybridLexicalScopes(input)
      const lexical = yield* search({ ...input, hybrid_scopes: lexicalScopes })
      const limit = input.limit ?? 10
      const lexicalFallback = () => lexical.slice(0, limit).map((row, index) => ({
        ...row,
        retrieval: "lexical" as const,
        rank: index + 1,
      }))
      const merged = new Map<string, HybridResult>()
      lexical.forEach((row, index) => merged.set(path.resolve(row.path), {
        ...row,
        retrieval: "lexical",
        rank: 1 / (60 + index + 1),
      }))

      // Implicit semantic recall is limited to shared global memory and this
      // invocation's project/session. Explicit scope never widens.
      const effectiveScopeID = input.scope_id ?? (input.scope === "projects" ? input.current_project_id : input.scope === "sessions" ? input.current_session_id : undefined)
      if (
        !SemanticCandidates.enabled(input.feature ?? "memory") ||
        isExactIdentifierQuery(input.query) ||
        !input.query.trim() ||
        (input.scope && (input.scope === "projects" || input.scope === "sessions" || input.scope === "cc") && !effectiveScopeID)
      ) return lexicalFallback()

      const scopeFilter = input.scope
        ? and(
            eq(MemoryFtsTable.scope, input.scope),
            ...(effectiveScopeID ? [eq(MemoryFtsTable.scope_id, effectiveScopeID)] : []),
          )
        : or(
            eq(MemoryFtsTable.scope, "global"),
            ...(input.current_project_id ? [and(eq(MemoryFtsTable.scope, "projects"), eq(MemoryFtsTable.scope_id, input.current_project_id))] : []),
            ...(input.current_session_id ? [and(eq(MemoryFtsTable.scope, "sessions"), eq(MemoryFtsTable.scope_id, input.current_session_id))] : []),
          )
      const filteredScope = input.scope || !input.scope_id
        ? scopeFilter
        : and(scopeFilter, eq(MemoryFtsTable.scope_id, input.scope_id))
      const conditions = [filteredScope, ...(input.type ? [eq(MemoryFtsTable.type, input.type)] : [])]
      const eligible = Database.use((db) => db.select({
        path: MemoryFtsTable.path,
        scope: MemoryFtsTable.scope,
        scope_id: MemoryFtsTable.scope_id,
        type: MemoryFtsTable.type,
        body: MemoryFtsTable.body,
      }).from(MemoryFtsTable).where(and(...conditions)).all())
      const allowed = eligible.map((row) => row.path)
      if (!allowed.length) return lexicalFallback()

      const semantic = yield* Effect.promise(() => SemanticCandidates.search({
        corpus: "memory",
        query: input.query,
        allowed,
        limit: Math.min(limit * 3, 50),
        signal: input.signal,
      }))
      if (semantic.status !== "ok") return lexicalFallback()

      const byPath = new Map(eligible.map((row) => [path.resolve(row.path), row]))
      const seenSemanticPaths = new Set<string>()
      for (const candidate of [...semantic.hits].sort((a, b) => a.rank - b.rank)) {
        const canonicalPath = path.resolve(candidate.source)
        const row = byPath.get(canonicalPath)
        if (!row || candidate.source !== row.path || !allowed.includes(row.path) || !candidate.text) continue
        const currentRow = Database.use((db) => db.select({
          path: MemoryFtsTable.path,
          scope: MemoryFtsTable.scope,
          scope_id: MemoryFtsTable.scope_id,
          type: MemoryFtsTable.type,
          body: MemoryFtsTable.body,
        }).from(MemoryFtsTable).where(eq(MemoryFtsTable.path, candidate.source)).get())
        if (
          !currentRow || currentRow.scope !== row.scope || currentRow.scope_id !== row.scope_id ||
          currentRow.type !== row.type || currentRow.body !== row.body
        ) continue
        // The database is only an index. Re-read the source and require it to
        // still match the indexed body and requested scope/type before display.
        const current = yield* Effect.promise(() => fs.readFile(row.path, "utf8").catch(() => ""))
        if (!current || current !== currentRow.body || !current.includes(candidate.text)) continue
        const signature = createHash("sha1").update(candidate.text, "utf8").digest("hex").slice(0, 12)
        if (candidate.signature !== signature) continue
        const scopeAllowed = input.scope
          ? currentRow.scope === input.scope && (!effectiveScopeID || currentRow.scope_id === effectiveScopeID)
          : currentRow.scope === "global" ||
            (currentRow.scope === "projects" && currentRow.scope_id === input.current_project_id) ||
            (currentRow.scope === "sessions" && currentRow.scope_id === input.current_session_id)
        if (!scopeAllowed || (effectiveScopeID && currentRow.scope_id !== effectiveScopeID) || (input.type && currentRow.type !== input.type)) continue
        if (seenSemanticPaths.has(canonicalPath)) continue
        seenSemanticPaths.add(canonicalPath)
        const existing = merged.get(canonicalPath)
        if (existing) {
          existing.retrieval = "both"
          existing.rank += 1 / (60 + candidate.rank)
          continue
        }
        // Semantic text is an untrusted excerpt; source is verified and shown
        // so the caller can inspect the authoritative file before relying on it.
        merged.set(canonicalPath, {
          path: row.path,
          snippet: candidate.text,
          scope: currentRow.scope,
          scope_id: currentRow.scope_id,
          type: currentRow.type,
          retrieval: "semantic",
          rank: 1 / (60 + candidate.rank),
        })
      }
      return [...merged.values()]
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map((row, index) => ({ ...row, rank: index + 1 }))
    })

    return Service.of({
      root: rootEff,
      reconcile,
      search,
      hybridSearch,
    })
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(Config.defaultLayer)))
