import { expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { terminalReport } from "../../src/superagent/terminal"

function report(tool = "superagent_report", status = "completed", accepted = true): MessageV2.ToolPart {
  return MessageV2.ToolPart.parse({
    id: "prt_example",
    messageID: "msg_example",
    sessionID: "ses_example",
    type: "tool",
    tool,
    callID: "call_example",
    state:
      status === "completed"
        ? {
            status,
            input: {},
            title: "Accepted",
            output: "{}",
            metadata: accepted ? { superagentTerminal: true } : {},
            time: { start: 1, end: 2 },
          }
        : status === "error"
          ? { status, input: {}, error: "Stale report", time: { start: 1, end: 2 } }
          : { status, input: {}, time: { start: 1 } },
  })
}

test("only successful terminal reports stop the matching Super-agent role", () => {
  expect(terminalReport("superagent-worker", [report()])).toBe(true)
  for (const role of ["build", "superagent-router", "superagent-task", "superagent-verifier"])
    expect(terminalReport(role, [report()])).toBe(false)
  expect(terminalReport("superagent-worker", [])).toBe(false)
  expect(terminalReport("superagent-worker", [report("superagent_report", "error")])).toBe(false)
  expect(terminalReport("superagent-worker", [report("superagent_report", "completed", false)])).toBe(false)
  expect(terminalReport("superagent-worker", [report(), report("bash", "running")])).toBe(false)
})
