import { Effect } from "effect"

export type RecoverCandidate =
  | { kind: "parent-user"; userMessageID: string; created: number }
  | { kind: "assistant"; assistantMessageID: string; parentMessageID: string; created: number }

export type RecoverOutcome =
  | { type: "none" }
  | { type: "busy" }
  | { type: "started"; kind: "parent-user" | "assistant"; id: string }
  | { type: "error"; message: string; variant: "busy" | "error" }

export type RecoverDeps = {
  status?: { type?: string } | undefined
  listCandidates: () => Promise<RecoverCandidate[]>
  resumeUser: (input: { userMessageID: string }) => Promise<void>
  resumeAssistant: (input: { assistantMessageID: string }) => Promise<void>
  setActive: (id: string) => void
  /** Prefer this assistant candidate when set (explicit ↻ /recover on a message). */
  assistantMessageID?: string | undefined
}

export function recoverErrorMessage(error: unknown): { message: string; variant: "busy" | "error" } {
  const message = error instanceof Error ? error.message : String(error)
  return { message, variant: /busy|409/i.test(message) ? "busy" : "error" }
}

/** TUI /recover entry: pick candidate, dispatch resume, map 202/reject/busy. */
export async function runSessionRecover(deps: RecoverDeps): Promise<RecoverOutcome> {
  if (deps.status?.type === "busy" || deps.status?.type === "retry") {
    return { type: "busy" }
  }
  let list: RecoverCandidate[]
  try {
    list = await deps.listCandidates()
  } catch (error) {
    return { type: "error", ...recoverErrorMessage(error) }
  }
  const candidate = deps.assistantMessageID
    ? list.find((item) => item.kind === "assistant" && item.assistantMessageID === deps.assistantMessageID)
    : list.at(-1)
  if (!candidate) return { type: "none" }
  try {
    if (candidate.kind === "parent-user") {
      await deps.resumeUser({ userMessageID: candidate.userMessageID })
      deps.setActive(candidate.userMessageID)
      return { type: "started", kind: "parent-user", id: candidate.userMessageID }
    }
    await deps.resumeAssistant({ assistantMessageID: candidate.assistantMessageID })
    deps.setActive(candidate.assistantMessageID)
    return { type: "started", kind: "assistant", id: candidate.assistantMessageID }
  } catch (error) {
    return { type: "error", ...recoverErrorMessage(error) }
  }
}

/** session.status→idle clears the recovery-active badge (sync.tsx). */
export function shouldClearRecoveryActiveOnIdle(status?: { type?: string }): boolean {
  return status?.type === "idle"
}

/** session.error clears the badge only when not mid-turn (sync.tsx). */
export function shouldClearRecoveryActiveOnError(status?: { type?: string } | undefined): boolean {
  return status === undefined || status.type === "idle"
}

export const recoverFlow = Effect.succeed({
  runSessionRecover,
  recoverErrorMessage,
  shouldClearRecoveryActiveOnIdle,
  shouldClearRecoveryActiveOnError,
})
