import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigMarkdown } from "../../src/config"

const root = path.resolve(import.meta.dir, "../../src/skill/builtin/.bundle/mimocode-docs")

describe("mimocode-docs provider guidance", () => {
  test("routes provider requests to the dedicated reference", async () => {
    const skill = await Bun.file(path.join(root, "SKILL.md")).text()

    expect(skill).toContain("@reference/providers.md")
    expect(skill).toContain("Never recursively search the user's home directory")
    expect(skill).toContain("Don't invent config keys, model limits")
    expect(skill).toContain("research-experiment")
    expect(skill).not.toContain("SQLite FTS5 across sessions")
  })

  test("documents the implemented OpenAI-compatible adapter and safe merge rules", async () => {
    const providers = await Bun.file(path.join(root, "reference/providers.md")).text()

    expect(providers).toContain('"npm": "@ai-sdk/openai-compatible"')
    expect(providers).toContain("Do not substitute `@ai-sdk/compatible-openai`")
    expect(providers).toContain("If the endpoint matches but the supplied credential differs, create a distinct provider ID")
    expect(providers).toContain("Do not guess `limit.context`, `limit.output`")
    expect(providers).toContain("mimo models PROVIDER_ID")
  })

  test("documents native Anthropic Messages API configuration", async () => {
    const providers = await Bun.file(path.join(root, "reference/providers.md")).text()

    expect(providers).toContain('"npm": "@ai-sdk/anthropic"')
    expect(providers).toContain("the adapter appends `/messages`")
    expect(providers).toContain("not the model name")
    expect(providers).toContain("even when the upstream model ID contains `claude`")
    expect(providers).toContain("`x-api-key`, and `anthropic-version`")
  })

  test("documents the effective global config precedence", async () => {
    const providers = await Bun.file(path.join(root, "reference/providers.md")).text()

    expect(providers).toContain("`config.json`, `mimocode.json`, then `mimocode.jsonc`; later files win")
    expect(providers).toContain("create `mimocode.jsonc` when none exists")
  })

  test("keeps a newly configured API model in TUI recents without clobbering state", async () => {
    const skill = await Bun.file(path.join(root, "SKILL.md")).text()
    const config = await Bun.file(path.join(root, "reference/config.md")).text()
    const providers = await Bun.file(path.join(root, "reference/providers.md")).text()

    expect(skill).toContain("put that exact `provider/model` at the front of the TUI recent-model state")
    expect(config).toContain("TUI recent/favorite models in `model.json`")
    expect(providers).toContain("$MIMOCODE_HOME/state/model.json")
    expect(providers).toContain("Respect `XDG_STATE_HOME`")
    expect(providers).toContain("Preserve every top-level field, especially `favorite` and `variant`")
    expect(providers).toContain("remove any later entry with the same `providerID` and `modelID`")
    expect(providers).toContain("keep at most 10 entries")
    expect(providers).toContain("Write the recent state only after `mimo models PROVIDER_ID`")
    expect(providers).toContain("Never put the API key, base URL, display name, or combined `provider/model` string")
  })
})

describe("mimocode-docs TUI troubleshooting", () => {
  test("routes rendering issues to actionable terminal and SSH guidance", async () => {
    const skill = await ConfigMarkdown.parse(path.join(root, "SKILL.md"))
    const guide = await Bun.file(path.join(root, "reference/guide.md")).text()
    const commands = await Bun.file(path.join(root, "reference/commands.md")).text()

    expect(skill.data.description).toContain("terminal compatibility, rendering glitches, TUI lag, SSH or remote rendering")
    expect(skill.content).toContain("Terminal compatibility, TUI rendering or lag, and SSH remote use")
    expect(guide).toContain("does not support the built-in Terminal.app")
    expect(guide).toContain("brew install --cask iterm2")
    expect(guide).toContain("mimo serve --port 4096")
    expect(guide).toContain("ssh -N -L 4096:127.0.0.1:4096 user@remote-host")
    expect(guide).toContain("mimo attach http://127.0.0.1:4096")
    expect(guide).toContain("switch between Vivid and Minimal visuals as needed")
    expect(guide).toContain("visual-mode option in `ctrl+p`")
    expect(guide).toContain("separate animation override")
    expect(guide).not.toContain("same persisted setting")
    expect(commands).toContain("see @guide.md")
  })
})

/**
 * These docs are fed to the model AS INSTRUCTIONS, so a misclassification here
 * does not merely read wrong — it teaches the model that a valid config shape is
 * invalid. `mcp_sampling` is glob-keyed by MCP server name (the handler passes
 * `patterns: [server]`), and the page's own example uses the glob-map form, so
 * listing it as action-only contradicted the example two paragraphs below it.
 */
describe("mimocode-docs permission arity", () => {
  test("classifies mcp_sampling as glob-keyed, not action-only", async () => {
    const permissions = await Bun.file(path.join(root, "reference/permissions.md")).text()

    const globLine = permissions.split("\n").find((line) => line.startsWith("Glob-keyed"))
    const simpleLine = permissions.split("\n").find((line) => line.startsWith("Simple action-only"))
    expect(globLine).toBeDefined()
    expect(simpleLine).toBeDefined()
    expect(globLine).toContain("`mcp_sampling`")
    expect(simpleLine).not.toContain("`mcp_sampling`")
    // The glob key is a server name, not a path or a command — say so, since the
    // section is otherwise about paths and commands.
    expect(permissions).toContain("except for `mcp_sampling`, where it is the MCP server name")
    // The example that the old classification contradicted must still be present.
    expect(permissions).toContain('"mcp_sampling": { "*": "ask", "mimo-cut": "allow" }')
  })

  test("states that a permission deny outranks mcp.<server>.sampling allow", async () => {
    const permissions = await Bun.file(path.join(root, "reference/permissions.md")).text()

    expect(permissions).toContain(
      'A `deny` from either control wins: `mcp.<name>.sampling: "allow"` does **not** override `permission.mcp_sampling` denying that server.',
    )
  })
})
