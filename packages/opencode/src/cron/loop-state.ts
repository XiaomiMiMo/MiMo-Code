export type LoopState = {
  prompt: string
  startedAt: number
  lastScheduledFor: number
  agedOut?: boolean
  keepaliveStrikes: number
}

const STATE = new Map<string, LoopState>()

export const getLoopState = (prompt: string): LoopState | null => STATE.get(prompt) ?? null

export const setLoopState = (s: LoopState): void => {
  STATE.set(s.prompt, s)
}

export const deleteLoopState = (prompt: string): void => {
  STATE.delete(prompt)
}

export const listLoopStates = (): LoopState[] => [...STATE.values()]

export const clearAllLoopStates = (): void => {
  STATE.clear()
}

export const resetStrikes = (prompt: string): void => {
  const s = STATE.get(prompt)
  if (!s) return
  STATE.set(prompt, { ...s, keepaliveStrikes: 0 })
}

export const incrementStrikes = (prompt: string): number => {
  const s = STATE.get(prompt)
  if (!s) return 0
  const next = { ...s, keepaliveStrikes: s.keepaliveStrikes + 1 }
  STATE.set(prompt, next)
  return next.keepaliveStrikes
}

export const getStrikes = (prompt: string): number => STATE.get(prompt)?.keepaliveStrikes ?? 0
