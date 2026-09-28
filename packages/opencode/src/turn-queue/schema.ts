import type { MessageID, SessionID } from "@/session/schema"

export type Lane = { sessionID: SessionID; agentID: string }

export type PromptIntent = { kind: "prompt"; messageID: MessageID }
export type ResumeIntent = {
  kind: "resume"
  assistantID: MessageID
  plan: "user-resume" | "tool-resume"
  expectedAssistantStatus?: string
}
export type WakeIntent = {
  kind: "wake"
  receiverActorID: string
  inboxWatermark: string
}
export type ShellIntent = { kind: "shell"; command: string; cwd?: string }

export type Intent = PromptIntent | ResumeIntent | WakeIntent | ShellIntent

export type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
export type ReceiptOutcome = "success" | "assistant_error" | "interrupted" | "never_ran"

export type Receipt = {
  id: string
  lane: Lane
  state: ReceiptState
  intent: Intent
  epoch: number
  runId?: number
  claimFrontier?: MessageID
  consumed: boolean
  suspended: boolean
  outcome?: ReceiptOutcome
  messageId?: MessageID
  error?: string
  idempotencyKey?: string
  time: { created: number; updated: number }
}

export type AdmitInput = {
  lane: Lane
  intent: Intent
  idempotencyKey?: string
}

export type AbortPolicy = "drop" | "keep-suspended"

/** Eligibility order for mailbox pop (lower = first). Not a transcript reorder. */
export function intentRank(intent: Intent): number {
  switch (intent.kind) {
    case "prompt":
      return 0
    case "resume":
      return intent.plan === "user-resume" ? 1 : 2
    case "wake":
      return 3
    case "shell":
      return 4
  }
}

export function isCoalescable(intent: Intent): intent is WakeIntent {
  return intent.kind === "wake"
}

/** inputRevision bumps only for user-facing steer (prompt). Wake/shell never steer. */
export function bumpsInputRevision(intent: Intent): boolean {
  return intent.kind === "prompt"
}

export const DEFAULT_AGENT = "main"
