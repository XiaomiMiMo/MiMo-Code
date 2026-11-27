// packages/cli/src/cli/cmd/run-completion.ts

export type StatusInfo = { type: "idle" | "busy" | "retry" | "notice"; [k: string]: unknown }

/** Returns current status of the tracked session, or undefined if absent (= idle). */
export type StatusQuery = () => Promise<StatusInfo | undefined>

export interface CompletionTracker {
  markStarted(): void
  onEvent(event: unknown): void
  readonly done: boolean
  readonly completion: Promise<void>
  stop(): void
}

export interface CreateOpts {
  sessionID: string
  query: StatusQuery
  intervalMs?: number
}

export function createCompletionTracker(opts: CreateOpts): CompletionTracker {
  let done = false
  let started = false
  let resolve!: () => void
  const completion = new Promise<void>((r) => { resolve = r })

  // Until the session first runs it has no status record, which the poll reads
  // as idle. So only a status showing it running starts the tracker; other
  // session events can arrive before that and must not.
  const isRunningStatusForSession = (e: unknown): boolean => {
    const ev = e as { type?: string; properties?: { sessionID?: string; status?: { type?: string } } } | null
    return !!ev
      && ev.type === "session.status"
      && ev.properties?.sessionID === opts.sessionID
      && !!ev.properties?.status?.type
      && ev.properties.status.type !== "idle"
  }

  const isIdleStatusForSession = (e: unknown): boolean => {
    const ev = e as { type?: string; properties?: { sessionID?: string; status?: { type?: string } } } | null
    return !!ev
      && ev.type === "session.status"
      && ev.properties?.sessionID === opts.sessionID
      && ev.properties?.status?.type === "idle"
  }

  const poll = async () => {
    if (done) return
    // A reply that arrives after the first busy status may still have been
    // read before it, so only a poll sent once started can end the run.
    const wasStarted = started
    let info: StatusInfo | undefined
    try {
      info = await opts.query()
    } catch {
      return // transient failure; next tick will retry
    }
    if (done || !wasStarted) return
    if (!info || info.type === "idle") finish()
  }

  const intervalMs = opts.intervalMs ?? 750
  const timer = setInterval(() => { poll().catch(() => {}) }, intervalMs)

  const finish = () => {
    if (done) return
    done = true
    clearInterval(timer)
    resolve()
  }

  return {
    markStarted() { started = true },
    onEvent(event) {
      if (done) return
      if (isRunningStatusForSession(event)) started = true
      if (isIdleStatusForSession(event)) finish()
    },
    get done() { return done },
    completion,
    stop() { finish() },
  }
}
