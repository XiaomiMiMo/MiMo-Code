// Turn-end uncommitted-hint: when experimental.uncommitted_hint.enabled, inspect the
// session workspace for uncommitted git changes and inject a commit reminder
// (source: hook). Default is OFF — missing config / enabled!==true never injects.
//
// Product: re-hint on later USER turns while the tree stays dirty (agent may not
// have learned to commit yet). Clean workspace naturally stops injection; a later
// dirty USER turn may inject again. Anti-loop (fail-closed): inject ONLY when turn
// source is explicitly "user". Hook/undefined/spawn/internal wakes never inject.
// Hint body guides .gitignore review before commit — still does not force commit.

export const UNCOMMITTED_HINT_PROMPT =
  "There are uncommitted git changes in this session workspace.\n" +
  "Before committing:\n" +
  "1. Review the status below. If any paths should not be tracked (build output, secrets, local caches, editor state, env files), update .gitignore first.\n" +
  "2. Stage the intended files and commit them with a descriptive commit message.\n" +
  "3. If you intentionally left changes uncommitted, briefly say why.\n" +
  "Do not commit secrets or files that belong in .gitignore."

/** Bounded git probe so hung fs/git cannot stall turn settlement. */
export const UNCOMMITTED_HINT_GIT_TIMEOUT_MS = 2000

export type UncommittedHintConfig = {
  enabled?: boolean
}

/** Sentinel: live MIMOCODE_CONFIG_CONTENT present but not parseable JSON. */
export const UNCOMMITTED_HINT_CONFIG_PARSE_FAILED = "parse-failed" as const
export type UncommittedHintConfigParse = UncommittedHintConfig | undefined | typeof UNCOMMITTED_HINT_CONFIG_PARSE_FAILED

export type UncommittedHintTurnSource = "user" | "spawn" | "hook" | (string & {}) | undefined

export type UncommittedHintDecisionInput = {
  enabled: boolean
  outcome: "completed" | "error" | "cancelled" | string
  agentID: string
  hasDirectory: boolean
  isGitRepo: boolean
  dirty: boolean
  /** Diagnostic counter of prior successful injects; does NOT gate re-hint while dirty. */
  consecutiveHints?: number
  /** Prompt source of the completed turn; only explicit "user" may inject. */
  turnSource?: UncommittedHintTurnSource
}

export type UncommittedHintDecision =
  | { action: "inject"; reason: "dirty" }
  | {
      action: "skip"
      reason:
        | "disabled"
        | "bad_outcome"
        | "not_main"
        | "non_user_source"
        | "no_directory"
        | "not_repo"
        | "clean"
    }

/** Parse live MIMOCODE_CONFIG_CONTENT so mid-session desktop toggles apply on the next turn. */
export function uncommittedHintConfigFromConfigContent(
  content: string | undefined,
): UncommittedHintConfigParse {
  // undefined = live env not provided → caller may use cached/file.
  if (content === undefined) return undefined
  // Provided but not usable JSON (empty string or parse error) → fail-closed sentinel.
  if (content === "") return UNCOMMITTED_HINT_CONFIG_PARSE_FAILED
  try {
    const parsed = JSON.parse(content) as { experimental?: { uncommitted_hint?: UncommittedHintConfig } }
    return parsed?.experimental?.uncommitted_hint
  } catch {
    return UNCOMMITTED_HINT_CONFIG_PARSE_FAILED
  }
}

/**
 * Effective config authority for uncommitted_hint.
 * - Live CONFIG_CONTENT malformed or empty → fail-closed `{enabled:false}` (do not revive cached).
 * - Live CONFIG_CONTENT has an explicit uncommitted_hint key (incl. enabled:false) → that key wins.
 * - Live env undefined, or live env valid JSON but key absent → cached/file config still applies.
 * - Desktop lab toggle always writes an explicit true/false key.
 */
export function resolveUncommittedHintConfig(input: {
  liveContent?: string
  cached?: UncommittedHintConfig
}): UncommittedHintConfig | undefined {
  if (input.liveContent !== undefined) {
    const live = uncommittedHintConfigFromConfigContent(input.liveContent)
    if (live === UNCOMMITTED_HINT_CONFIG_PARSE_FAILED) return { enabled: false }
    // Explicit null / non-object config section → off.
    if (live === null) return { enabled: false }
    if (live !== undefined) {
      if (typeof live !== "object") return { enabled: false }
      return { enabled: (live as UncommittedHintConfig).enabled === true }
    }
  }
  // Live env undefined, or live env valid JSON with key absent → cached/file still applies.
  return input.cached
}

export function uncommittedHintEnabledFromConfig(cfg: UncommittedHintConfig | undefined): boolean {
  return cfg?.enabled === true
}

/** Normalize porcelain for episode identity (keep leading XY spaces; trim trailing only). */
export function normalizePorcelain(statusOut: string | null | undefined): string {
  return (statusOut ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "")
}

