import { describe, test, expect } from "bun:test"
import {
  recallHintLines,
  hasSyntheticReminder,
  buildRecallReminderText,
  buildLoopStreakReminderText,
  RECALL_REMINDER_MARKER,
  LOOP_STREAK_REMINDER_MARKER,
  COMPOSE_REMINDER_MARKER,
} from "../../src/session/prompt"
import { promoteComposeProtocolFirst } from "../../src/session/message-v2"
import { hasActorTool } from "../../src/agent/config"
import type { MessageV2 } from "../../src/session/message-v2"
import type { PartID, SessionID, MessageID } from "../../src/session/schema"

describe("recallHintLines", () => {
  test("json mode (no tool config): task and actor use JSON form", () => {
    const lines = recallHintLines(undefined)
    expect(lines).toContain(`- task({ operation: "list" })`)
    expect(lines).toContain(`- actor({ operation: "status", actor_id: "<id>" })`)
    expect(lines.some((l) => l.includes(`memory({ operation: "search"`))).toBe(true)
  })

  test("shell mode for task+actor: shell forms, no JSON for those tools", () => {
    const lines = recallHintLines({ invocation_style: "shell" })
    expect(lines).toContain("- task list")
    expect(lines).toContain("- actor status <actor_id>")
    expect(lines.some((l) => l.includes(`task({ operation`))).toBe(false)
    expect(lines.some((l) => l.includes(`actor({ operation`))).toBe(false)
    expect(lines.some((l) => l.includes(`memory({ operation: "search"`))).toBe(true)
  })

  test("per-tool: task shell, actor json", () => {
    const lines = recallHintLines({ invocation_style_by_tool: { task: "shell" } })
    expect(lines).toContain("- task list")
    expect(lines).toContain(`- actor({ operation: "status", actor_id: "<id>" })`)
  })

  // hints[0]=memory is the only position the reminder body depends on (it spreads
  // the rest), so this guards that slot plus the default-argument shape.
  test("returned order is [memory, task, actor]", () => {
    const lines = recallHintLines({ invocation_style: "shell" })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("memory(")
    expect(lines[1]).toBe("- task list")
    expect(lines[2]).toBe("- actor status <actor_id>")
  })

  test("drops the actor hint when the tool is masked out for the agent", () => {
    const lines = recallHintLines({ invocation_style: "shell" }, false)
    expect(lines).toEqual([`- memory({ operation: "search", query: "<keyword>" })`, "- task list"])
  })
})

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

describe("synthetic reminder markers", () => {
  test("buildRecallReminderText embeds the stable marker and memory path", () => {
    const text = buildRecallReminderText({
      sessMemDir: "/tmp/example/memory/sessions/ses_test",
      hints: [`- memory({ operation: "search", query: "<keyword>" })`, "- task list"],
    })
    expect(text).toContain(RECALL_REMINDER_MARKER)
    expect(text).toContain("/tmp/example/memory/sessions/ses_test/")
    expect(text).toContain("Don't ask the user about something memory may already record.")
  })

  test("buildLoopStreakReminderText embeds the stable marker", () => {
    const text = buildLoopStreakReminderText(3)
    expect(text).toContain(LOOP_STREAK_REMINDER_MARKER)
    expect(text).toContain("Your last 3 steps")
  })

  test("compose marker is distinct and non-empty", () => {
    expect(COMPOSE_REMINDER_MARKER.length).toBeGreaterThan(0)
    expect(COMPOSE_REMINDER_MARKER).not.toBe(RECALL_REMINDER_MARKER)
    expect(COMPOSE_REMINDER_MARKER).not.toBe(LOOP_STREAK_REMINDER_MARKER)
  })

  test("hasSyntheticReminder matches only non-ignored synthetic text parts", () => {
    const marker = RECALL_REMINDER_MARKER
    expect(hasSyntheticReminder([], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(`user asked about ${marker}`)], marker)).toBe(false)
    expect(hasSyntheticReminder([textPart(marker, true)], marker)).toBe(true)
    expect(hasSyntheticReminder([textPart(marker, true, true)], marker)).toBe(false)
    expect(
      hasSyntheticReminder(
        [
          textPart("other synthetic", true),
          textPart(`<system-reminder>${marker} /x/</system-reminder>`, true),
        ],
        marker,
      ),
    ).toBe(true)
  })

  test("promoteComposeProtocolFirst moves compose synthetic to head after DB order", () => {
    const user = textPart("do the task")
    const compose = textPart(`\n<system-reminder>\n${COMPOSE_REMINDER_MARKER}...\n`, true)
    const other = textPart("skill body", true)
    const texts = (parts: MessageV2.Part[]) =>
      parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
    expect(texts(promoteComposeProtocolFirst([user, compose, other]))).toEqual([
      compose.text,
      user.text,
      other.text,
    ])
    expect(texts(promoteComposeProtocolFirst([compose, user]))).toEqual([compose.text, user.text])
    expect(texts(promoteComposeProtocolFirst([user, other]))).toEqual([user.text, other.text])
  })

  test("buildLoopStreakReminderText marker dedupes via hasSyntheticReminder", () => {
    const text = buildLoopStreakReminderText(3)
    expect(hasSyntheticReminder([textPart(text, true)], LOOP_STREAK_REMINDER_MARKER)).toBe(true)
  })
})

// The reminder names `actor`, so it must read the same gate ToolRegistry.available
// uses to mask the tool out — otherwise a subagent is told to call a tool it has
// no schema for.
describe("hasActorTool", () => {
  test("primaries and system-spawned agents keep it, other subagents don't", () => {
    expect(hasActorTool({ name: "build", mode: "primary" })).toBe(true)
    expect(hasActorTool({ name: "helper", mode: "all" })).toBe(true)
    expect(hasActorTool({ name: "checkpoint-writer", mode: "subagent" })).toBe(true)
    expect(hasActorTool({ name: "general", mode: "subagent" })).toBe(false)
    expect(hasActorTool({ name: "explore", mode: "subagent" })).toBe(false)
  })

  // dream/distill are system-spawned, so the mode gate exempts them, but their
  // toolAllowlist omits `actor` — the schema is what the reminder must follow.
  test("an allowlist without actor wins over the system-spawned exemption", () => {
    expect(hasActorTool({ name: "distill", mode: "subagent", toolAllowlist: ["read", "memory"] })).toBe(false)
    expect(hasActorTool({ name: "build", mode: "primary", toolAllowlist: ["read"] })).toBe(false)
  })

  // Agent.Service.get is typed `Info` but returns agents[name], absent for a name
  // no longer in config. The reminder must degrade, not throw, in a runLoop turn.
  test("an unresolvable agent keeps the hint instead of throwing", () => {
    expect(hasActorTool(undefined)).toBe(true)
  })
})
