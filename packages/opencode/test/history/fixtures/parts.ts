// One real persisted shape for every MessageV2.Part variant.
export const partExamples: { data: Record<string, unknown> & { type: string }; query?: string; detail: string }[] = [
  { data: { type: "text", text: "textneedle" }, query: "textneedle", detail: "textneedle" },
  {
    data: { type: "reasoning", text: "reasonneedle", time: { start: 1, end: 2 } },
    query: "reasonneedle",
    detail: "reasonneedle",
  },
  {
    data: {
      type: "file",
      mime: "image/png",
      filename: "drawing.png",
      url: "data:image/png;base64,YWJj",
      source: {
        type: "symbol",
        path: "/repo/sourcepath.ts",
        name: "symbolneedle",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
        text: { value: "reference", start: 0, end: 9 },
      },
    },
    query: "symbolneedle",
    detail: "symbolneedle",
  },
  {
    data: {
      type: "tool",
      tool: "read",
      callID: "call_test",
      state: {
        status: "completed",
        input: { path: "inputneedle" },
        output: "toolneedle",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
    query: "toolneedle",
    detail: "toolneedle",
  },
  {
    data: {
      type: "subtask",
      prompt: "subtaskneedle",
      description: "task description",
      agent: "explore",
      command: "inspect",
    },
    query: "subtaskneedle",
    detail: "subtaskneedle",
  },
  {
    data: {
      type: "compaction",
      auto: true,
      projection: {
        version: 1,
        summary_message_id: "msg_summary",
        summary: "summaryneedle",
        manifest: "manifestneedle",
        trigger: "manual",
      },
    },
    query: "summaryneedle",
    detail: "summaryneedle",
  },
  {
    data: { type: "patch", hash: "patch-hash", files: ["/repo/pathneedle.ts"] },
    query: "pathneedle",
    detail: "pathneedle",
  },
  {
    data: { type: "agent", name: "agentneedle", source: { value: "agent reference", start: 0, end: 15 } },
    query: "agentneedle",
    detail: "agentneedle",
  },
  {
    data: {
      type: "retry",
      attempt: 1,
      error: { name: "APIError", data: { message: "retryneedle", responseBody: "responseneedle", isRetryable: true } },
      time: { created: 1 },
    },
    query: "retryneedle",
    detail: "retryneedle",
  },
  { data: { type: "snapshot", snapshot: "snapshotneedle" }, detail: "snapshotneedle" },
  {
    data: {
      type: "checkpoint",
      checkpointDir: "/repo/checkpointneedle",
      checkpointNumber: 1,
      coveredUpTo: "msg_checkpoint",
    },
    detail: "checkpointneedle",
  },
  { data: { type: "step-start", snapshot: "startneedle" }, detail: "startneedle" },
  {
    data: {
      type: "step-finish",
      reason: "finishneedle",
      cost: 0.1,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    detail: "finishneedle",
  },
]
