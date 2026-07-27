import { test, expect } from "bun:test"
import { enforcePermissions } from "./enforce"
enforcePermissions()
import { Permission } from "../../src/permission"

// Mirrors the ruleset actually built in agent.ts for the default agent's skill
// permission, so we test the exact rule shape that ships. Compose agent adds
// `compose:*: allow` on top of these defaults; nothing overrides compose-next.
function defaultAgentSkillRules() {
  return Permission.fromConfig({
    "*": "allow",
    doom_loop: "ask",
    skill: {
      "*": "allow",
      "compose:*": "deny",
      "compose-next": "deny",
    },
  })
}

function composeAgentSkillRules() {
  return Permission.merge(
    defaultAgentSkillRules(),
    Permission.fromConfig({
      skill: { "compose:*": "allow" },
    }),
  )
}

test("default agent denies compose-next skill", () => {
  const rule = Permission.evaluate("skill", "compose-next", defaultAgentSkillRules())
  expect(rule.action).toBe("deny")
})

test("default agent still denies legacy compose:* skills", () => {
  const rule = Permission.evaluate("skill", "compose:plan", defaultAgentSkillRules())
  expect(rule.action).toBe("deny")
})

test("default agent allows an ordinary skill", () => {
  const rule = Permission.evaluate("skill", "deep-research", defaultAgentSkillRules())
  expect(rule.action).toBe("allow")
})

test("compose agent still denies compose-next (not a compose-mode internal)", () => {
  const rule = Permission.evaluate("skill", "compose-next", composeAgentSkillRules())
  expect(rule.action).toBe("deny")
})

test("compose agent allows compose:* skills through its override", () => {
  const rule = Permission.evaluate("skill", "compose:plan", composeAgentSkillRules())
  expect(rule.action).toBe("allow")
})

test("exact compose-next deny does not shadow ordinary skills starting with compose", () => {
  // Sanity: a user could hypothetically install a skill literally named
  // "compose" (no colon, no dash). It must not be denied by our compose-next
  // exact rule or the compose:* pattern.
  const rule = Permission.evaluate("skill", "compose", defaultAgentSkillRules())
  expect(rule.action).toBe("allow")
})