export function decideUncommittedHint(input: UncommittedHintDecisionInput): UncommittedHintDecision {
  if (!input.enabled) return { action: "skip", reason: "disabled" }
  if (input.outcome !== "completed") return { action: "skip", reason: "bad_outcome" }
  if (input.agentID !== "main") return { action: "skip", reason: "not_main" }
  // Fail-closed source gate: only an explicit user-source main turn may inject.
  // Hook (hint itself), spawn, undefined (internal wakes that forgot to classify) skip.
  if (input.turnSource !== "user") return { action: "skip", reason: "non_user_source" }
  if (!input.hasDirectory) return { action: "skip", reason: "no_directory" }
  if (!input.isGitRepo) return { action: "skip", reason: "not_repo" }
  if (!input.dirty) return { action: "skip", reason: "clean" }
  // Re-hint while dirty on later USER turns — do not hard-cap at session-once.
  // Clean stops naturally; hook/spawn/undefined already fail-closed above.
  return { action: "inject", reason: "dirty" }
}

/** Structured slog payload for uncommitted-hint decisions (R7). */
export function uncommittedHintLogFields(input: {
  decision: string
  reason: string
  enabled: boolean
  turnSource?: UncommittedHintTurnSource
  dirty?: boolean
}): {
  decision: string
  reason: string
  enabled: boolean
  turnSource?: UncommittedHintTurnSource
  dirty?: boolean
} {
  return {
    decision: input.decision,
    reason: input.reason,
    enabled: input.enabled,
    turnSource: input.turnSource,
    dirty: input.dirty,
  }
}

/**
 * Test barrier after delay/git gates and immediately before `state.start`.
 * Identity revalidation runs INSIDE claimed work (common admission with message create).
 */
export const hintClaimBarrier: {
  onReached?: () => void
  wait?: () => Promise<unknown>
} = {}

/** Test barrier for the first git probe. */
export const hintGitProbeBarrier: { onReached?: () => void; wait?: () => Promise<unknown> } = {}

/** Test barrier at firePostSession entry, BEFORE beginPendingHint (late-register window). */
export const hintFirePostBarrier: { onReached?: () => void; wait?: () => Promise<unknown> } = {}

/**
 * Main-session hint execution token. Child actor runLoops must NOT open or
 * overwrite this — SessionPrompt.cancel targets main only.
 */
export type MainHintToken = {
  cancelled: boolean
  /** Session workspace directory at token open; used for instance-dispose cleanup. */
  directory?: string
}

export type PendingHint = {
  readonly sessionID: string
  readonly token: MainHintToken
  cancelled: boolean
}

const pendingHints = new Map<string, Set<PendingHint>>()
const mainHintTokens = new Map<string, MainHintToken>()
/** sessionID → workspace directory for hintState cleanup on instance dispose. */
const hintSessionDirectory = new Map<string, string>()

/** Open a fresh MAIN user-turn token. Child/hook runLoops must not call this. Cancels any prior main token. */
export function openMainHintToken(sessionID: string, directory?: string): MainHintToken {
  const prev = mainHintTokens.get(sessionID)
  if (prev) prev.cancelled = true
  if (directory) hintSessionDirectory.set(sessionID, directory)
  const token: MainHintToken = { cancelled: false, directory: directory ?? prev?.directory }
  mainHintTokens.set(sessionID, token)
  return token
}

export function currentMainHintToken(sessionID: string): MainHintToken | undefined {
  return mainHintTokens.get(sessionID)
}

/** Cancel targets the current MAIN token — not whatever actor last ran. */
export function cancelMainHintToken(sessionID: string): void {
  const token = mainHintTokens.get(sessionID)
  if (token) token.cancelled = true
}

export function beginPendingHint(sessionID: string, token: MainHintToken): PendingHint {
  const handle: PendingHint = { sessionID, token, cancelled: token.cancelled }
  let set = pendingHints.get(sessionID)
  if (!set) {
    set = new Set()
    pendingHints.set(sessionID, set)
  }
  set.add(handle)
  return handle
}

/** Session-wide cancel: current main token + every pending handle for the session. */
export function cancelPendingHints(sessionID: string): void {
  cancelMainHintToken(sessionID)
  const set = pendingHints.get(sessionID)
  if (!set) return
  for (const handle of set) {
    handle.cancelled = true
  }
}

export function endPendingHint(handle: PendingHint): void {
  pendingHints.get(handle.sessionID)?.delete(handle)
}

/** Full session cleanup: invalidate live token then drop registry rows (R011). */
export function clearPendingHints(sessionID: string): void {
  const token = mainHintTokens.get(sessionID)
  if (token) token.cancelled = true
  mainHintTokens.delete(sessionID)
  pendingHints.delete(sessionID)
}

export function isPendingHintLive(handle: PendingHint | undefined): boolean {
  if (!handle || handle.cancelled) return false
  return !handle.token.cancelled
}

export function hasMainHintToken(sessionID: string): boolean {
  return mainHintTokens.has(sessionID)
}

export function hasPendingHintRows(sessionID: string): boolean {
  return pendingHints.has(sessionID)
}

