// Deber: pack/unpack adapter at the LLM tool boundary.
//
// Business Tool.Def / execute / permission / truncation stay untouched.
// pack() rewrites the advertised surface into two-level collections;
// unpack() restores `{ id, args }` (idempotent for bare original ids).

export type CollectionSpec = {
  id: string
  ops: string[]
  description: string
}

export type UnpackOk = {
  ok: true
  id: string
  args: Record<string, unknown>
  via?: string
}

export type UnpackFail = {
  ok: false
  reason: "unknown-collection" | "unknown-op" | "invalid-args"
  message: string
}

export type UnpackResult = UnpackOk | UnpackFail

/** Control / sentinel tools stay top-level; never swallowed into a collection. */
export const TOP_LEVEL_KEEP: ReadonlySet<string> = new Set([
  "invalid",
  "mcp_tool_search",
  "session",
  "workflow",
  "exec",
  "wait",
  "plan_exit",
])

type CollectionDef = {
  scope: string
  ops: readonly string[]
}

const COLLECTION_DEFS: Record<string, CollectionDef> = {
  file: {
    scope: "Read, write, and search code and notebook files inside the project.",
    ops: ["read", "write", "edit", "multiedit", "glob", "grep", "notebook_edit", "apply_patch"],
  },
  shell: {
    scope: "Run shell commands in the project working directory.",
    ops: ["bash"],
  },
  net: {
    scope: "Fetch remote pages and search web/code corpora. Not local file search.",
    ops: ["webfetch", "websearch", "codesearch"],
  },
  media: {
    scope: "Inspect existing image/audio/video files. Does not modify files.",
    ops: ["view_image", "watch_video", "listen_audio"],
  },
  agent: {
    scope: "Delegate work, ask the user, and manage memory or schedules.",
    ops: ["task", "actor", "question", "history", "memory", "cron"],
  },
  skill: {
    scope: "Search and load skill instructions (SKILL.md bodies).",
    ops: ["skill", "skill_search"],
  },
  misc: {
    scope: "Remaining built-in tools. Prefer a more specific collection when one fits.",
    ops: [],
  },
}

export const DEBER_COLLECTION_IDS: readonly string[] = [
  "file",
  "shell",
  "net",
  "media",
  "agent",
  "skill",
  "misc",
]

const OP_TO_COLLECTION = new Map<string, string>()
for (const [collection, def] of Object.entries(COLLECTION_DEFS)) {
  for (const op of def.ops) OP_TO_COLLECTION.set(op, collection)
}

const PACKED_NAMES = new Set(DEBER_COLLECTION_IDS)

export function isTopLevelKeep(toolId: string): boolean {
  return TOP_LEVEL_KEEP.has(toolId)
}

export function isPackedName(name: string): boolean {
  return PACKED_NAMES.has(name)
}

export function collectionFor(toolId: string): string | undefined {
  return OP_TO_COLLECTION.get(toolId)
}

function collectionDescription(id: string, ops: string[]): string {
  const def = COLLECTION_DEFS[id]
  const lines = ops.map((op) => `- ${op}`)
  return [
    def.scope,
    "Exactly one `op`. Put that op's original arguments in `args` (not flattened onto this tool).",
    "Do not wrap twice. Prefer the narrowest collection whose scope matches.",
    id === "misc" ? "This is a fallback collection." : "",
    "Ops:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Build model-facing collection specs from the currently available tool ids.
 * Empty collections are omitted. Deterministic order (DEBER_COLLECTION_IDS, then
 * sorted ops) so toolsHash stays stable across identical requests.
 */
export function pack(availableIds: Iterable<string>): CollectionSpec[] {
  const buckets = new Map<string, string[]>()
  for (const id of DEBER_COLLECTION_IDS) buckets.set(id, [])

  for (const id of [...availableIds].sort()) {
    if (isTopLevelKeep(id)) continue
    const named = OP_TO_COLLECTION.get(id) ?? "misc"
    buckets.get(named)!.push(id)
  }

  const specs: CollectionSpec[] = []
  for (const id of DEBER_COLLECTION_IDS) {
    const ops = (buckets.get(id) ?? []).slice().sort()
    if (ops.length === 0) continue
    specs.push({
      id,
      ops,
      description: collectionDescription(id, ops),
    })
  }
  return specs
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

/**
 * Unpack a model tool-call payload to `{ id, args }`.
 *
 * - Bare original id (history restore / exec children / tests) passes through.
 * - Packed collection call: `{ op, args }` or `{ op, ...args }` (no nested args).
 */
export function unpack(name: string, input: unknown): UnpackResult {
  const raw = asRecord(input) ?? {}

  if (!isPackedName(name)) {
    return { ok: true, id: name, args: raw }
  }

  const collection = COLLECTION_DEFS[name]
  const opRaw = raw.op
  if (typeof opRaw !== "string" || !opRaw.trim()) {
    return {
      ok: false,
      reason: "invalid-args",
      message: `The ${name} tool requires a string \`op\` naming one of: ${describeOps(name)}. Received: ${JSON.stringify(opRaw)}`,
    }
  }
  const op = opRaw.trim()
  const allowed = name === "misc" ? undefined : collection.ops
  if (name !== "misc" && !allowed!.includes(op)) {
    return {
      ok: false,
      reason: "unknown-op",
      message: `Unknown op "${op}" for collection ${name}. Allowed ops: ${describeOps(name)}`,
    }
  }
  if (name === "misc" && (isTopLevelKeep(op) || isPackedName(op))) {
    return {
      ok: false,
      reason: "unknown-op",
      message: `Unknown op "${op}" for collection misc. Call top-level tools directly.`,
    }
  }

  const { op: _op, args: argsField, ...rest } = raw
  let args: Record<string, unknown>
  if (argsField === undefined) {
    if (Object.keys(rest).length === 0) {
      return { ok: true, id: op, args: {}, via: name }
    }
    args = rest
  } else {
    const parsed = asRecord(argsField)
    if (!parsed) {
      return {
        ok: false,
        reason: "invalid-args",
        message: `\`args\` for ${name}.${op} must be an object of that op's arguments.`,
      }
    }
    args = parsed
  }

  return { ok: true, id: op, args, via: name }
}

function describeOps(collectionId: string): string {
  if (collectionId === "misc") return "(any remaining non-control tool id)"
  return (COLLECTION_DEFS[collectionId]?.ops ?? []).join(", ")
}
