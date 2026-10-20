import { createHash } from "node:crypto"
import type { JSONObject } from "@ai-sdk/provider"
import { Effect } from "effect"
import z from "zod"
import { Token } from "../util"
import * as Tool from "./tool"

export const MCP_TOOL_SEARCH_ID = "mcp_tool_search"
export const MCP_TOOL_USE_ID = "mcp_tool_use"
export const MCP_TOOL_SEARCH_DEFAULT_LIMIT = 5
export const MCP_TOOL_SEARCH_MAX_LIMIT = 20
export const MCP_TOOL_CATALOG_MAX_TOKENS = 20_000
export const MCP_TOOL_SEARCH_DEFAULT_PERCENT = 10
const MCP_TOOL_SEARCH_FALLBACK_CONTEXT = 200_000

const BM25_K1 = 1.2
const BM25_LENGTH_NORMALIZATION = 0.75

export type McpToolSearchEntry = {
  name: string
  description: string
  parameters: JSONObject
}

export type McpServerReadiness = {
  name: string
  status: "pending" | "connected" | "failed" | "needs_auth" | "needs_client_registration" | "disabled"
  /** Present when connected. */
  toolCount?: number
  /** Present when failed or needs_client_registration. */
  error?: string
  /** Model-visible tool names + short descriptions, for server-outcome reminders. */
  tools?: Array<{ name: string; description: string }>
}

export type McpServerReminder = Omit<McpServerReadiness, "status"> & {
  status: McpServerReadiness["status"] | "removed"
}

/** Non-blocking view of configured MCP servers — never awaits full connect settle. */
export type McpReadiness = {
  /** Any MCP config entry exists (including disabled). */
  configured: boolean
  servers: McpServerReadiness[]
}

export type McpToolSearchCatalog = {
  key: string
  entries: McpToolSearchEntry[]
  readiness?: McpReadiness
}

export type McpToolSearchMetadata = {
  catalogKey: string
  matchedTools: string[]
}

export type McpToolSearchMode = { type: "always" } | { type: "never" } | { type: "auto"; percent: number }

type SearchResult = {
  name: string
  description: string
  score: number
}

type SearchIndex = {
  key: string
  entries: McpToolSearchEntry[]
  documents: string[][]
  names: string[][]
  frequencies: Map<string, number>[]
  documentFrequency: Map<string, number>
  averageLength: number
}

let cached: SearchIndex | undefined

const DESCRIPTION = [
  "Fetches full schema definitions for deferred MCP tools so they can be called.",
  "",
  `Deferred tools are announced by name in <system-reminder> blocks attached to user messages. Until fetched, only the name is known — there is no parameter schema. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Deferred tools are never added to the tool list: call one through ${MCP_TOOL_USE_ID} with its name and arguments matching the fetched schema.`,
  "",
  "Query forms:",
  '- "select:tool_a,tool_b" — fetch these exact tools by name',
  '- "slack send message" — keyword search, up to max_results best matches',
  '- "+slack send" — require "slack" in the name, rank by remaining terms',
  "",
  "This tool is not available inside exec; exec scripts discover their request-authorized MCP tools through the global ALL_TOOLS catalog and call them through tools.",
].join("\n")

const HARNESS_TAG = /<(\/?)(system-reminder|available-deferred-tools|functions|function)\b/gi
const DESCRIPTION_PREVIEW_CHARS = 160

/**
 * Escapes harness-reserved tags in external text (MCP metadata and results) so
 * it cannot forge a `<system-reminder>` or close the `<functions>` block.
 */
export function neutralizeHarnessTags(value: string) {
  return value.replace(HARNESS_TAG, "&lt;$1$2")
}

