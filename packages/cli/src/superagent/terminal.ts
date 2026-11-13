import type { MessageV2 } from "@/session/message-v2"
export function terminalReport(agent: string, parts: MessageV2.Part[]) {
  return (
    agent === "superagent-worker" &&
    parts.some(
      (p) =>
        p.type === "tool" &&
        p.tool === "superagent_report" &&
        p.state.status === "completed" &&
        p.state.metadata.superagentTerminal === true,
    ) &&
    parts.every((p) => p.type !== "tool" || p.state.status === "completed" || p.state.status === "error")
  )
}
