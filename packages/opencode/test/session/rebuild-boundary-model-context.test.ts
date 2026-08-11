import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

// Pins the AI-facing semantics of the two context-boundary mechanisms so a
// future "let's make rebuild look like compaction" refactor cannot silently
// change what the model receives:
//
//   compaction — boundary user message carries only a `compaction` part, which
//     becomes the bare label "Summary of previous conversation:"
//     (message-v2.ts). The actual summary text lives in a SEPARATE
//     `summary: true` assistant message written by processCompaction
//     (compaction.ts), and that assistant turn is NOT filtered out.
//
//   rebuild — boundary user message carries a `checkpoint` part (label
//     "Summary of previous conversation from checkpoint files:") PLUS the
//     rendered checkpoint index / rebuild context as `synthetic: true` text
//     parts. Synthetic text is excluded from the TUI transcript but IS sent to
//     the model: the user-part filter is `!part.ignored`, not `!part.synthetic`.
//
// Net: both boundaries put a real summary into the model context. Rebuild's
// arrives inline on the boundary user turn; compaction's arrives on the
// following assistant turn.

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function summaryAssistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: model.api.id,
    providerID: model.providerID,
    mode: "compaction",
    agent: "compaction",
    summary: true,
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

const INDEX_TEXT = "## Checkpoint\n\nDirectory: /tmp/cp/\n"
const REBUILD_TEXT = "## Rebuild context\n\nprior turns summarized here\n"
const COMPACTION_SUMMARY_TEXT = "The user asked for X; we did Y."

describe("context boundaries: what reaches the model", () => {
  test("rebuild boundary sends the checkpoint label AND the synthetic rebuild content", async () => {
    const boundaryID = "m-rebuild-boundary"
    const messages = await MessageV2.toModelMessages(
      [
        {
          info: userInfo(boundaryID),
          parts: [
            {
              ...basePart(boundaryID, "p1"),
              type: "checkpoint",
              checkpointDir: "",
              checkpointNumber: 0,
              coveredUpTo: MessageID.make("m-old"),
            },
            { ...basePart(boundaryID, "p2"), type: "text", synthetic: true, text: INDEX_TEXT },
            { ...basePart(boundaryID, "p3"), type: "text", synthetic: true, text: REBUILD_TEXT },
          ] as MessageV2.Part[],
        },
      ],
      model,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    const rendered = JSON.stringify(messages[0].content)
    expect(rendered).toContain("Summary of previous conversation from checkpoint files:")
    // `synthetic: true` hides these from the transcript, never from the model.
    expect(rendered).toContain("## Checkpoint")
    expect(rendered).toContain("prior turns summarized here")
  })

  test("compaction boundary sends a bare label; the summary rides on the assistant turn", async () => {
    const boundaryID = "m-compaction-boundary"
    const summaryID = "m-compaction-summary"
    const messages = await MessageV2.toModelMessages(
      [
        {
          info: userInfo(boundaryID),
          parts: [{ ...basePart(boundaryID, "p1"), type: "compaction", auto: false }] as MessageV2.Part[],
        },
        {
          info: summaryAssistantInfo(summaryID, boundaryID),
          parts: [
            { ...basePart(summaryID, "p2"), type: "text", text: COMPACTION_SUMMARY_TEXT },
          ] as MessageV2.Part[],
        },
      ],
      model,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("user")
    expect(JSON.stringify(messages[0].content)).toContain("Summary of previous conversation:")
    // `summary: true` is NOT a filter — the compaction summary is a real
    // assistant turn in the model context.
    expect(messages[1].role).toBe("assistant")
    expect(JSON.stringify(messages[1].content)).toContain(COMPACTION_SUMMARY_TEXT)
  })

  test("filterCompacted keeps the compaction summary assistant message after the boundary", () => {
    const boundaryID = "m-compaction-boundary"
    const summaryID = "m-compaction-summary"
    // stream() yields newest-first; filterCompacted stops at the boundary and reverses.
    const window = MessageV2.filterCompacted([
      {
        info: summaryAssistantInfo(summaryID, boundaryID),
        parts: [{ ...basePart(summaryID, "p2"), type: "text", text: COMPACTION_SUMMARY_TEXT }] as MessageV2.Part[],
      },
      {
        info: userInfo(boundaryID),
        parts: [{ ...basePart(boundaryID, "p1"), type: "compaction", auto: false }] as MessageV2.Part[],
      },
      {
        info: userInfo("m-ancient"),
        parts: [{ ...basePart("m-ancient", "p0"), type: "text", text: "dropped" }] as MessageV2.Part[],
      },
    ])

    expect(window.map((m) => String(m.info.id))).toEqual([boundaryID, summaryID])
  })
})
