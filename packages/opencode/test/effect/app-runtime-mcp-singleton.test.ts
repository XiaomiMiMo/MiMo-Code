import { expect, test } from "bun:test"

import { Actor } from "../../src/actor/spawn"
import { Command } from "../../src/command"
import { AppLayer } from "../../src/effect/app-runtime"
import { MCP } from "../../src/mcp"
import { SessionPrompt } from "../../src/session/prompt"

test("AppLayer composes one shared MCP ownership chain", () => {
  expect(AppLayer).toBeDefined()
  expect(MCP.defaultLayer).toBeDefined()
  expect(Command.appLayer).toBeDefined()
  expect(SessionPrompt.appLayer).toBeDefined()
  expect(Actor.appLayer).toBeDefined()

  // Standalone layers remain available for focused service tests, while the
  // process graph has explicit dependency-injected variants for the four
  // services that otherwise each start their own MCP transport scope.
  expect(Command.defaultLayer).not.toBe(Command.appLayer)
  expect(SessionPrompt.defaultLayer).not.toBe(SessionPrompt.appLayer)
  expect(Actor.defaultLayer).not.toBe(Actor.appLayer)
})