function normalizeMetadata(value: string) {
  return neutralizeHarnessTags(
    value
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
}

export function mcpToolCatalogBudget(input: { usable: number; context: number }) {
  if (input.usable > 0) return Math.min(Math.floor(input.usable * 0.1), MCP_TOOL_CATALOG_MAX_TOKENS)
  if (input.context === 0) return MCP_TOOL_CATALOG_MAX_TOKENS
  return 0
}

/** Metadata key on synthetic user reminders that describe MCP connection state. */
export const MCP_REMINDER_METADATA_KEY = "mcpReminder"

export type McpReminderMeta =
  | { kind: "entry"; servers: string[] }
  | { kind: "server"; server: string; status: string; toolNames?: string[]; error?: string }

/** Semantic state fingerprint; volatile error text must not cause repeated reminders. */
export function mcpReminderMarker(meta: McpReminderMeta): string {
  const state =
    meta.kind === "entry" ? [meta.servers.toSorted()] : [meta.server, meta.status, (meta.toolNames ?? []).toSorted()]
  return `mcp:${meta.kind}:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`
}

type ServerReminderMeta = Extract<McpReminderMeta, { kind: "server" }>

export function announcedMcpReminders(metas: Iterable<unknown>) {
  let entry: Extract<McpReminderMeta, { kind: "entry" }> | undefined
  const byServer = new Map<string, ServerReminderMeta>()
  for (const meta of metas) {
    if (!meta || typeof meta !== "object") continue
    const value = meta as McpReminderMeta
    if (value.kind === "entry") {
      entry = value
      // Entry advertises pending servers before their first outcome. Retain
      // their presence so removal/disable before connection also gets reported.
      for (const server of value.servers) {
        if (!byServer.has(server)) byServer.set(server, { kind: "server", server, status: "pending" })
      }
    }
    if (value.kind === "server") byServer.set(value.server, value)
  }
  return { entry, byServer }
}

function preview(description: string) {
  const line = normalizeMetadata(description)
  return line.length > DESCRIPTION_PREVIEW_CHARS ? `${line.slice(0, DESCRIPTION_PREVIEW_CHARS - 1)}…` : line
}

function fitLines(lines: string[], budget: number) {
  if (Token.estimate(lines.join("\n")) <= budget) return lines
  const included: string[] = []
  for (const [index, line] of lines.entries()) {
    const notice = `(+${lines.length - index} more; ${MCP_TOOL_SEARCH_ID} searches the complete catalog)`
    if (Token.estimate([...included, line, notice].join("\n")) > budget) {
      const truncated = [...included, notice]
      return Token.estimate(truncated.join("\n")) <= budget ? truncated : included
    }
    included.push(line)
  }
  return included
}

function reminderBody(lines: string[]) {
  return ["<system-reminder>", ...lines, "</system-reminder>"].join("\n")
}

function boundedReminder(lines: string[], budget: number, fallback: string[] = []) {
  for (const candidate of [lines, fallback]) {
    if (candidate.length === 0) continue
    const text = reminderBody(candidate)
    if (Token.estimate(text) <= budget) return text
  }
  return ""
}

/**
 * First injection when ≥1 MCP server is configured: names, possible pending work,
 * and how to discover/call. Not gated on the tool catalog.
 */
export function renderMcpEntryReminder(serverNames: string[], budget = Infinity) {
  return boundedReminder(
    [
      `MCP servers configured: ${serverNames.map(normalizeMetadata).join(", ")}.`,
      `Servers may still be connecting. Find tools and schemas with ${MCP_TOOL_SEARCH_ID}, then call through ${MCP_TOOL_USE_ID}.`,
    ],
    budget,
    [
      `${serverNames.length} MCP servers configured. Discover tools with ${MCP_TOOL_SEARCH_ID}, then call through ${MCP_TOOL_USE_ID}.`,
    ],
  )
}

/**
 * Per-server outcome. Success lists that server's tools (name + description preview);
 * failure / auth is a short terminal note. When `previous` shows an earlier claim
 * for the same server, the body explicitly supersedes it (append-only channel).
 */
export function renderMcpServerReminder(
  server: McpServerReminder,
  budget: number,
  previous?: { status: string; toolNames?: string[] },
) {
  const name = normalizeMetadata(server.name)
  const limit = Math.max(0, Math.floor(budget))
  const previousTools = previous?.toolNames ?? []
  const currentTools = new Set((server.tools ?? []).map((tool) => tool.name))
  const dropped = previousTools.filter((tool) => !currentTools.has(tool))
  const replacement = `Tool list for ${name} changed; re-check with ${MCP_TOOL_SEARCH_ID}.`
  const removed = `No longer available from ${name}: ${dropped.map(normalizeMetadata).join(", ")}.`
  // Append-only channel: state the replacement claim so older lines are not trusted.
  const supersede =
    previous?.status === "connected"
      ? server.status !== "connected" && previousTools.length > 0
        ? [`Previously listed tools from ${name} are unavailable.`]
        : server.status === "connected" && dropped.length > 0
          ? [Token.estimate(removed) <= limit / 4 ? removed : replacement]
          : []
      : []

  if (server.status === "failed") {
    return boundedReminder(
      [
        `MCP server ${name} is unavailable${server.error ? ` (failed: ${preview(server.error)})` : " (failed)"}.`,
        ...supersede,
      ],
      limit,
      [`MCP server ${name} is unavailable (failed).`, ...supersede],
    )
  }
  if (server.status === "needs_auth" || server.status === "needs_client_registration") {
    const reason = server.status === "needs_auth" ? "needs auth" : "needs client registration"
    return boundedReminder(
      [
        `MCP server ${name} is unavailable (${reason}${server.error ? `: ${preview(server.error)}` : ""}).`,
        ...supersede,
      ],
      limit,
      [`MCP server ${name} is unavailable (${reason}).`, ...supersede],
    )
  }
  if (server.status !== "connected")
    return boundedReminder(
      [`MCP server ${name} is ${server.status === "removed" ? "no longer configured" : server.status}.`, ...supersede],
      limit,
    )

  const tools = server.tools ?? []
  const heading = `MCP server ${name} connected.${tools.length === 0 ? " No tools are available for this request." : ""}`
  const compact = [heading, ...supersede, `Fetch or re-check tools with ${MCP_TOOL_SEARCH_ID}.`]
  if (tools.length === 0) return boundedReminder(compact, limit)
  const tail = [`Schemas: ${MCP_TOOL_SEARCH_ID}. Call tools through ${MCP_TOOL_USE_ID}.`]
  const head = [heading, ...supersede, "Current tools:"]
  const listBudget = limit - Token.estimate(reminderBody([...head, ...tail])) - 1
  const detailed = tools.map((tool) => {
    const description = preview(tool.description)
    return description ? `- ${normalizeMetadata(tool.name)}: ${description}` : `- ${normalizeMetadata(tool.name)}`
  })
  const listed =
    Token.estimate(detailed.join("\n")) <= listBudget
      ? detailed
      : fitLines(
          tools.map((tool) => `- ${normalizeMetadata(tool.name)}`),
          listBudget,
        )
  return listed.length > 0
    ? boundedReminder([...head, ...listed, ...tail], limit, compact)
    : boundedReminder(compact, limit)
}

/**
 * Parses `MIMOCODE_MCP_TOOL_SEARCH`: `true`/`1` (always, the default), `auto`
 * (defer once MCP schemas exceed 10% of the context window), `auto:N` (N%),
 * `false`/`0` (never).
 */
export function parseMcpToolSearchMode(value: string | undefined): McpToolSearchMode {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "false" || normalized === "0") return { type: "never" }
  if (normalized === "auto") return { type: "auto", percent: MCP_TOOL_SEARCH_DEFAULT_PERCENT }
  const percent = normalized?.startsWith("auto:") ? Number(normalized.slice("auto:".length)) : undefined
  if (percent !== undefined && Number.isFinite(percent) && percent >= 0 && percent <= 100) {
    return { type: "auto", percent }
  }
  if (normalized?.startsWith("auto:")) return { type: "auto", percent: MCP_TOOL_SEARCH_DEFAULT_PERCENT }
  return { type: "always" }
}

