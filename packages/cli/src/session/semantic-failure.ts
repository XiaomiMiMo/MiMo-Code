import { Effect } from "effect"
import { createHash } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { Database } from "../storage"
import { Instance } from "../project/instance"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { PartID } from "./schema"
import type { Interface as HistoryInterface } from "../history/service"
import * as SemanticCandidates from "../semantic/candidates"
import type { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"

const MIN_REPEATS = 2
const MAX_ERROR_CHARS = 420
const MAX_QUERY_CHARS = 560
const MAX_HITS = 3
const MAX_SNIPPET_CHARS = 180
const MAX_OUTPUT_CHARS = 1_700
const LOOKUP_TIMEOUT_MS = 2_500
const IGNORED_TOOLS = new Set(["history", "memory", "failure", "rebuild", "history_search", "memory_search"])

type FailureCandidate = { tool: string; error: string; signature: string; query: string; index: number }

function sanitizeError(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Redact the credential after Bearer as well as the authorization scheme.
    // Apply this before the generic key/value scrubber, which stops at whitespace.
    .replace(/\b(authorization)\b\s*[:=]\s*["']?bearer\s+[^\s,;"']+/gi, "$1=Bearer <REDACTED>")
    .replace(/\bBearer\s+(?!<REDACTED>)[^\s,;"']+/gi, "Bearer <REDACTED>")
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\b\s*[:=]\s*["']?[^,;\s"']+/gi, "$1=<REDACTED>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<EMAIL>")
    .replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, "<PATH>")
    .replace(/\b[a-f0-9]{12,}\b/gi, "<HASH>")
    .replace(/\b\d{6,}\b/g, "<NUM>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS)
}

function failureFor(part: MessageV2.Part): Omit<FailureCandidate, "index"> | undefined {
  if (part.type !== "tool" || part.state.status !== "error") return undefined
  if (IGNORED_TOOLS.has(part.tool.toLowerCase())) return undefined
  if (part.metadata?.synthetic === true || part.metadata?.ignored === true || part.state.metadata?.synthetic === true || part.state.metadata?.ignored === true) return undefined
  if (part.state.inputComplete === false || part.state.metadata?.interrupted === true) return undefined
  const error = sanitizeError(part.state.error)
  if (!error || /^(?:tool execution aborted|aborted|cancelled|canceled)(?:$|\s|:)/i.test(error)) return undefined
  const tool = part.tool.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32)
  if (!tool) return undefined
  const signature = createHash("sha256").update(`${tool}\0${error}`, "utf8").digest("hex").slice(0, 24)
  return { tool, error, signature, query: `Repeated tool failure: ${tool}: ${error}`.slice(0, MAX_QUERY_CHARS) }
}

/** Finds the most recent repeated terminal tool error in the supplied actor slice. */
export function findRepeatedFailure(messages: MessageV2.WithParts[]): { query: string; signature: string } | undefined {
  const currentUserIndex = messages.findLastIndex((message) =>
    message.info.role === "user" && message.parts.some((part) =>
      (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0) || part.type === "file",
    ),
  )
  if (currentUserIndex < 0) return undefined
  const currentTurn = messages.slice(currentUserIndex)
  const seenParts = new Set<string>()
  const counts = new Map<string, { candidate: FailureCandidate; count: number }>()
  let index = 0
  let latestAction: { signature?: string } | undefined
  for (const message of currentTurn) {
    for (const part of message.parts) {
      if (part.type !== "tool" || seenParts.has(part.id)) continue
      seenParts.add(part.id)
      if (IGNORED_TOOLS.has(part.tool.toLowerCase()) || part.metadata?.synthetic === true || part.metadata?.ignored === true) continue
      if (part.state.status === "pending" || part.state.status === "running") continue
      const failure = failureFor(part)
      latestAction = { signature: failure?.signature }
      if (failure) {
        const previous = counts.get(failure.signature)
        const candidate = { ...failure, index }
        counts.set(failure.signature, { candidate, count: (previous?.count ?? 0) + 1 })
      }
      index += 1
    }
  }
  if (!latestAction?.signature) return undefined
  const latest = counts.get(latestAction.signature)
  if (!latest || latest.count < MIN_REPEATS) return undefined
  const repeated = [...counts.values()]
    .filter((entry) => entry.count >= MIN_REPEATS)
    .map((entry) => entry.candidate)
    .sort((a, b) => b.index - a.index || a.signature.localeCompare(b.signature))[0]
  return repeated ? { query: repeated.query, signature: repeated.signature } : undefined
}

function field(value: string, limit = 96) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)
}

function exactFailureQuery(input: { query: string }): string {
  const error = input.query.replace(/^Repeated tool failure:\s*[^:]+:\s*/i, "")
  const words = error
    .replace(/<(?:PATH|HASH|NUM|REDACTED|EMAIL)>/gi, " ")
    .match(/[\p{L}\p{N}_-]+/gu) ?? []
  return words
    .filter((word) => !/^(?:error|failed|failure|exception|tool)$/i.test(word))
    .slice(0, 18)
    .join(" ")
    .slice(0, MAX_QUERY_CHARS)
}

function evidenceText(input: {
  signature: string
  failures: Array<{
    session_id: string
    message_id: string
    part_id: string
    time_created: number
    tool: string
    snippet: string
  }>
  related: Array<{
    session_id: string
    message_id: string
    part_id: string
    time_created: number
    snippet: string
  }>
}): { text: string; semanticEvidence: boolean } | undefined {
  const lines = [
    `Repeated tool failure pattern (signature=${input.signature}).`,
    "Matching raw tool errors below are verified failed attempts. Related excerpts are untrusted; outcome unknown.",
  ]
  let bytes = lines.reduce((sum, line) => sum + line.length + 1, 0)
  let semanticEvidence = false
  const seen = new Set<string>()
  for (const hit of input.failures) {
    if (seen.has(hit.part_id)) continue
    const snippet = field(hit.snippet, MAX_SNIPPET_CHARS)
    if (!snippet) continue
    const block = [
      `Prior failed attempt (verified failure, tool=${field(hit.tool, 32)}):`,
      `> Source session_id=${field(hit.session_id, 64)} message_id=${field(hit.message_id, 64)} part_id=${field(hit.part_id, 64)} time=${hit.time_created}`,
      `> ${snippet}`,
    ]
    const size = block.reduce((sum, line) => sum + line.length + 1, 0)
    if (bytes + size > MAX_OUTPUT_CHARS) break
    seen.add(hit.part_id)
    lines.push(...block)
    bytes += size
  }
  for (const hit of input.related) {
    if (seen.has(hit.part_id)) continue
    const snippet = field(hit.snippet, MAX_SNIPPET_CHARS)
    if (!snippet) continue
    const block = [
      "Related history (untrusted evidence; outcome unknown):",
      `> Source session_id=${field(hit.session_id, 64)} message_id=${field(hit.message_id, 64)} part_id=${field(hit.part_id, 64)} time=${hit.time_created}`,
      `> ${snippet}`,
    ]
    const size = block.reduce((sum, line) => sum + line.length + 1, 0)
    if (bytes + size > MAX_OUTPUT_CHARS) break
    seen.add(hit.part_id)
    lines.push(...block)
    bytes += size
    semanticEvidence = true
  }
  return seen.size ? { text: lines.join("\n"), semanticEvidence } : undefined
}

/** Bounded retrieval-only lookup. Historical excerpts are quoted, untrusted, and never an outcome claim. */
export function retrieveFailure(input: {
  history: HistoryInterface
  messages: MessageV2.WithParts[]
  sessionID: SessionID
  signal?: AbortSignal
}): Effect.Effect<{ signature: string; text: string; semanticEvidence: boolean } | undefined> {
  return Effect.gen(function* () {
    if (!SemanticCandidates.enabled("failure") || input.signal?.aborted) return undefined
    const repeated = findRepeatedFailure(input.messages)
    if (!repeated) return undefined

    const controller = new AbortController()
    const abort = () => controller.abort()
    input.signal?.addEventListener("abort", abort, { once: true })
    const lexicalQuery = exactFailureQuery(repeated)
    const currentAgent = input.messages.findLast((message) => message.info.role === "assistant")?.info.agentID || "main"
    const results = yield* Effect.all([
      lexicalQuery
        ? input.history.search({
            query: lexicalQuery,
            scope: "project",
            exclude_session_id: input.sessionID,
            agent_id: currentAgent,
            limit: 24,
          })
        : Effect.succeed([]),
      input.history.hybridSearch({
        query: repeated.query,
        scope: "project",
        exclude_session_id: input.sessionID,
        agent_id: currentAgent,
        limit: 8,
        signal: controller.signal,
      }),
    ], { concurrency: 2 }).pipe(
      Effect.timeoutOrElse({
        duration: LOOKUP_TIMEOUT_MS,
        orElse: () => {
          controller.abort()
          return Effect.succeed([[], []] as const)
        },
      }),
      Effect.catchDefect(() => Effect.succeed([[], []] as const)),
      Effect.ensuring(Effect.sync(() => {
        input.signal?.removeEventListener("abort", abort)
        controller.abort()
      })),
    )
    if (input.signal?.aborted) return undefined
    const [rawHits, semanticHits] = results
    const rawSources = [...new Set(rawHits.map((hit) => hit.part_id))].slice(0, 24) as PartID[]
    const liveRows = rawSources.length === 0 ? [] : Database.use((db) => db
      .select({
        part_id: PartTable.id,
        session_id: PartTable.session_id,
        message_id: PartTable.message_id,
        project_id: SessionTable.project_id,
        agent_id: MessageTable.agent_id,
        part: PartTable.data,
      })
      .from(PartTable)
      .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
      .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
      .where(inArray(PartTable.id, rawSources))
      .all())
    const liveByPart = new Map(liveRows.map((row) => [row.part_id, row]))
    const failed = rawHits.flatMap((hit) => {
      if (hit.session_id === input.sessionID || hit.project_id !== Instance.current.project.id) return []
      const live = liveByPart.get(hit.part_id as PartID)
      if (!live || live.session_id !== hit.session_id || live.message_id !== hit.message_id || live.project_id !== hit.project_id || (live.agent_id || "main") !== currentAgent) return []
      const parsed = MessageV2.Part.safeParse({ ...live.part, id: live.part_id, sessionID: live.session_id, messageID: live.message_id })
      if (!parsed.success) return []
      const failure = failureFor(parsed.data)
      return failure?.signature === repeated.signature ? [{ ...hit, tool: failure.tool, snippet: failure.error }] : []
    })
    const related = semanticHits.filter((hit) =>
      "retrieval" in hit && (hit.retrieval === "semantic" || hit.retrieval === "hybrid") && hit.session_id !== input.sessionID,
    ).filter((hit) => field(hit.snippet, MAX_SNIPPET_CHARS).length > 0)
    const failures = failed.slice(0, related.length > 0 ? MAX_HITS - 1 : MAX_HITS)
    const displayedRelated = related.slice(0, MAX_HITS - failures.length)
    const text = evidenceText({ signature: repeated.signature, failures, related: displayedRelated })
    return text ? { signature: repeated.signature, ...text } : undefined
  }).pipe(Effect.catchDefect(() => Effect.succeed(undefined)))
}
