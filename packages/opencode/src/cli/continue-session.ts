const SYSTEM_CONTINUE_TITLES = new Set(["Auto Dream", "Auto Distill"])

type ContinueSessionCandidate = {
  id: string
  title?: string
  parentID?: string
  time?: {
    updated?: number
  }
}

export function selectContinueSessionID(sessions: ContinueSessionCandidate[]) {
  return sessions
    .toSorted((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .find((session) => session.parentID === undefined && !SYSTEM_CONTINUE_TITLES.has(session.title ?? ""))?.id
}
