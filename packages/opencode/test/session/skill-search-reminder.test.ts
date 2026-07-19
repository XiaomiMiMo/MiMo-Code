import { describe, expect, test } from "bun:test"
import {
  skillSearchReminder,
  skillSearchReminderForMessages,
  skillSearchReminderForSession,
} from "../../src/session/skill-search-reminder"

describe("skillSearchReminder", () => {
  test("prompts skill search on the first user query", () => {
    const reminder = skillSearchReminder({ currentUserAt: 1_000 })

    expect(reminder).toContain("<system-reminder>")
    expect(reminder).toContain("first user query")
    expect(reminder).toContain("should call skill_search")
    expect(reminder).toContain("CSV as inputs")
    expect(reminder).toContain("Office examples")
    expect(reminder).toContain("Excel/CSV")
    expect(reminder).toContain("PowerPoint/PPT")
    expect(reminder).toContain("Word/DOCX")
    expect(reminder).toContain("PDF")
    expect(reminder).toContain("Code examples")
    expect(reminder).toContain("code review")
    expect(reminder).toContain("debugging")
    expect(reminder).not.toContain("MUST")
  })

  test("describes semantic-change triggers for later queries", () => {
    const reminder = skillSearchReminder({ previousUserAt: 1_000, currentUserAt: 2_000 })

    expect(reminder).toContain("do not call skill_search")
    expect(reminder).toContain("continuation, modification, or retry")
    expect(reminder).toContain("output type")
    expect(reminder).toContain("primary action")
    expect(reminder).toContain("business object")
    expect(reminder).toContain("required capability")
  })

  test("defaults to search after two hours unless the current work is explicitly referenced", () => {
    const reminder = skillSearchReminder({ previousUserAt: 1_000, currentUserAt: 7_201_001 })

    expect(reminder).toContain("more than 2 hours")
    expect(reminder).toContain("default: call skill_search")
    expect(reminder).not.toContain("MUST")
    expect(reminder).toContain("unless the user explicitly references the current task or current artifact")
  })

  test("injects only before the current user query has an assistant response", () => {
    const user = {
      info: { role: "user", id: "user-1", time: { created: 1_000 } },
      parts: [{ type: "text", text: "Build a report" }],
    }

    expect(skillSearchReminderForMessages([user])).toContain("first user query")
    expect(
      skillSearchReminderForMessages([
        user,
        {
          info: { role: "assistant", id: "assistant-1", parentID: "user-1", time: { created: 2_000 } },
          parts: [],
        },
      ]),
    ).toBeUndefined()
  })

  test("injects into direct primary sessions but not Compose, subagent, or child sessions", () => {
    const messages = [
      {
        info: { role: "user", id: "user-1", time: { created: 1_000 } },
        parts: [{ type: "text", text: "Analyze a CSV" }],
      },
    ]

    expect(
      skillSearchReminderForSession({ session: {}, agent: { name: "build", mode: "primary" }, messages }),
    ).toContain("first user query")
    expect(
      skillSearchReminderForSession({ session: {}, agent: { name: "compose", mode: "primary" }, messages }),
    ).toBeUndefined()
    expect(
      skillSearchReminderForSession({ session: {}, agent: { name: "explore", mode: "subagent" }, messages }),
    ).toBeUndefined()
    expect(
      skillSearchReminderForSession({
        session: { parentID: "parent" },
        agent: { name: "build", mode: "primary" },
        messages,
      }),
    ).toBeUndefined()
  })
})
