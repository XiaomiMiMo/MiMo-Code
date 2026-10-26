import { describe, test, expect } from "bun:test"
import {
  hasSyntheticReminder,
  buildLoopStreakReminderText,
  buildMemoryPathsReminderText,
  memoryPathsReminderTarget,
  LOOP_STREAK_REMINDER_MARKER,
  SESSION_MEMORY_DIR_MARKER,
  COMPOSE_REMINDER_MARKER,
} from "../../src/session/prompt"
import { promoteComposeProtocolFirst } from "../../src/session/message-v2"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

function textPart(text: string, synthetic?: boolean, ignored?: boolean): MessageV2.TextPart {
  return {
    id: "p1" as PartID,
    sessionID: "ses_test" as SessionID,
    messageID: "msg_test" as MessageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    ...(ignored ? { ignored: true } : {}),
  }
}

function message(
  id: string,
  sessionID: SessionID,
  role: "user" | "assistant",
  parts: MessageV2.Part[],
  extra: { parentID?: string; summary?: boolean } = {},
) {
  return { info: { id: MessageID.make(id), sessionID, role, ...extra }, parts } as unknown as MessageV2.WithParts
}

describe("synthetic reminder markers", () => {
  test("buildLoopStreakReminderText embeds the stable marker", () => {
    const text = buildLoopStreakReminderText(3)
    expect(text).toContain(LOOP_STREAK_REMINDER_MARKER)
    expect(text).toContain("Your last 3 steps")
  })

  test("markers are distinct and non-empty", () => {
    const markers = [COMPOSE_REMINDER_MARKER, LOOP_STREAK_REMINDER_MARKER, SESSION_MEMORY_DIR_MARKER]
    expect(markers.every((m) => m.length > 0)).toBe(true)
    expect(new Set(markers).size).toBe(markers.length)
  })

  test("hasSyntheticReminder matches only non-ignored synthetic text parts", () => {
    const marker = LOOP_STREAK_REMINDER_MARKER
    expect(hasSyntheticReminder([], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(`user asked about ${marker}`)], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(marker, true)], marker)).toBe(true)
    expect(hasSyntheticReminder([textPart(marker, true, true)], marker)).toBe(false)
    expect(
      hasSyntheticReminder(
        [textPart("other synthetic", true), textPart(`<system-reminder>${marker}</system-reminder>`, true)],
        marker,
      ),
    ).toBe(true)
  })

  test("promoteComposeProtocolFirst moves compose synthetic to head after DB order", () => {
    const user = textPart("do the task")
    const compose = textPart(`\n<system-reminder>\n${COMPOSE_REMINDER_MARKER}...\n`, true)
    const other = textPart("skill body", true)
    const texts = (parts: MessageV2.Part[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    expect(texts(promoteComposeProtocolFirst([user, compose, other]))).toEqual([compose.text, user.text, other.text])
    expect(texts(promoteComposeProtocolFirst([compose, user]))).toEqual([compose.text, user.text])
    expect(texts(promoteComposeProtocolFirst([user, other]))).toEqual([user.text, other.text])
  })

  test("buildLoopStreakReminderText marker dedupes via hasSyntheticReminder", () => {
    const text = buildLoopStreakReminderText(3)
    expect(hasSyntheticReminder([textPart(text, true)], LOOP_STREAK_REMINDER_MARKER)).toBe(true)
  })
})

