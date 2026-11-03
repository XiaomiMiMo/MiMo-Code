// Ports the connector runtime depends on. The runtime is agent-agnostic: a
// MiMo Code adapter, an ACP adapter or a test double implements AgentBackend.

/** A session as the local agent lists it (same set the local session list shows). */
export type BackendSession = { id: string; title: string; updatedAt: number }

export type BackendPart = {
  messageId: string
  partId: string
  role: "user" | "assistant"
  /** The user message this part belongs to: its own ID for user parts, the parent prompt for replies. */
  turnId: string | null
  /** Plain text of the part; non-text parts are not exposed under the text-only profile. */
  text: string
}

export type BackendTurn = {
  /** The user message that started the turn. */
  inputMessageId: string
  /** The assistant reply that answers it (the last one when a prompt took several steps). */
  assistantMessageId: string
  /** Proven by the agent's own durable record; `unknown` when it cannot be proven. */
  phase: "running" | "completed" | "failed" | "cancelled" | "unknown"
}

export type BackendSnapshot = {
  title: string
  phase: "idle" | "running" | "retry" | "unknown"
  /** Text parts in conversation order. */
  parts: BackendPart[]
  turns: BackendTurn[]
  /** False when the agent could not read the whole conversation; it is then never shown as complete. */
  complete?: boolean
}

export type SubmitOutcome =
  /** The agent durably admitted the text as `messageId`. */
  | { kind: "accepted" }
  /** Proven not admitted: nothing was written and nothing will run. */
  | { kind: "rejected"; reason: "busy" | "invalid" | "offline" | "read-only" }
  /** The agent may or may not have admitted it; only a later lookup can tell. */
  | { kind: "unknown" }

export type LookupOutcome = { kind: "admitted" } | { kind: "absent" } | { kind: "unknown" }

export interface AgentBackend {
  /** Sessions in the local list order (most recent first). */
  listSessions(): Promise<BackendSession[]>
  /** Current content of one session, or undefined if it is not (or no longer) listed. */
  snapshot(sessionId: string): Promise<BackendSnapshot | undefined>
  /** Called whenever any listed session or its content may have changed. Returns an unsubscribe. */
  watch(onChange: (sessionId: string | undefined) => void): () => void
  /** A new ID the agent accepts for a user message (time-ordered like its own IDs). */
  newMessageId(): string
  /** Submit `text` into the original session as user message `messageId`, idempotent on messageId. */
  submit(sessionId: string, messageId: string, text: string): Promise<SubmitOutcome>
  /** Read-only: was a user message with this ID admitted into the session? Never submits. */
  lookup(sessionId: string, messageId: string): Promise<LookupOutcome>
}

/**
 * System-protected secret storage (keychain, Secret Service, DPAPI). No
 * plaintext fallback: an unavailable store keeps the connector disabled.
 */
export interface SecretStore {
  available(): Promise<boolean>
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
