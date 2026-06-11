import { describe, expect, test } from "bun:test"
import { classifyAssistantStep } from "../../src/session/classify"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"

const sessionID = SessionID.make("session")

function userInfo(id: string): MessageV2.User {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  extra?: Partial<Pick<MessageV2.Assistant, "finish" | "error" | "summary" | "structured">>,
): MessageV2.Assistant {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: MessageID.make("m-parent"),
    modelID: "test",
    providerID: "test",
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
  } as unknown as MessageV2.Assistant
}

let partSeq = 0
function basePart(messageID: string) {
  return { id: PartID.make(`p-${partSeq++}`), sessionID, messageID: MessageID.make(messageID) }
}
function textPart(messageID: string, text: string, extra?: { synthetic?: boolean; ignored?: boolean }) {
  return { ...basePart(messageID), type: "text", text, ...extra } as unknown as MessageV2.Part
}
function reasoningPart(messageID: string, text: string) {
  return { ...basePart(messageID), type: "reasoning", text, time: { start: 0 } } as unknown as MessageV2.Part
}
function toolPart(messageID: string, opts?: { providerExecuted?: boolean }) {
  return {
    ...basePart(messageID),
    type: "tool",
    callID: "call-1",
    tool: "read",
    state: { status: "completed", input: {}, output: "ok", time: { start: 0, end: 1 }, title: "", metadata: {} },
    metadata: opts?.providerExecuted ? { providerExecuted: true } : undefined,
  } as unknown as MessageV2.Part
}

// User "m-1" precedes assistant "m-2" so the stale guard (lastUser.id < assistant.id) is satisfied.
const lastUser = userInfo("m-1")

describe("classifyAssistantStep", () => {
  test("stop + non-empty text => final (not degraded)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [textPart("m-2", "here is the answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("other + non-empty text => degraded final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [textPart("m-2", "usable answer despite an abnormal finish")],
      }),
    ).toEqual({ type: "final", degraded: true })
  })

  test("other + empty => invalid (routes to T01 nudge path)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [],
      }).type,
    ).toBe("invalid")
  })

  test("other + reasoning only => think-only (routes to T01 nudge path)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "other" }),
        parts: [reasoningPart("m-2", "let me think...")],
      }),
    ).toEqual({ type: "think-only" })
  })

  describe("core guarantee: any finish + client tool part => continue", () => {
    for (const finish of ["stop", "other", "length", "content-filter"]) {
      test(`finish=${finish} + client tool part (with non-empty final text) => continue`, () => {
        expect(
          classifyAssistantStep({
            phase: "after-process",
            lastUser,
            assistant: assistantInfo("m-2", { finish }),
            parts: [textPart("m-2", "looks done but a tool is still pending"), toolPart("m-2")],
          }),
        ).toEqual({ type: "continue" })
      })
    }
  })

  test("finish=tool-calls => continue", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "tool-calls" }),
        parts: [],
      }),
    ).toEqual({ type: "continue" })
  })

  test("no finish => continue", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2"),
        parts: [textPart("m-2", "partial")],
      }),
    ).toEqual({ type: "continue" })
  })

  test("provider-executed tool part only + stop + text => final (provider-executed isn't a client tool)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [toolPart("m-2", { providerExecuted: true }), textPart("m-2", "answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("provider-executed tool part only + stop + no text => think-only/invalid (not continue)", () => {
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", { finish: "stop" }),
      parts: [toolPart("m-2", { providerExecuted: true })],
    })
    expect(result.type).toBe("invalid")
  })

  test("content-filter => filtered", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "content-filter" }),
        parts: [],
      }),
    ).toEqual({ type: "filtered" })
  })

  test("finish=error => failed", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "error" }),
        parts: [],
      }).type,
    ).toBe("failed")
  })

  test("finish=error + non-empty text => failed (error finish beats final text)", () => {
    // T03: a model "error" finish must terminate FAILED even when the step also
    // produced text — error is checked before content (classify.ts step 5 vs 8),
    // so it is never silently downgraded to a `final`.
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", { finish: "error" }),
      parts: [textPart("m-2", "some text emitted before the error finish")],
    })
    expect(result.type).toBe("failed")
  })

  test("assistant.error set => failed even with non-empty text (not misjudged final)", () => {
    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", {
        finish: "stop",
        error: new MessageV2.OutputLengthError({}).toObject(),
      }),
      parts: [textPart("m-2", "some text that should not count as final")],
    })
    expect(result.type).toBe("failed")
  })

  test("stop + reasoning only (no text) => think-only", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [reasoningPart("m-2", "let me think...")],
      }),
    ).toEqual({ type: "think-only" })
  })

  test("stop + empty (no text/tool/reasoning) => invalid", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [],
      }).type,
    ).toBe("invalid")
  })

  test("synthetic/ignored/whitespace text does not count as final => invalid", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [
          textPart("m-2", "synthetic", { synthetic: true }),
          textPart("m-2", "ignored", { ignored: true }),
          textPart("m-2", "   "),
        ],
      }).type,
    ).toBe("invalid")
  })

  test("existing-assistant phase + stale assistant (lastUser.id >= assistant.id) => continue", () => {
    // user "m-2" comes after assistant "m-1": assistant predates the current turn.
    expect(
      classifyAssistantStep({
        phase: "existing-assistant",
        lastUser: userInfo("m-2"),
        assistant: assistantInfo("m-1", { finish: "stop" }),
        parts: [textPart("m-1", "old answer")],
      }),
    ).toEqual({ type: "continue" })
  })

  test("existing-assistant phase + fresh assistant + stop + text => final", () => {
    expect(
      classifyAssistantStep({
        phase: "existing-assistant",
        lastUser: userInfo("m-1"),
        assistant: assistantInfo("m-2", { finish: "stop" }),
        parts: [textPart("m-2", "answer")],
      }),
    ).toEqual({ type: "final" })
  })

  test("assistant.summary => final (terminal, never nudge-able)", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop", summary: true }),
        parts: [],
      }),
    ).toEqual({ type: "final" })
  })

  test("assistant.structured set => final", () => {
    expect(
      classifyAssistantStep({
        phase: "after-process",
        lastUser,
        assistant: assistantInfo("m-2", { finish: "stop", structured: { answer: 4 } }),
        parts: [],
      }),
    ).toEqual({ type: "final" })
  })

  test("errored tool part → failed (Spec ③ P1 regression)", () => {
    // SSE timeout cleanup marks pending tool parts as state.status === "error".
    // Without the guard, these parts caused mis-classification as "continue" because
    // the pending-tool check ranked above assistant.error. This led runLoop to
    // re-enter and get stranded on permission.ask. Spec ③ P1 fixes this by adding
    // state.status !== "error" to the pending-tool predicate, so errored parts fall
    // through to step 5 (assistant.error) and return failed.
    const errPart = {
      ...basePart("m-2"),
      type: "tool" as const,
      callID: "call-1",
      tool: "read",
      state: {
        status: "error" as const,
        input: {},
        error: "aborted",
        time: { start: 1, end: 2 },
        metadata: {},
      },
    } as unknown as MessageV2.Part

    const result = classifyAssistantStep({
      phase: "after-process",
      lastUser,
      assistant: assistantInfo("m-2", {
        finish: "stop",
        error: new MessageV2.APIError({
          message: "SSE read timed out",
          isRetryable: false,
        }).toObject(),
      }),
      parts: [errPart],
    })
    expect(result).toEqual({ type: "failed", reason: "APIError" })
  })
})
