import { createHash } from "node:crypto"
import { jsonSchema, tool, type Tool as AITool } from "ai"
import { asSchema } from "@ai-sdk/provider-utils"
import { Effect } from "effect"
import { and, Database, eq } from "@/storage"
import type { Permission } from "@/permission"
import { MCP_TOOL_SEARCH_ID } from "@/tool/mcp-tool-search"
import type { MessageID, SessionID } from "./schema"
import { SessionPrefixSnapshotTable, type SessionPrefixToolSnapshot } from "./session.sql"

export type Info = typeof SessionPrefixSnapshotTable.$inferSelect

type Profile = {
  providerID: string
  modelID: string
  agent: string
  agentID: string
  harness: string
  systemMode: string
  system: string
  // Already covers the per-request tool mask: `SessionPrompt.prompt` converts
  // `MessageV2.User.tools` into allow/deny rules and persists them via
  // `sessions.setPermission` before the run loop reads the ruleset back, so a masked
  // request lands on a different `permission` and therefore a different profile key.
  // Do NOT re-derive the mask here — that would be an in-memory duplicate of state
  // that is already in SQLite, and would drift from it across a restart.
  permission: Permission.Ruleset
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (typeof value !== "object") return "null"
  return `{${Object.keys(value)
    .toSorted()
    .flatMap((key) => {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return []
      return [`${JSON.stringify(key)}:${stableStringify(item)}`]
    })
    .join(",")}}`
}

function hash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex")
}

export function profileKey(input: Profile) {
  return hash(input)
}

export function systemHash(system: string[]) {
  return hash(system)
}

// Registered by the run loop AFTER `resolveTools` computed `localToolNames`, so it can
// never be inferred as local from that set. It is a per-request, format-driven local
// tool — never an MCP one — and must not be pinned into the advertised set, or a later
// plain-text request would re-advertise a tool its schema no longer calls for.
export const STRUCTURED_OUTPUT_TOOL_ID = "StructuredOutput"

// Classify at snapshot time, where the live tool map is still authoritative, rather than
// re-deriving from names on read. `localToolNames` omits both special cases below:
// `mcp_tool_search` is registered before it is populated, and StructuredOutput after.
function sourceFor(name: string, local: Set<string>) {
  if (name === MCP_TOOL_SEARCH_ID) return "mcp" as const
  if (name === STRUCTURED_OUTPUT_TOOL_ID) return "local" as const
  return local.has(name) ? ("local" as const) : ("mcp" as const)
}

export async function snapshotTools(
  tools: Record<string, AITool>,
  activeTools: string[],
  localToolNames?: Iterable<string>,
) {
  const local = localToolNames ? toSet(localToolNames) : undefined
  // Dedupe: the run loop pushes StructuredOutput onto an `activeTools` that may already
  // carry it from the frozen overlay, and a duplicated entry would both double the wire
  // schema and rotate the snapshot every turn.
  const seen = new Set<string>()
  return Promise.all(
    activeTools.flatMap((name) => {
      const item = tools[name]
      if (!item || seen.has(name)) return []
      seen.add(name)
      return [
        Promise.resolve(asSchema(item.inputSchema).jsonSchema).then(
          (input_schema): SessionPrefixToolSnapshot => ({
            name,
            description: item.description,
            input_schema,
            ...(local ? { source: sourceFor(name, local) } : {}),
          }),
        ),
      ]
    }),
  )
}

export function restoreTools(items: SessionPrefixToolSnapshot[]) {
  return Object.fromEntries(
    items.map((item) => [
      item.name,
      tool({
        description: item.description,
        inputSchema: jsonSchema(item.input_schema),
      }),
    ]),
  )
}

function toSet(names: Iterable<string>) {
  return names instanceof Set ? names : new Set(names)
}

// The persisted `source` is authoritative — see the field comment in session.sql.ts.
// Only rows pinned before that column existed fall back to name-based inference, which
// shares `sourceFor`'s special cases so old and new rows classify identically.
export function toolSource(item: SessionPrefixToolSnapshot, localToolNames: Iterable<string>) {
  if (item.source) return item.source
  return sourceFor(item.name, toSet(localToolNames))
}

export function isMcpAdvertisedTool(name: string, localToolNames: Iterable<string>) {
  if (name === MCP_TOOL_SEARCH_ID) return true
  return !toSet(localToolNames).has(name)
}