export function mcpToolDefinitionTokens(entries: McpToolSearchEntry[]) {
  return entries.reduce(
    (sum, entry) =>
      sum +
      Token.estimate(
        JSON.stringify({ name: entry.name, description: entry.description, parameters: entry.parameters }),
      ),
    0,
  )
}

/**
 * An empty catalog counts as deferred, so search/use are exposed before any MCP
 * server connects (or is even configured). `deferredEarlier` makes the decision
 * sticky for a conversation: once deferred, it stays deferred when `auto` drops
 * back under its threshold. Flipping between deferred and direct exposure would
 * rewrite the tool list, the head of the prompt-cache prefix.
 */
export function shouldDeferMcpTools(
  mode: McpToolSearchMode,
  entries: McpToolSearchEntry[],
  context: number,
  deferredEarlier = false,
) {
  if (mode.type === "never") return false
  if (deferredEarlier || entries.length === 0) return true
  if (mode.type === "always") return true
  const window = context > 0 ? context : MCP_TOOL_SEARCH_FALLBACK_CONTEXT
  return mcpToolDefinitionTokens(entries) > window * (mode.percent / 100)
}

function tokenize(value: string) {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

function schemaSearchText(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(schemaSearchText)
  if (!schema || typeof schema !== "object") return []

  const value = schema as Record<string, unknown>
  const properties =
    value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
      ? Object.entries(value.properties as Record<string, unknown>).flatMap(([name, child]) => [
          name,
          ...schemaSearchText(child),
        ])
      : []

  return [
    ...(typeof value.description === "string" ? [value.description] : []),
    ...properties,
    ...schemaSearchText(value.items),
    ...schemaSearchText(value.anyOf),
    ...schemaSearchText(value.oneOf),
    ...schemaSearchText(value.allOf),
  ]
}

function index(entries: McpToolSearchEntry[]) {
  const key = JSON.stringify(entries)
  if (cached?.key === key) return cached

  const documents = entries.map((entry) =>
    tokenize(
      [entry.name, entry.name.replaceAll("_", " "), entry.description, ...schemaSearchText(entry.parameters)].join(" "),
    ),
  )
  const frequencies = documents.map((document) =>
    document.reduce((result, token) => result.set(token, (result.get(token) ?? 0) + 1), new Map<string, number>()),
  )
  cached = {
    key,
    entries,
    documents,
    names: entries.map((entry) => tokenize(entry.name)),
    frequencies,
    documentFrequency: frequencies.reduce((result, frequency) => {
      frequency.forEach((_, token) => result.set(token, (result.get(token) ?? 0) + 1))
      return result
    }, new Map<string, number>()),
    averageLength: documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1,
  }
  return cached
}

export function createMcpToolSearchCatalog(
  entries: McpToolSearchEntry[],
  readiness?: McpReadiness,
): McpToolSearchCatalog {
  return {
    key: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries,
    readiness,
  }
}

function names(servers: McpServerReadiness[]) {
  return servers.map((server) => server.name).join(", ")
}

/**
 * One status line the model can branch on: connecting vs failed vs needs auth
 * vs connected-with-N-tools vs not configured. Used on search empty/miss so
 * empty search is never ambiguous.
 */
export function renderMcpReadiness(readiness: McpReadiness | undefined): string {
  if (!readiness?.configured || readiness.servers.length === 0) return "MCP status: no MCP servers are configured."

  const servers = readiness.servers.map((server) => ({
    ...server,
    name: normalizeMetadata(server.name),
    error: server.error ? preview(server.error) : undefined,
  }))
  const pending = servers.filter((server) => server.status === "pending")
  const failed = servers.filter((server) => server.status === "failed")
  const auth = servers.filter(
    (server) => server.status === "needs_auth" || server.status === "needs_client_registration",
  )
  const disabled = servers.filter((server) => server.status === "disabled")
  const connected = servers.filter((server) => server.status === "connected")

  const parts: string[] = []
  if (pending.length > 0) parts.push(`connecting ${names(pending)}`)
  if (auth.length > 0) {
    parts.push(
      auth
        .map((server) =>
          server.status === "needs_auth"
            ? `${server.name} needs auth`
            : `${server.name} needs client registration${server.error ? ` (${server.error})` : ""}`,
        )
        .join("; "),
    )
  }
  if (failed.length > 0) {
    parts.push(failed.map((server) => `${server.name} failed${server.error ? ` (${server.error})` : ""}`).join("; "))
  }
  if (disabled.length > 0) parts.push(`disabled ${names(disabled)}`)
  if (connected.length > 0) {
    const toolTotal = connected.reduce((sum, server) => sum + (server.toolCount ?? 0), 0)
    const count = (total: number) => `${total} tool${total === 1 ? "" : "s"}`
    parts.push(
      connected.length === 1 && connected[0]!.toolCount !== undefined
        ? `${connected[0]!.name} connected (${count(connected[0]!.toolCount)})`
        : `${connected.length} connected (${count(toolTotal)})`,
    )
  }
  if (parts.length === 0) parts.push("no servers ready")
  return `MCP status: ${parts.join("; ")}.`
}

/** Next-step hint after a search/use miss. Prefer "retry later" over "next step". */
export function mcpSearchActionHint(readiness: McpReadiness | undefined): string {
  const pending = readiness?.servers.some((server) => server.status === "pending") ?? false
  if (pending) return "Retry later; connecting servers may still add tools. Use select:<name> for exact names."
  return "Use select:<name> for exact names or different keywords. If a server failed or needs auth, address that first; otherwise the tool may not exist."
}

/** Empty-catalog or no-match tool output: primary sentence + readiness + hint. */
export function mcpSearchMissOutput(catalogSize: number, readiness: McpReadiness | undefined) {
  const primary =
    catalogSize === 0
      ? "No deferred MCP tools are currently visible."
      : `No matching deferred tools found (catalog has ${catalogSize} tool${catalogSize === 1 ? "" : "s"}).`
  return [primary, renderMcpReadiness(readiness), mcpSearchActionHint(readiness)].join("\n\n")
}

function result(entry: McpToolSearchEntry, score: number): SearchResult {
  return { name: entry.name, description: entry.description, score }
}

export function searchMcpTools(
  entries: McpToolSearchEntry[],
  input: { query: string; limit?: number },
): SearchResult[] {
  const query = input.query.trim()
  if (!query) throw new Error("query must not be empty")

  const limit = input.limit ?? MCP_TOOL_SEARCH_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MCP_TOOL_SEARCH_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MCP_TOOL_SEARCH_MAX_LIMIT}`)
  }
  if (entries.length === 0) return []

  if (query.toLowerCase().startsWith("select:")) {
    const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]))
    const selected = query
      .slice("select:".length)
      .split(",")
      .map((name) => byName.get(name.trim().toLowerCase()))
      .filter((entry): entry is McpToolSearchEntry => !!entry)
    return [...new Set(selected)].slice(0, MCP_TOOL_SEARCH_MAX_LIMIT).map((entry) => result(entry, 1))
  }

  const exact = entries.find((entry) => entry.name.toLowerCase() === query.toLowerCase())
  if (exact) return [result(exact, 1)]

  const search = index(entries)
  const terms = query.split(/\s+/)
  const required = terms.filter((term) => term.startsWith("+")).flatMap((term) => tokenize(term.slice(1)))
  const queryTokens = [...new Set(tokenize(terms.map((term) => term.replace(/^\+/, "")).join(" ")))]
  return search.documents
    .map((document, documentIndex) => ({
      documentIndex,
      score: queryTokens.reduce((score, token) => {
        const frequency = search.frequencies[documentIndex].get(token) ?? 0
        if (frequency === 0) return score
        const documentFrequency = search.documentFrequency.get(token) ?? 0
        const inverseDocumentFrequency = Math.log(
          1 + (search.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
        )
        return (
          score +
          inverseDocumentFrequency *
            ((frequency * (BM25_K1 + 1)) /
              (frequency +
                BM25_K1 *
                  (1 -
                    BM25_LENGTH_NORMALIZATION +
                    BM25_LENGTH_NORMALIZATION * (document.length / search.averageLength))))
        )
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .filter((item) => required.every((token) => search.names[item.documentIndex].includes(token)))
    .toSorted(
      (a, b) =>
        b.score - a.score || search.entries[a.documentIndex].name.localeCompare(search.entries[b.documentIndex].name),
    )
    .slice(0, limit)
    .map((item) => result(search.entries[item.documentIndex], item.score))
}

export function renderMcpToolFunctions(entries: McpToolSearchEntry[]) {
  return [
    "<functions>",
    ...entries.map(
      (entry) =>
        `<function>${neutralizeHarnessTags(JSON.stringify({ description: entry.description, name: entry.name, parameters: entry.parameters }))}</function>`,
    ),
    "</functions>",
  ].join("\n")
}

const MCP_TOOL_USE_HINT = `Call these tools through ${MCP_TOOL_USE_ID} with {"name": "<tool name>", "arguments": {...}}; they are not callable by name directly.`

export const MCP_TOOL_USE_DESCRIPTION = [
  "Calls a deferred MCP tool by name.",
  "",
  `Deferred MCP tools are announced in <system-reminder> blocks and are not in the tool list. Fetch a tool's schema with ${MCP_TOOL_SEARCH_ID}, then call it here: \`name\` is the exact tool name and \`arguments\` is an object matching that tool's parameters schema. The result is the MCP tool's own result.`,
  "",
  `If the arguments are rejected, the error includes the tool's schema; fix the arguments and retry. This tool is not available inside exec.`,
].join("\n")

