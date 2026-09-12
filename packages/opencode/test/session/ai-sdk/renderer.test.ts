import { describe, expect, test } from "bun:test"
import { Renderer } from "../../../src/session/ai-sdk/renderer"
import type { MessageJSON, AssistantJSON } from "../../../src/session/ai-sdk/renderer"
import type { UiMessageStreamPart } from "../../../src/session/ai-sdk/extension/output-order-guard"
import type { Part } from "../../../src/session/ai-sdk/extension/types"

describe("Renderer", () => {
  test("outputText concatenates text parts in display order", () => {
    const message: AssistantJSON = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Hello " },
        { type: "step-start" },
        { type: "text", text: "world" },
      ],
    }
    const out = Renderer.outputText(message)
    expect(out.text).toBe("Hello world")
  })

  test("outputText orders text before reasoning before step-start", () => {
    const message: AssistantJSON = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "answer" },
      ],
    }
    const out = Renderer.outputText(message)
    expect(out.text).toBe("answer")
    expect(out.full).toContain("thinking...")
    expect(out.full).toContain("[step-start]")
  })

  test("toUIStreamParts emits parts in display order", () => {
    const message: AssistantJSON = {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "thinking..." },
        { type: "step-start" },
        { type: "text", text: "answer" },
      ],
    }
    const parts: UiMessageStreamPart[] = []
    const writer = { write: (p: UiMessageStreamPart) => parts.push(p) }
    const renderer = new Renderer()
    renderer.toUIStreamParts(message, writer, { mode: "passthrough" })

    // In passthrough mode, raw part types are emitted as-is
    const types = parts.map((p) => (p as { type: string }).type)
    expect(types).toContain("start-step")
    expect(types).toContain("finish")
    // Display order per ROLE_ORDER_FINAL: text (0) → reasoning (1) → step-start (4)
    const textIdx = types.indexOf("text")
    const reasoningIdx = types.indexOf("reasoning")
    const startIdx = types.indexOf("start-step")
    expect(textIdx).toBeLessThan(reasoningIdx)
    expect(reasoningIdx).toBeLessThan(startIdx)
  })

  test("conversation computes steps from step-start markers", () => {
    const messages: MessageJSON[] = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "step one" },
          { type: "step-start" },
          { type: "text", text: "step two" },
        ],
      },
    ]
    const out = Renderer.conversation(messages)
    expect(out.steps.length).toBe(2)
    expect(out.steps[0]!.text).toBe("step one")
    expect(out.steps[1]!.text).toBe("step two")
  })

  test("toModelMessage preserves parts order", () => {
    const parts: Part[] = [
      { type: "text", text: "hello" },
      { type: "step-start" },
      { type: "text", text: "world" },
    ]
    const msg = Renderer.toModelMessage("assistant", parts)
    expect(msg.role).toBe("assistant")
    const content = msg.content as Part[]
    expect(content.length).toBe(3)
    expect(content[0]!.type).toBe("text")
    expect(content[1]!.type).toBe("step-start")
    expect(content[2]!.type).toBe("text")
  })
})
