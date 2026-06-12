export function shouldAbortBusySession(input: {
  appExit: boolean
  sessionID?: string
  status: { type: string }
}) {
  return input.appExit && !!input.sessionID && input.status.type !== "idle"
}
