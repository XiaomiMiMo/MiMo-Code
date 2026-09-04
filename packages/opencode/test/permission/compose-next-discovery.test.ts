import { test, expect } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"

// Mirrors the ruleset actually built in agent.ts for the default agent's skill
// permission, so we test the exact rule shape that ships. Compose agent adds
// `compose:*: allow` on top of these defaults.
function defaultAgentSkillRules() {
  return Permission.fromConfig({
    "*": "allow",
    doom_loop: "ask",
    skill: {
      "*": "allow",
      "compose:*": "deny",
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

// Compose Next discovery evolved in three steps. It was first hidden by an
// exact permission deny, but that also broke the user's own /compose-next
// invocation because permission means authorization for every caller. The
// generic disable-model-invocation frontmatter field then separated model
// reachability from user slash invocation. Compose Next has now graduated from
// that opt-out: it stays permission-allowed and omits the field, so models can
// discover and invoke it. Its description and body still require explicit user
// authorization for the workflow, including clear natural-language requests.
test("default agent allows compose-next for user and model invocation", () => {
  const rule = Permission.evaluate("skill", "compose-next", defaultAgentSkillRules())
  expect(rule.action).toBe("allow")
})

test("compose-next allows model invocation by omitting the opt-out frontmatter", async () => {
  const skill = await Bun.file(
    path.join(import.meta.dir, "../../src/skill/builtin/.bundle/compose-next/SKILL.md"),
  ).text()
  expect(skill).not.toContain("disable-model-invocation")
})

test("default agent still denies legacy compose:* skills", () => {
  const rule = Permission.evaluate("skill", "compose:plan", defaultAgentSkillRules())
  expect(rule.action).toBe("deny")
})

test("default agent allows an ordinary skill", () => {
  const rule = Permission.evaluate("skill", "deep-research", defaultAgentSkillRules())
  expect(rule.action).toBe("allow")
})

test("compose agent allows compose:* skills through its override", () => {
  const rule = Permission.evaluate("skill", "compose:plan", composeAgentSkillRules())
  expect(rule.action).toBe("allow")
})

test("compose:* pattern does not shadow ordinary skills starting with compose", () => {
  // Sanity: a user could hypothetically install a skill literally named
  // "compose" (no colon, no dash). It must not be denied by the compose:*
  // pattern.
  const rule = Permission.evaluate("skill", "compose", defaultAgentSkillRules())
  expect(rule.action).toBe("allow")
})
