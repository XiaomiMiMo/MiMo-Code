import { describe, expect, test } from "bun:test"
import { agentListItem } from "../../src/server/routes/instance"
import { Permission } from "../../src/permission"
import type { Agent } from "../../src/agent/agent"

describe("agent list route", () => {
  test("omits system prompts from list payloads", () => {
    const agent: Agent.Info = {
      name: "explore",
      description: "Explore files",
      mode: "subagent",
      native: true,
      prompt: "large system prompt",
      permission: Permission.fromConfig({ "*": "allow" }),
      options: {},
    }

    const result = agentListItem(agent)

    expect(result.name).toBe("explore")
    expect(result.mode).toBe("subagent")
    expect(result.permission).toEqual(agent.permission)
    expect("prompt" in result).toBe(false)
    expect(agent.prompt).toBe("large system prompt")
  })
})
