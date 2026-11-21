export type LoopState = {
  prompt: string
  startedAt: number
  lastScheduledFor: number
  agedOut?: boolean
  keepaliveStrikes: number
  /**
   * Owner session of the loop. Survives task removal after fire so keepalive
   * re-arms (which have no session_id and often find no prior row) still stamp
   * the replacement task with the creating session. Also scopes the STATE
   * slot: identical prompts armed by different sessions keep independent
   * entries instead of overwriting each other.
   */
  createdBySessionId?: string
}

// Entries are keyed by (prompt, owner session): each prompt maps to an inner
// map whose key is createdBySessionId (undefined = ownerless entry, e.g. rows
// written before session stamping existed). Keying by prompt alone let two
// sessions arming loops with identical prompt text share one entry, so
// keepaliveStrikes / startedAt / createdBySessionId silently overwrote each
// other across sessions.
const STATE = new Map<string, Map<string | undefined, LoopState>>()

/**
 * Resolve the inner-map slot a lookup or mutation should address.
 *
 * - With a session: the slot stamped to that session, falling back to an
 *   ownerless entry (legacy rows, keepalive state that never carried a
 *   session_id). Distinct owners never see each other's entries.
 * - Without: the ownerless entry, or the single entry when the prompt has
 *   exactly one owner — needed by keepalive re-arms and other callers that
 *   only know the prompt. When several sessions own entries for the same
 *   prompt the lookup is ambiguous and resolves to null rather than picking
 *   one arbitrarily.
 *
 * Returns the inner map plus the resolved key, or null when no slot matches.
 */
const findEntry = (
  prompt: string,
  session?: string,
): { inner: Map<string | undefined, LoopState>; key: string | undefined } | null => {
  const inner = STATE.get(prompt)
  if (!inner) return null
  if (session !== undefined) {
    if (inner.has(session)) return { inner, key: session }
    if (inner.has(undefined)) return { inner, key: undefined }
    return null
  }
  if (inner.has(undefined)) return { inner, key: undefined }
  if (inner.size === 1) {
    const [key] = inner.keys()
    return { inner, key }
  }
  return null
}

export const getLoopState = (prompt: string, session?: string): LoopState | null => {
  const hit = findEntry(prompt, session)
  if (!hit) return null
  return hit.inner.get(hit.key) ?? null
}

export const setLoopState = (s: LoopState): void => {
  let inner = STATE.get(s.prompt)
  if (!inner) STATE.set(s.prompt, (inner = new Map()))
  // A session-owned write upgrades any ownerless row for the same prompt:
  // before session stamping there was exactly one entry per prompt, so the
  // legacy slot is the same logical loop, not a second one. Dropping it keeps
  // the sweep from striking a stale duplicate.
  if (s.createdBySessionId !== undefined) inner.delete(undefined)
  inner.set(s.createdBySessionId, s)
}

export const deleteLoopState = (prompt: string, session?: string): void => {
  const hit = findEntry(prompt, session)
  if (!hit) return
  hit.inner.delete(hit.key)
  if (hit.inner.size === 0) STATE.delete(prompt)
}

/**
 * Remove every entry for a prompt regardless of owner. Session-less teardown
 * paths (e.g. endLoop called without session_id) remove ALL loop tasks for the
 * prompt; deleting only one resolved entry would orphan the rest, and the
 * keepalive sweep would resurrect the ended loop from those stale rows.
 */
export const deleteAllLoopStates = (prompt: string): void => {
  STATE.delete(prompt)
}

export const listLoopStates = (): LoopState[] => [...STATE.values()].flatMap((inner) => [...inner.values()])

export const clearAllLoopStates = (): void => {
  STATE.clear()
}

export const resetStrikes = (prompt: string, session?: string): void => {
  const hit = findEntry(prompt, session)
  if (!hit) return
  const s = hit.inner.get(hit.key)
  if (!s) return
  hit.inner.set(hit.key, { ...s, keepaliveStrikes: 0 })
}

export const incrementStrikes = (prompt: string, session?: string): number => {
  const hit = findEntry(prompt, session)
  if (!hit) return 0
  const s = hit.inner.get(hit.key)
  if (!s) return 0
  const next = { ...s, keepaliveStrikes: s.keepaliveStrikes + 1 }
  hit.inner.set(hit.key, next)
  return next.keepaliveStrikes
}

export const getStrikes = (prompt: string, session?: string): number => getLoopState(prompt, session)?.keepaliveStrikes ?? 0