/** Test helper. */
export function resetHintExecState(sessionID?: string): void {
  if (sessionID === undefined) {
    pendingHints.clear()
    mainHintTokens.clear()
    hintSessionDirectory.clear()
    return
  }
  clearPendingHints(sessionID)
  hintSessionDirectory.delete(sessionID)
}

/**
 * Instance dispose cleanup for this workspace directory only.
 * Cancels tokens/pending/count for sessions opened under `directory`.
 * Does not clear other instances' sessions.
 */
export function clearHintStateForDirectory(directory: string): void {
  const finish = beginHintStateDisposeForDirectory(directory)
  finish()
}

/**
 * Begin dispose for an instance directory: immediately invalidate tokens/pending
 * owned by sessions recorded under `directory`. Returns a finisher that deletes
 * only map entries whose **current** token is still one captured at begin —
 * a same-directory replacement instance that opened a newer token is left intact.
 */
export function beginHintStateDisposeForDirectory(directory: string): () => void {
  const captured = new Map<string, MainHintToken>()
  const orphanIndexes = new Set<string>()
  for (const [sid, dir] of hintSessionDirectory) {
    if (dir !== directory) continue
    const tok = mainHintTokens.get(sid)
    if (tok) {
      tok.cancelled = true
      captured.set(sid, tok)
    } else {
      // Session delete left a directory-index row without a live token.
      orphanIndexes.add(sid)
    }
    const set = pendingHints.get(sid)
    if (set) {
      for (const handle of set) handle.cancelled = true
    }
  }
  for (const [sid, tok] of mainHintTokens) {
    if (tok.directory !== directory) continue
    tok.cancelled = true
    captured.set(sid, tok)
    const set = pendingHints.get(sid)
    if (set) {
      for (const handle of set) handle.cancelled = true
    }
  }
  return () => {
    for (const [sid, tok] of captured) {
      if (mainHintTokens.get(sid) !== tok) continue
      mainHintTokens.delete(sid)
      hintSessionDirectory.delete(sid)
      pendingHints.delete(sid)
      hintState.delete(sid)
    }
    for (const sid of orphanIndexes) {
      // Replacement instance may have opened a new token for this session during
      // dispose — do not delete its directory index.
      if (mainHintTokens.has(sid)) continue
      if (hintSessionDirectory.get(sid) !== directory) continue
      hintSessionDirectory.delete(sid)
    }
  }
}

/** Pure gate used by prompt entry: hook + non-text parts require provenance. */
export function hookNonTextRequiresProvenance(input: {
  source?: string
  provenance?: unknown
  parts: Array<{ type: string }>
}): boolean {
  return (
    input.source === "hook" &&
    !input.provenance &&
    input.parts.some((part) => part.type !== "text")
  )
}

export function isWorkingTreeDirty(statusOut: string | null | undefined): boolean {
  if (!statusOut || typeof statusOut !== "string") return false
  return statusOut.split(/\r?\n/).some((line) => line.trim().length > 0)
}

/** Diagnostic counter: inject increments; clean resets; other skips leave prior. */
export function nextHintCount(prev: number, dirty: boolean, injected: boolean): number {
  if (injected) return prev + 1
  if (!dirty) return 0
  return prev
}

/** Build hint body: reminder + porcelain status. Keep leading XY columns (no full trim). */
export function buildHintText(statusOut: string): string {
  const status = normalizePorcelain(statusOut)
  if (!status) return UNCOMMITTED_HINT_PROMPT
  return `${UNCOMMITTED_HINT_PROMPT}\n\nCurrent git status --porcelain:\n${status}`
}

export type UncommittedHintSessionState = {
  count: number
}

const hintState = new Map<string, UncommittedHintSessionState>()

export function getHintCount(sessionID: string): number {
  return hintState.get(sessionID)?.count ?? 0
}

/** Drop session-level hint state (session deleted / instance disposed). */
export function clearHintCount(sessionID: string): void {
  hintState.delete(sessionID)
}

/** Full per-session cleanup including directory index (session delete). */
export function clearAllHintStateForSession(sessionID: string): void {
  clearPendingHints(sessionID)
  clearHintCount(sessionID)
  mainHintTokens.delete(sessionID)
  hintSessionDirectory.delete(sessionID)
}

/** Test/observability: whether a session still has a workspace directory index row. */
export function hasHintDirectoryIndex(sessionID: string): boolean {
  return hintSessionDirectory.has(sessionID)
}

/** Test/observability: number of directory-index rows (leak detector). */
export function hintDirectoryIndexSize(): number {
  return hintSessionDirectory.size
}

/**
 * Record hint outcome for diagnostics. Inject may happen again on later dirty
 * USER turns; clean resets the counter. Does not hard-cap injection.
 */
export function recordHintOutcome(
  sessionID: string,
  input: { dirty: boolean; injected: boolean; consecutiveHints: number },
): void {
  const count = nextHintCount(input.consecutiveHints, input.dirty, input.injected)
  if (count <= 0) {
    hintState.delete(sessionID)
    return
  }
  hintState.set(sessionID, { count })
}

export function resetHintCounters(): void {
  hintState.clear()
}
