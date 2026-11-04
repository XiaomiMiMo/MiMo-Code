import { describe, test, expect } from "bun:test"
import {
  buildLoopStreakReminderText,
  buildMemoryPathsReminderText,
  buildSessionEnvReminderText,
  LOOP_STREAK_REMINDER_MARKER,
  SESSION_MEMORY_DIR_MARKER,
  COMPOSE_REMINDER_MARKER,
} from "../../src/session/prompt"
import { SessionReminder } from "../../src/session/reminder"
import { promoteComposeProtocolFirst } from "../../src/session/message-v2"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

function textPart(
  text: string,
  synthetic?: boolean,
  ignored?: boolean,
  metadata?: Record<string, unknown>,
): MessageV2.TextPart {
  return {
    id: "p1" as PartID,
    sessionID: "ses_test" as SessionID,
    messageID: "msg_test" as MessageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    ...(ignored ? { ignored: true } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function tagged(reminder: unknown, text = "<system-reminder>body</system-reminder>") {
  return textPart(text, true, false, { [SessionReminder.METADATA_KEY]: reminder })
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

describe("synthetic reminder text", () => {
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

  test("promoteComposeProtocolFirst moves compose synthetic to head after DB order", () => {
    const user = textPart("do the task")
    const compose = textPart(`\n<system-reminder>\n${COMPOSE_REMINDER_MARKER}...\n`, true)
    const other = textPart("skill body", true)
    const texts = (parts: MessageV2.Part[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    expect(texts(promoteComposeProtocolFirst([user, compose, other]))).toEqual([compose.text, user.text, other.text])
    expect(texts(promoteComposeProtocolFirst([compose, user]))).toEqual([compose.text, user.text])
    expect(texts(promoteComposeProtocolFirst([user, other]))).toEqual([user.text, other.text])
  })

  test("session environment reminder names the session directory, git root and platform", () => {
    const text = buildSessionEnvReminderText({ directory: "/tmp/example/app", gitRoot: "/tmp/example", platform: "linux" })
    expect(text.startsWith("<system-reminder>")).toBe(true)
    expect(text).toContain("- Session directory: /tmp/example/app")
    expect(text).toContain("- Git repository root: /tmp/example")
    expect(text).toContain("- Platform: linux")
    expect(text).not.toContain("Workspace")
    expect(text).not.toContain("Shell")
  })

  test("session environment reminder outside git names no root", () => {
    const text = buildSessionEnvReminderText({ directory: "/tmp/example", platform: "linux" })
    expect(text).toContain("- Not inside a git repository")
    expect(text).not.toContain("root")
  })
})

describe("SessionReminder.tag", () => {
  test("reads key and optional rev from a synthetic text part", () => {
    expect(SessionReminder.tag(tagged({ key: "session-env", rev: "/tmp/example" }))).toEqual({
      key: "session-env",
      rev: "/tmp/example",
    })
    expect(SessionReminder.tag(tagged({ key: "loop-streak" }))).toEqual({ key: "loop-streak" })
    expect(SessionReminder.tag(tagged({ key: "loop-streak", rev: null }))).toEqual({ key: "loop-streak" })
  })

  test("ignores non-synthetic, ignored and malformed parts", () => {
    const meta = { [SessionReminder.METADATA_KEY]: { key: "session-env" } }
    expect(SessionReminder.tag(textPart("typed", false, false, meta))).toBeUndefined()
    expect(SessionReminder.tag(textPart("hidden", true, true, meta))).toBeUndefined()
    expect(SessionReminder.tag(textPart("plain", true))).toBeUndefined()
    expect(SessionReminder.tag(tagged("session-env"))).toBeUndefined()
    expect(SessionReminder.tag(tagged({ key: "" }))).toBeUndefined()
    expect(SessionReminder.tag(tagged({ key: 1 }))).toBeUndefined()
    expect(SessionReminder.tag(tagged({ key: "session-env", rev: 1 }))).toBeUndefined()
  })
})

describe("SessionReminder.has", () => {
  test("matches key and rev, never text", () => {
    const parts = [textPart("hi"), tagged({ key: "session-env", rev: "/tmp/example" })]
    expect(SessionReminder.has(parts, { key: "session-env", rev: "/tmp/example" })).toBe(true)
    expect(SessionReminder.has(parts, { key: "session-env", rev: "/tmp/other" })).toBe(false)
    expect(SessionReminder.has(parts, { key: "session-env" })).toBe(false)
    expect(SessionReminder.has(parts, { key: "memory-paths", rev: "/tmp/example" })).toBe(false)
    expect(SessionReminder.has([textPart(buildLoopStreakReminderText(3), true)], { key: "loop-streak" })).toBe(false)
    expect(SessionReminder.has([tagged({ key: "loop-streak" })], { key: "loop-streak" })).toBe(true)
  })
})

describe("SessionReminder.windowTarget", () => {
  const sessionID = SessionID.make("ses_child")
  const parentID = SessionID.make("ses_parent")
  const dir = "/tmp/example/memory/sessions/ses_child"
  const parentDir = "/tmp/example/memory/sessions/ses_parent"
  const reminder = { key: "memory-paths", rev: dir }
  const target = (msgs: MessageV2.WithParts[]) => SessionReminder.windowTarget({ msgs, sessionID, reminder })

  test("memory paths text carries the real project memory file, the session directory and both placeholders", () => {
    const projectMemoryFile = "/tmp/example/memory/projects/prj_example/MEMORY.md"
    const text = buildMemoryPathsReminderText({ projectMemoryFile, sessionDir: dir })
    expect(text).toContain(`- Project memory: ${projectMemoryFile}`)
    expect(text).toContain(`${SESSION_MEMORY_DIR_MARKER} ${dir}/`)
    expect(text).toContain("<project_id>")
    expect(text).toContain("<session_id>")
    expect(text.startsWith("<system-reminder>")).toBe(true)
  })

  test("targets the first own user message of the window", () => {
    const first = message("msg_1", sessionID, "user", [textPart("hello")])
    expect(target([first])).toBe(first)
  })

  test("an answered first message moves the reminder to the newest unanswered user message", () => {
    // Sessions predating the reminder and fork copies: the first message was sent without it.
    const legacy = [
      message("msg_1", sessionID, "user", [textPart("hello")]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("next")]),
    ]
    expect(target(legacy)).toBe(legacy[2])
    const answered = [...legacy, message("msg_4", sessionID, "assistant", [], { parentID: "msg_3" })]
    expect(target(answered)).toBeUndefined()
  })

  test("a batched input sent before a reply counts as sent though it is never a parentID", () => {
    const msgs = [
      message("msg_1", sessionID, "user", [textPart("first of batch")]),
      message("msg_2", sessionID, "user", [textPart("second of batch")]),
      message("msg_3", sessionID, "assistant", [], { parentID: "msg_2" }),
    ]
    expect(target(msgs)).toBeUndefined()
  })

  test("never targets a contextFrom parent message", () => {
    expect(target([message("msg_1", parentID, "user", [textPart("parent")])])).toBeUndefined()
  })

  test("a checkpoint rebuild boundary is targeted", () => {
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
    expect(target([boundary])).toBe(boundary)
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
    expect(target(msgs)).toBe(boundary)
  })

  test("skips only when this session's tagged reminder is already in the window", () => {
    const withReminder = [
      message("msg_1", sessionID, "user", [textPart("hi"), tagged(reminder)]),
      message("msg_2", sessionID, "user", [textPart("again")]),
    ]
    expect(target(withReminder)).toBeUndefined()

    // Identity is the tag, so an untagged copy of the text does not count.
    const untagged = message("msg_1", sessionID, "user", [
      textPart(buildMemoryPathsReminderText({ projectMemoryFile: "/tmp/example/MEMORY.md", sessionDir: dir }), true),
    ])
    expect(target([untagged])).toBe(untagged)
  })

  test("a fork copy tagged with the parent's rev gets the child's reminder on the newest message", () => {
    const forked = [
      message("msg_1", sessionID, "user", [textPart("hi"), tagged({ key: "memory-paths", rev: parentDir })]),
      message("msg_2", sessionID, "assistant", [], { parentID: "msg_1" }),
      message("msg_3", sessionID, "user", [textPart("fork question")]),
    ]
    expect(target(forked)).toBe(forked[2])
  })

  test("contextFrom history without any reminder skips the parent's messages", () => {
    const own = message("msg_9", sessionID, "user", [textPart("child task")])
    expect(target([message("msg_1", parentID, "user", [textPart("parent")]), own])).toBe(own)
  })
})