describe("memory paths reminder", () => {
  const sessionID = SessionID.make("ses_child")
  const parentID = SessionID.make("ses_parent")
  const dir = "/tmp/example/memory/sessions/ses_child"
  const parentDir = "/tmp/example/memory/sessions/ses_parent"
  const projectMemoryFile = "/tmp/example/memory/projects/prj_example/MEMORY.md"
  const reminderText = (sessionDir: string) => buildMemoryPathsReminderText({ projectMemoryFile, sessionDir })

  test("text carries the real project memory file, the marked session directory and both placeholders", () => {
    const text = reminderText(dir)
    expect(text).toContain(`- Project memory: ${projectMemoryFile}`)
    expect(text).toContain(`${SESSION_MEMORY_DIR_MARKER} ${dir}/`)
    expect(text).toContain("<project_id>")
    expect(text).toContain("<session_id>")
    expect(text.startsWith("<system-reminder>")).toBe(true)
  })

  test("targets the first own user message of the window", () => {
    const first = message("msg_1", sessionID, "user", [textPart("hello")])
    expect(memoryPathsReminderTarget({ msgs: [first], sessionID, dir })).toBe(first)
  })

  test("an answered first message moves the reminder to the newest unanswered user message", () => {
    // Sessions predating the reminder and fork copies: the first message was sent without it.
    const legacy = [
      message("msg_1", sessionID, "user", [textPart("hello")]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("next")]),
    ]
    expect(memoryPathsReminderTarget({ msgs: legacy, sessionID, dir })).toBe(legacy[2])
    const answered = [...legacy, message("msg_4", sessionID, "assistant", [], { parentID: "msg_3" })]
    expect(memoryPathsReminderTarget({ msgs: answered, sessionID, dir })).toBeUndefined()
  })

  test("a batched input sent before a reply counts as sent though it is never a parentID", () => {
    const msgs = [
      message("msg_1", sessionID, "user", [textPart("first of batch")]),
      message("msg_2", sessionID, "user", [textPart("second of batch")]),
      message("msg_3", sessionID, "assistant", [], { parentID: "msg_2" }),
    ]
    expect(memoryPathsReminderTarget({ msgs, sessionID, dir })).toBeUndefined()
  })

  test("never targets a contextFrom parent message", () => {
    const msgs = [message("msg_1", parentID, "user", [textPart("parent")])]
    expect(memoryPathsReminderTarget({ msgs, sessionID, dir })).toBeUndefined()
  })

  test("a checkpoint rebuild boundary is targeted even though its text names the directory", () => {
    const boundary = message("msg_5", sessionID, "user", [
      {
        ...textPart(""),
        type: "checkpoint",
        checkpointDir: "",
        checkpointNumber: 0,
        coveredUpTo: MessageID.make("msg_4"),
      } as MessageV2.Part,
      textPart(`# Session checkpoint\n\nFile: ${dir}/checkpoint.md`, true),
    ])
    expect(memoryPathsReminderTarget({ msgs: [boundary], sessionID, dir })).toBe(boundary)
  })

  test("a compaction boundary is targeted despite its summary reply", () => {
    const boundary = message("msg_5", sessionID, "user", [
      { ...textPart(""), type: "compaction", auto: true } as MessageV2.Part,
    ])
    const msgs = [
      boundary,
      message("msg_6", sessionID, "assistant", [textPart("summary")], { parentID: "msg_5", summary: true }),
      message("msg_7", sessionID, "user", [textPart("continue")]),
    ]
    expect(memoryPathsReminderTarget({ msgs, sessionID, dir })).toBe(boundary)
  })

  test("skips only when this session's reminder is already in the window", () => {
    const withReminder = [
      message("msg_1", sessionID, "user", [textPart("hi"), textPart(reminderText(dir), true)]),
      message("msg_2", sessionID, "user", [textPart("again")]),
    ]
    expect(memoryPathsReminderTarget({ msgs: withReminder, sessionID, dir })).toBeUndefined()

    const typed = message("msg_1", sessionID, "user", [textPart(reminderText(dir))])
    expect(memoryPathsReminderTarget({ msgs: [typed], sessionID, dir })).toBe(typed)
  })

  test("a fork copy showing the parent's directory gets the child's reminder on the newest message", () => {
    const forked = [
      message("msg_1", sessionID, "user", [textPart("hi"), textPart(reminderText(parentDir), true)]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("fork question")]),
    ]
    expect(memoryPathsReminderTarget({ msgs: forked, sessionID, dir })).toBe(forked[2])
  })

  test("contextFrom history without any reminder skips the parent's messages", () => {
    const own = message("msg_9", sessionID, "user", [textPart("child task")])
    const msgs = [message("msg_1", parentID, "user", [textPart("parent")]), own]
    expect(memoryPathsReminderTarget({ msgs, sessionID, dir })).toBe(own)
  })
})
