import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { serializeTrajectoryMessages } from "../../src/session/trajectory"

describe("serializeTrajectoryMessages", () => {
  test("preserves all fields for replay (synthetic reminders, tool state, reasoning, IDs, timing, metadata)", () => {
    const sessionID = SessionID.make("ses_test")
    const userID = MessageID.make("msg_user")
    const asstID = MessageID.make("msg_asst")
    const msgs: MessageV2.WithParts[] = [
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          agent: "build",
          model: { providerID: "alibaba" as any, modelID: "qwen" as any },
          time: { created: 1 },
        },
        parts: [
          {
            id: PartID.make("part_1"),
            messageID: userID,
            sessionID,
            type: "text",
            text: "fix the bug",
          },
          {
            id: PartID.make("part_2"),
            messageID: userID,
            sessionID,
            type: "text",
            synthetic: true,
            text: "<system-reminder>recall memory</system-reminder>",
          },
        ],
      },
      {
        info: {
          id: asstID,
          sessionID,
          role: "assistant",
          parentID: userID,
          agent: "build",
          mode: "build",
          modelID: "qwen" as any,
          providerID: "alibaba" as any,
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0.0123,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2, completed: 3 },
          finish: "tool-calls",
        },
        parts: [
          {
            id: PartID.make("part_3"),
            messageID: asstID,
            sessionID,
            type: "reasoning",
            text: "I'll read the file first",
            time: { start: 2 },
          },
          {
            id: PartID.make("part_4"),
            messageID: asstID,
            sessionID,
            type: "tool",
            tool: "read",
            callID: "call_1",
            state: {
              status: "completed",
              input: { file_path: "src/a.ts" },
              output: "export const x = 1",
              title: "Read src/a.ts",
              metadata: { lines: 1 },
              time: { start: 2, end: 3 },
            },
          },
        ],
      },
    ]

    const out = serializeTrajectoryMessages(msgs)
    expect(out).toHaveLength(2)

    // User message: full info preserved + parts.
    expect(out[0]).toMatchObject({
      role: "user",
      id: userID,
      sessionID,
      agent: "build",
      model: { providerID: "alibaba", modelID: "qwen" },
      created: 1,
      time: { created: 1 },
    })
    expect(out[0]?.parts).toHaveLength(2)
    expect(out[0]?.parts[0]).toMatchObject({
      type: "text",
      id: "part_1",
      sessionID,
      messageID: userID,
      text: "fix the bug",
    })
    expect(out[0]?.parts[1]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "<system-reminder>recall memory</system-reminder>",
    })

    // Assistant message: tokens, cost, modelID, providerID, path, parentID all preserved.
    expect(out[1]).toMatchObject({
      role: "assistant",
      id: asstID,
      parentID: userID,
      modelID: "qwen",
      providerID: "alibaba",
      cost: 0.0123,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      path: { cwd: "/tmp", root: "/tmp" },
      finish: "tool-calls",
      created: 2,
      time: { created: 2, completed: 3 },
    })

    // Reasoning part: id + time + text preserved.
    expect(out[1]?.parts[0]).toMatchObject({
      type: "reasoning",
      id: "part_3",
      text: "I'll read the file first",
      time: { start: 2 },
    })

    // Tool part: nested state preserved (status, input, output, title, metadata, time).
    expect(out[1]?.parts[1]).toMatchObject({
      type: "tool",
      id: "part_4",
      tool: "read",
      callID: "call_1",
      state: {
        status: "completed",
        input: { file_path: "src/a.ts" },
        output: "export const x = 1",
        title: "Read src/a.ts",
        metadata: { lines: 1 },
        time: { start: 2, end: 3 },
      },
    })
  })

  test("summarizes data: URLs in file parts and tool attachments without dropping fields", () => {
    const sessionID = SessionID.make("ses_test2")
    const userID = MessageID.make("msg_user2")
    const asstID = MessageID.make("msg_asst2")
    const msgs: MessageV2.WithParts[] = [
      {
        info: {
          id: userID,
          sessionID,
          role: "user",
          agent: "build",
          model: { providerID: "alibaba" as any, modelID: "qwen" as any },
          time: { created: 1 },
        },
        parts: [
          {
            id: PartID.make("part_f"),
            messageID: userID,
            sessionID,
            type: "file",
            mime: "image/png",
            filename: "shot.png",
            url: "data:image/png;base64,AAAAAAAAAAA",
            source: { type: "file", path: "/tmp/shot.png", text: { value: "shot.png", start: 0, end: 8 } },
          },
        ],
      },
      {
        info: {
          id: asstID,
          sessionID,
          role: "assistant",
          parentID: userID,
          agent: "build",
          mode: "build",
          modelID: "qwen" as any,
          providerID: "alibaba" as any,
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        },
        parts: [
          {
            id: PartID.make("part_t"),
            messageID: asstID,
            sessionID,
            type: "tool",
            tool: "screenshot",
            callID: "call_s",
            state: {
              status: "completed",
              input: {},
              output: "see attachment",
              title: "screenshot",
              metadata: {},
              time: { start: 2, end: 3 },
              attachments: [
                {
                  id: PartID.make("part_att"),
                  messageID: asstID,
                  sessionID,
                  type: "file",
                  mime: "image/png",
                  url: "data:image/png;base64,BBBBBBBBBBB",
                },
              ],
            },
          },
        ],
      },
    ]

    const out = serializeTrajectoryMessages(msgs)
    expect(out[0]?.parts[0]).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      url: "[data-url:image/png:shot.png]",
      source: { type: "file", path: "/tmp/shot.png" },
    })
    const toolPart = out[1]?.parts[0] as any
    expect(toolPart.state.attachments[0].url).toBe("[data-url:image/png]")
    expect(toolPart.state.attachments[0].mime).toBe("image/png")
  })
})
