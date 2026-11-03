import type {
  AgentBackend,
  BackendSession,
  BackendSnapshot,
  LookupOutcome,
  SecretStore,
  SubmitOutcome,
} from "../src/ports"

export class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>()
  unavailable = false
  async available() {
    return !this.unavailable
  }
  async get(name: string) {
    return this.values.get(name)
  }
  async set(name: string, value: string) {
    this.values.set(name, value)
  }
  async delete(name: string) {
    this.values.delete(name)
  }
}

/** A scripted agent: sessions, contents, and a submit/lookup log. */
export class FakeBackend implements AgentBackend {
  sessions: BackendSession[] = [{ id: "ses_1", title: "First", updatedAt: 1_700_000_000_000 }]
  snapshots = new Map<string, BackendSnapshot>()
  admitted = new Map<string, string>()
  submits: { sessionId: string; messageId: string; text: string }[] = []
  nextOutcome: SubmitOutcome | undefined
  submitDelayMs = 0
  private counter = 0
  private listeners = new Set<(sessionId: string | undefined) => void>()

  async listSessions() {
    return this.sessions
  }
  async snapshot(sessionId: string) {
    return this.snapshots.get(sessionId)
  }
  watch(onChange: (sessionId: string | undefined) => void) {
    this.listeners.add(onChange)
    return () => this.listeners.delete(onChange)
  }
  changed(sessionId?: string) {
    for (const listener of this.listeners) listener(sessionId)
  }
  newMessageId() {
    this.counter += 1
    return `msg_${String(this.counter).padStart(26, "0")}`
  }
  async submit(sessionId: string, messageId: string, text: string): Promise<SubmitOutcome> {
    if (this.submitDelayMs) await Bun.sleep(this.submitDelayMs)
    this.submits.push({ sessionId, messageId, text })
    const outcome = this.nextOutcome ?? { kind: "accepted" }
    this.nextOutcome = undefined
    if (outcome.kind === "accepted") this.admitted.set(messageId, sessionId)
    return outcome
  }
  async lookup(sessionId: string, messageId: string): Promise<LookupOutcome> {
    return this.admitted.get(messageId) === sessionId ? { kind: "admitted" } : { kind: "absent" }
  }
}
