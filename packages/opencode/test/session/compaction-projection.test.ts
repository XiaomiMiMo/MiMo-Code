import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { buildFileManifest, buildSummaryMessage, buildTail, shrinkLargeToolResults } from "../../src/session/compaction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"

const sessionID = SessionID.make("ses_test")

function user(id: string, text: string): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: MessageID.make(id),
        type: "text",
        text,
      },
    ],
  }
}

function assistant(id: string, parentID: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      parentID: MessageID.make(parentID),
      time: { created: 2 },
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
      mode: "build",
      agent: "build",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  }
}

function tool(id: string, tool: string, input: Record<string, unknown>, output: string, metadata = {}) {
  return {
    id: PartID.ascending(),
    sessionID,
    messageID: MessageID.make(id),
    type: "tool",
    tool,
    callID: `call-${id}`,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata,
      time: { start: 1, end: 2 },
    },
  } satisfies MessageV2.ToolPart
}

describe("compaction projection", () => {
  test("file manifest describes read ranges and write intent without file contents", () => {
    const messages = [
      assistant("msg_read", "msg_parent", [
        tool(
          "msg_read",
          "read",
          { file_path: "/repo/src/auth/token.ts", offset: 120, limit: 141 },
          "120: secret-content\n260: final-line\n\n(Showing lines 120-260 of 500)",
          { truncated: true },
        ),
      ]),
      assistant("msg_edit", "msg_parent", [
        tool("msg_edit", "edit", { file_path: "/repo/src/auth/token.ts", old_string: "a", new_string: "b" }, "ok"),
      ]),
      assistant("msg_write", "msg_parent", [
        tool("msg_write", "write", { file_path: "/repo/tests/auth.test.ts" }, "ok", { exists: false }),
        {
          id: PartID.ascending(),
          sessionID,
          messageID: MessageID.make("msg_write"),
          type: "patch",
          hash: "hash",
          files: ["/repo/tests/auth.test.ts"],
        },
      ]),
    ]

    const manifest = buildFileManifest(messages, { worktree: "/repo" })!
    expect(manifest).toContain("## Attachments")
    expect(manifest).toContain("<files-touched>")
    expect(manifest).toContain("src/auth/token.ts (read: lines 120-260, then edited)")
    expect(manifest).toContain("tests/auth.test.ts (written)")
    expect(manifest).not.toContain("tests/auth.test.ts (written, then edited)")
    expect(manifest).toContain("re-read any file you need before editing it")
    expect(manifest).not.toContain("secret-content")
  })

  test("tail keeps newest whole rounds and never cuts a round in half", async () => {
    const oldUser = user("msg_old_user", "x".repeat(4_000))
    const oldAssistant = assistant("msg_old_assistant", "msg_old_user", [])
    const newUser = user("msg_new_user", "new")
    const newAssistant = assistant("msg_new_assistant", "msg_new_user", [])
    const text = newUser.parts.find((part): part is MessageV2.TextPart => part.type === "text")!
    text.metadata = { internal_only: "x".repeat(4_000) }
    const tail = await Effect.runPromise(
      buildTail({
        messages: [oldUser, oldAssistant, newUser, newAssistant],
        model: ProviderTest.model(),
        budget: 300,
      }),
    )

    expect(tail.map((message) => message.info.id)).toEqual([newUser.info.id, newAssistant.info.id])
    expect(JSON.stringify([newUser, newAssistant]).length).toBeGreaterThan(4_000)
  })

  test("large tool results become metadata-rich placeholders", () => {
    const message = assistant("msg_tool", "msg_parent", [
      tool("msg_tool", "read", { file_path: "/repo/large.log" }, "x".repeat(40_000)),
    ])
    const shrunk = shrinkLargeToolResults([message])[0].parts[0]
    expect(shrunk.type).toBe("tool")
    if (shrunk.type !== "tool" || shrunk.state.status !== "completed") return
    expect(shrunk.state.output).toContain("Tool result omitted during compaction: 10000 tokens")
    expect(shrunk.state.output).toContain('Re-run "read"')
    expect(shrunk.state.metadata.compaction_tail_shrunk_tokens).toBe(10_000)
  })

  test("summary wrapper records trigger and tail presence without an unreadable transcript path", () => {
    const message = buildSummaryMessage("## Goal\nShip it", "provider-overflow", true)
    expect(message).toContain('trigger="provider-overflow"')
    expect(message).toContain("Complete API rounds")
    expect(message).toContain("## Goal")
    expect(message).not.toContain("transcript-path")
    expect(message).not.toContain("mimocode.db")
  })
})
