import { describe, expect, test } from "bun:test"
import { TeamMessage, TeamMember, TeamInfo } from "../../src/team/schema"

describe("Team schemas", () => {
  test("TeamMessage validates correctly", () => {
    const result = TeamMessage.safeParse({
      id: "msg-1",
      from: "ses_abc",
      fromAgent: "explore",
      content: "Hello team",
      timestamp: Date.now(),
    })
    expect(result.success).toBe(true)
  })

  test("TeamMember validates correctly", () => {
    const result = TeamMember.safeParse({
      sessionID: "ses_abc",
      agent: "explore",
      role: "researcher",
      joinedAt: Date.now(),
    })
    expect(result.success).toBe(true)
  })

  test("TeamMessage with target validates correctly", () => {
    const result = TeamMessage.safeParse({
      id: "msg-2",
      from: "ses_abc",
      fromAgent: "explore",
      to: "ses_def",
      content: "Direct message",
      timestamp: Date.now(),
    })
    expect(result.success).toBe(true)
  })

  test("TeamMessage rejects invalid sessionID prefix", () => {
    const result = TeamMessage.safeParse({
      id: "msg-3",
      from: "invalid_prefix",
      fromAgent: "explore",
      content: "Hello",
      timestamp: Date.now(),
    })
    expect(result.success).toBe(false)
  })

  test("TeamMember rejects invalid sessionID prefix", () => {
    const result = TeamMember.safeParse({
      sessionID: "bad_id",
      agent: "explore",
      role: "researcher",
      joinedAt: Date.now(),
    })
    expect(result.success).toBe(false)
  })

  test("TeamInfo validates correctly", () => {
    const result = TeamInfo.safeParse({
      id: "team-alpha",
      members: [
        {
          sessionID: "ses_abc",
          agent: "explore",
          role: "researcher",
          joinedAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
      directory: "/tmp/teams/team-alpha",
    })
    expect(result.success).toBe(true)
  })
})