// Order-sensitive digest of the advertised set in its persisted (normalized JSON
// schema) form. Compared against the pinned row to decide rotation: computing it from
// `snapshotTools` output on both sides means the comparison sees exactly the bytes that
// were persisted, not live `Tool` objects whose wrappers differ between `tool()` and
// `dynamicTool()`. Order is deliberately part of the digest — a reordering alone
// rotates the provider prefix (see overlayFrozenMcpTools).
export function advertisedHash(items: SessionPrefixToolSnapshot[]) {
  return hash(
    items.map((item) => ({
      name: item.name,
      description: item.description,
      input_schema: item.input_schema,
    })),
  )
}

// Rebuild this turn's tool map so BOTH the key order and the advertised order match
// the pinned snapshot exactly. Order matters twice over: the AI SDK derives the wire
// tool array from `Object.entries(tools)` filtered by `activeTools`, and
// ProviderTransform.tools attaches the cache marker to the last advertised tool. A
// reordering alone — even with an identical tool set — therefore rotates the prefix.
//
// The freeze suppresses INVOLUNTARY churn (an MCP server disconnecting, reconnecting,
// or firing list_changed): those keep their pinned slot and schema, so the wire bytes
// are unchanged and the prefix cache survives. It deliberately does NOT suppress
// VOLUNTARY expansion — a tool the model pulled in via MCP Tool Search has to become
// callable, which no amount of pinning can achieve without changing the advertised set.
// Such tools are appended AFTER the pinned block (so the shared head still matches
// byte-for-byte and the provider keeps the longest common prefix) and the resulting
// `advertisedHash` change rotates the snapshot once. Dropping them instead would leave
// the model unable to call its own search results on any model without an exec gateway.
export function overlayFrozenMcpTools(input: {
  tools: Record<string, AITool>
  activeTools: string[]
  frozen: SessionPrefixToolSnapshot[]
  localToolNames: Iterable<string>
  // Names the model deliberately pulled in via MCP Tool Search this turn. ONLY these
  // may expand the advertised set — a tool that merely showed up because a server
  // connected is involuntary churn and stays unadvertised until the model asks for it.
  searchLoadedToolNames?: Iterable<string>
  // MCP tools this request authorizes (permission + per-request mask + agent allowlist +
  // actor whitelist), as computed by `resolveTools`.
  authorizedMcpToolNames?: Iterable<string>
  // Every MCP tool that was CONNECTED this turn. Needed to read the set above correctly:
  // a pinned name missing from `authorized` is REVOKED only if it is still connected —
  // otherwise it merely disconnected, which is exactly the churn the freeze absorbs.
  // Both omitted (undefined) means "no authorization data" and leaves the pinned set
  // untouched; used by unit tests and legacy callers.
  connectedMcpToolNames?: Iterable<string>
}) {
  const local = toSet(input.localToolNames)
  const active = new Set(input.activeTools)
  const frozenNames = new Set(input.frozen.map((item) => item.name))
  const loaded = input.searchLoadedToolNames ? toSet(input.searchLoadedToolNames) : undefined
  const authorized = input.authorizedMcpToolNames ? toSet(input.authorizedMcpToolNames) : undefined
  const connected = input.connectedMcpToolNames ? toSet(input.connectedMcpToolNames) : undefined
  // Local entries keep their pinned slot only while still advertised this turn — a
  // permission or per-request mask change legitimately drops them, and that difference
  // is what rotates the snapshot. MCP entries survive server churn, but NOT revocation:
  // `mcp_tool_search` is a local gateway rather than a catalogued tool, so it is judged
  // by `active` like any other local entry.
  const pinned = input.frozen.flatMap((item) => {
    if (toolSource(item, local) === "local" || item.name === MCP_TOOL_SEARCH_ID) {
      return active.has(item.name) ? [item] : []
    }
    // Connected but not authorized => revoked this turn. Connected data absent, or the
    // tool simply gone => keep the pinned entry so the prefix survives the churn.
    if (authorized && connected?.has(item.name) && !authorized.has(item.name)) return []
    return [item]
  })
  // Sorted so two turns that loaded the same tools in a different order still agree.
  const expanded = loaded
    ? input.activeTools.filter((name) => !frozenNames.has(name) && loaded.has(name)).toSorted()
    : []
  const advertised = [...pinned.map((item) => item.name), ...expanded]
  const advertisedSet = new Set(advertised)
  const tools: Record<string, AITool> = {}

  for (const item of pinned) {
    const live = input.tools[item.name]
    const schema = jsonSchema(item.input_schema)
    tools[item.name] = live
      ? { ...live, description: item.description, inputSchema: schema, execute: live.execute }
      : tool({
          description: item.description,
          inputSchema: schema,
          execute: async () => ({
            title: "MCP unavailable",
            output: `The MCP tool "${item.name}" is unavailable for this request.`,
            metadata: { unavailable: true },
          }),
        })
  }
  for (const name of expanded) {
    const live = input.tools[name]
    if (live) tools[name] = live
  }
  // Everything else stays registered but unadvertised so a direct / exec-gateway call
  // still resolves. Appended after the advertised block so it can never displace the
  // cache marker, which must ride the last ADVERTISED tool.
  for (const [name, item] of Object.entries(input.tools)) {
    if (!advertisedSet.has(name)) tools[name] = item
  }

  return { tools, activeTools: advertised }
}