export const McpToolUseParameters = z.object({
  name: z.string().describe("Exact name of the deferred MCP tool to call"),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments for the MCP tool, matching its parameters schema"),
})

/**
 * Cheap structural pre-check of `mcp_tool_use` arguments against the target
 * tool's schema: the value must be an object carrying every top-level
 * `required` property. Full validation stays with the MCP server. Returns the
 * problem, or undefined when the call may proceed.
 */
export function checkMcpToolArguments(entry: McpToolSearchEntry, args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `arguments for "${entry.name}" must be an object`
  }
  const required = Array.isArray(entry.parameters.required)
    ? entry.parameters.required.filter((key): key is string => typeof key === "string")
    : []
  const missing = required.filter((key) => !Object.hasOwn(args, key))
  if (missing.length > 0) return `arguments for "${entry.name}" are missing required properties: ${missing.join(", ")}`
}

function catalog(input: unknown): McpToolSearchCatalog | undefined {
  if (!input || typeof input !== "object") return
  if (!("key" in input) || typeof input.key !== "string") return
  if (!("entries" in input) || !Array.isArray(input.entries)) return
  return input as McpToolSearchCatalog
}

const Parameters = z.object({
  query: z
    .string()
    .describe('Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MCP_TOOL_SEARCH_MAX_LIMIT)
    .optional()
    .describe(`Maximum number of results to return (default: ${MCP_TOOL_SEARCH_DEFAULT_LIMIT})`),
})

export const McpToolSearchTool = Tool.define(
  MCP_TOOL_SEARCH_ID,
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context<McpToolSearchMetadata>) =>
      Effect.sync(() => {
        const available = catalog(ctx.extra?.mcpToolSearch)
        const readiness = available?.readiness
        if (!available || available.entries.length === 0) {
          return {
            title: "No deferred MCP tools available",
            output: mcpSearchMissOutput(0, readiness),
            metadata: { catalogKey: available?.key ?? "", matchedTools: [] },
          }
        }

        const matched = searchMcpTools(available.entries, { query: params.query, limit: params.max_results })
        const byName = new Map(available.entries.map((entry) => [entry.name, entry]))
        const loaded = matched.flatMap((item) => byName.get(item.name) ?? [])
        return {
          title:
            loaded.length > 0
              ? `Found ${loaded.length} MCP tool${loaded.length === 1 ? "" : "s"}`
              : "No matching MCP tools",
          output:
            loaded.length > 0
              ? `${renderMcpToolFunctions(loaded)}\n${MCP_TOOL_USE_HINT}`
              : mcpSearchMissOutput(available.entries.length, readiness),
          metadata: { catalogKey: available.key, matchedTools: loaded.map((entry) => entry.name) },
        }
      }),
  }),
)
