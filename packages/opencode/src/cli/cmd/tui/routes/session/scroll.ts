export function conversationScrollKey(input: { sessionID: string; agentID?: string }) {
  return `${input.sessionID}:${input.agentID ?? "main"}`
}