export const get = Effect.fn("SessionPrefixSnapshot.get")(function* (sessionID: SessionID, key: string) {
  return yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(SessionPrefixSnapshotTable)
        .where(
          and(
            eq(SessionPrefixSnapshotTable.session_id, sessionID),
            eq(SessionPrefixSnapshotTable.profile_key, key),
          ),
        )
        .get(),
    ),
  )
})

export const pin = Effect.fn("SessionPrefixSnapshot.pin")(function* (input: {
  sessionID: SessionID
  profileKey: string
  system: string[]
  toolsHash: string
  tools: SessionPrefixToolSnapshot[]
  watermarkMessageID: MessageID
}) {
  const now = Date.now()
  yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(SessionPrefixSnapshotTable)
        .values({
          session_id: input.sessionID,
          profile_key: input.profileKey,
          system: input.system,
          system_hash: systemHash(input.system),
          tools_hash: input.toolsHash,
          tools: input.tools,
          watermark_message_id: input.watermarkMessageID,
          revision: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .run(),
    ),
  )
  const snapshot = yield* get(input.sessionID, input.profileKey)
  if (!snapshot) return yield* Effect.die(new Error("Failed to read pinned session prefix snapshot"))
  return snapshot
})

export const rotate = Effect.fn("SessionPrefixSnapshot.rotate")(function* (input: {
  sessionID: SessionID
  profileKey: string
  system: string[]
  toolsHash: string
  tools: SessionPrefixToolSnapshot[]
  watermarkMessageID: MessageID
}) {
  const current = yield* get(input.sessionID, input.profileKey)
  if (!current) return yield* pin(input)
  yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionPrefixSnapshotTable)
        .set({
          system: input.system,
          system_hash: systemHash(input.system),
          tools_hash: input.toolsHash,
          tools: input.tools,
          watermark_message_id: input.watermarkMessageID,
          revision: current.revision + 1,
          updated_at: Date.now(),
        })
        .where(
          and(
            eq(SessionPrefixSnapshotTable.session_id, input.sessionID),
            eq(SessionPrefixSnapshotTable.profile_key, input.profileKey),
          ),
        )
        .run(),
    ),
  )
  const snapshot = yield* get(input.sessionID, input.profileKey)
  if (!snapshot) return yield* Effect.die(new Error("Failed to read rotated session prefix snapshot"))
  return snapshot
})

export const advance = Effect.fn("SessionPrefixSnapshot.advance")(function* (input: {
  sessionID: SessionID
  profileKey: string
  revision: number
  watermarkMessageID: MessageID
}) {
  yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionPrefixSnapshotTable)
        .set({ watermark_message_id: input.watermarkMessageID, updated_at: Date.now() })
        .where(
          and(
            eq(SessionPrefixSnapshotTable.session_id, input.sessionID),
            eq(SessionPrefixSnapshotTable.profile_key, input.profileKey),
            eq(SessionPrefixSnapshotTable.revision, input.revision),
          ),
        )
        .run(),
    ),
  )
})

export * as SessionPrefixSnapshot from "./prefix-snapshot"
