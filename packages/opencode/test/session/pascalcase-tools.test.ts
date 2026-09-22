import path from "node:path"
import { afterEach, beforeEach, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { textStopResponse, toolCallResponse, toolCallsResponse } from "../lib/scripted-llm-server"

const originalFlag = process.env.MIMOCODE_PASCAL_CASE_TOOLS
beforeEach(() => {
  delete process.env.MIMOCODE_PASCAL_CASE_TOOLS
})
afterEach(() => {
  if (originalFlag == null) delete process.env.MIMOCODE_PASCAL_CASE_TOOLS
  else process.env.MIMOCODE_PASCAL_CASE_TOOLS = originalFlag
})

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Bus.defaultLayer,
    Permission.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

type Request = {
  tools: { function: { name: string; description: string } }[]
  messages: {
    role: string
    content: unknown
    tool_calls?: { id: string; function: { name: string; arguments: string } }[]
    tool_call_id?: string
  }[]
}

function server(responses: string[][]) {
  return Effect.gen(function* () {
    const captures: Request[] = []
    const http = Bun.serve({
      port: 0,
      async fetch(request) {
        captures.push((await request.json()) as Request)
        return new Response((responses[captures.length - 1] ?? textStopResponse("Finished")).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => http.stop(true)))
    return { captures, origin: http.url.origin }
  })
}

function config(
  origin: string,
  permission: Config.Info["permission"] = { edit: "allow" },
  apiID = "mimo-v2.6-pro",
): Config.Info {
  return {
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          model: {
            id: apiID,
            name: "Test",
            tool_call: true,
            limit: { context: 32000, output: 2000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission,
    lsp: false,
    formatter: false,
  }
}

it.live(
  "default PascalCase schemas execute canonical tools and replay canonical history with model names",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([
        toolCallResponse({
          id: "write-example",
          name: "Write",
          args: JSON.stringify({ file_path: "example.txt", content: "example content" }),
        }),
        toolCallResponse({ id: "read-example", name: "Read", args: JSON.stringify({ file_path: "example.txt" }) }),
        textStopResponse("Finished"),
        textStopResponse("Remembered"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Tool naming roundtrip" })
            const events: string[] = []
            const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
              if (event.properties.part.sessionID === session.id && event.properties.part.type === "tool")
                events.push(event.properties.part.tool)
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "default",
              parts: [{ type: "text", text: "Write and read the example file" }],
            })
            const system = JSON.stringify(stub.captures[0].messages.filter((message) => message.role === "system"))
            expect(system).toContain("You may edit MEMORY.md when:")
            expect(system).toContain("the Grep and Read tools")
            expect(stub.captures[0].tools.map((tool) => tool.function.name)).toContain("Write")
            expect(stub.captures[0].tools.map((tool) => tool.function.name)).toContain("Read")
            expect(stub.captures[0].tools.map((tool) => tool.function.name)).not.toContain("write")
            expect(stub.captures[0].tools.map((tool) => tool.function.name)).not.toContain("read")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "example.txt")).text())).toBe("example content")
            const parts = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(parts.map((part) => [part.tool, part.state.status])).toEqual([
              ["write", "completed"],
              ["read", "completed"],
            ])
            expect(parts[1].state.status === "completed" && parts[1].state.output).toContain("example content")
            expect(new Set(events)).toEqual(new Set(["write", "read"]))
            yield* prompt.prompt({
              sessionID: session.id,
              parts: [{ type: "text", text: "Recall the file contents" }],
            })
            expect(stub.captures).toHaveLength(4)
            for (const request of [stub.captures[2], stub.captures[3]]) {
              expect(
                request.messages
                  .flatMap((message) => message.tool_calls ?? [])
                  .map((call) => [call.id, call.function.name]),
              ).toEqual([
                ["write-example", "Write"],
                ["read-example", "Read"],
              ])
              expect(
                request.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
              ).toEqual(["write-example", "read-example"])
            }
          }),
        { git: true, config: config(stub.origin) },
      )
    }),
  30000,
)

it.live(
  "canonical edit denial removes PascalCase write and edit schemas and prevents writes",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([
        toolCallResponse({
          id: "denied-write",
          name: "Write",
          args: JSON.stringify({ file_path: "denied.txt", content: "must not write" }),
        }),
        textStopResponse("Finished"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Canonical permission filtering" })
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "default",
              parts: [{ type: "text", text: "Try to write the file" }],
            })
            const names = stub.captures[0].tools.map((tool) => tool.function.name)
            expect(names).toContain("Read")
            expect(names).not.toContain("Write")
            expect(names).not.toContain("Edit")
            expect(names).not.toContain("write")
            expect(names).not.toContain("edit")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "denied.txt")).exists())).toBe(false)
          }),
        { git: true, config: config(stub.origin, { edit: "deny" }) },
      )
    }),
  30000,
)

it.live(
  "PascalCase calls ask for canonical edit permission before executing",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([
        toolCallResponse({
          id: "ask-write",
          name: "Write",
          args: JSON.stringify({ file_path: "approved.txt", content: "approved" }),
        }),
        textStopResponse("Finished"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const permission = yield* Permission.Service
            const bus = yield* Bus.Service
            const session = yield* sessions.create({ title: "Canonical permission request" })
            const asked = yield* Deferred.make<Permission.Request>()
            const unsubscribe = yield* bus.subscribeCallback(Permission.Event.Asked, (event) => {
              if (event.properties.sessionID === session.id)
                Deferred.doneUnsafe(asked, Effect.succeed(event.properties))
            })
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
            yield* Effect.addFinalizer(() => prompt.cancel(session.id))
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                harness: "default",
                parts: [{ type: "text", text: "Write the example after approval" }],
              })
              .pipe(Effect.forkChild)
            const request = yield* Deferred.await(asked).pipe(Effect.timeout("10 seconds"))
            expect(request.permission).toBe("edit")
            expect(request.tool?.callID).toBe("ask-write")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "approved.txt")).exists())).toBe(false)
            yield* permission.reply({ requestID: request.id, reply: "once" })
            yield* Fiber.join(running)
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "approved.txt")).text())).toBe("approved")
            expect(
              (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
                .map((part) => [part.tool, part.state.status]),
            ).toEqual([["write", "completed"]])
          }),
        { git: true, config: config(stub.origin, { edit: "ask" }) },
      )
    }),
  30000,
)

it.live(
  "undeclared mixed casing cannot invoke a builtin executor",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([
        toolCallResponse({
          id: "mixed-write",
          name: "wRiTe",
          args: JSON.stringify({ file_path: "mixed.txt", content: "must not write" }),
        }),
        textStopResponse("Finished"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Exact model tool lookup" })
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "default",
              parts: [{ type: "text", text: "Attempt an undeclared spelling" }],
            })
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "mixed.txt")).exists())).toBe(false)
            const parts = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(parts).toHaveLength(1)
            expect(parts[0].tool).not.toBe("write")
            expect(stub.captures).toHaveLength(2)
            const available = `Available tools: ${stub.captures[0].tools.map((tool) => tool.function.name).join(", ")}.`
            expect(parts[0].state).toMatchObject({ status: "error", error: expect.stringContaining(available) })
            expect(JSON.stringify(stub.captures[1].messages.filter((message) => message.role === "tool"))).toContain(available)
          }),
        { git: true, config: config(stub.origin) },
      )
    }),
  30000,
)

it.live(
  "Codex schemas, execution and nested tool names retain their existing names",
  () =>
    Effect.gen(function* () {
      process.env.MIMOCODE_PASCAL_CASE_TOOLS = "true"
      const stub = yield* server([
        toolCallResponse({
          id: "exec-example",
          name: "exec",
          args: JSON.stringify({
            code: 'return await tools.apply_patch({ patch_text: "*** Begin Patch\\n*** Add File: example.txt\\n+example\\n*** End Patch" })',
          }),
        }),
        textStopResponse("Finished"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Codex tool naming" })
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "codex",
              parts: [{ type: "text", text: "Create the example file" }],
            })
            const names = stub.captures[0].tools.map((tool) => tool.function.name)
            const system = JSON.stringify(stub.captures[0].messages.filter((message) => message.role === "system"))
            expect(system).toContain("You may edit MEMORY.md when:")
            expect(system).toContain("the Grep and Read tools")
            expect(names).toContain("exec")
            expect(names).not.toContain("Exec")
            expect(names).not.toContain("Write")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "example.txt")).text())).toBe("example\n")
            const parts = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(parts.map((part) => [part.tool, part.state.status])).toEqual([["exec", "completed"]])
            expect(
              stub.captures[1].messages
                .flatMap((message) => message.tool_calls ?? [])
                .map((call) => call.function.name),
            ).toEqual(["exec"])
          }),
        { git: true, config: config(stub.origin) },
      )
    }),
  30000,
)

for (const scenario of [
  { apiID: "test-model", flag: undefined, name: "write" },
  { apiID: "test-model", flag: "true", name: "Write" },
  { apiID: "mimo-v2.6-pro", flag: "false", name: "write" },
]) {
  it.live(
    `model ${scenario.apiID} with PascalCase flag ${scenario.flag ?? "unset"} advertises and executes ${scenario.name}`,
    () =>
      Effect.gen(function* () {
        if (scenario.flag != null) process.env.MIMOCODE_PASCAL_CASE_TOOLS = scenario.flag
        const stub = yield* server([
          toolCallResponse({
            id: "gated-write",
            name: scenario.name,
            args: JSON.stringify({ file_path: "gated.txt", content: "gated content" }),
          }),
          textStopResponse("Finished"),
        ])
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Model tool naming gate" })
              yield* prompt.prompt({
                sessionID: session.id,
                harness: "default",
                parts: [{ type: "text", text: "Write the example file" }],
              })
              const names = stub.captures[0].tools.map((tool) => tool.function.name)
              expect(names).toContain(scenario.name)
              expect(names).not.toContain(scenario.name === "write" ? "Write" : "write")
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "gated.txt")).text())).toBe("gated content")
              expect(
                (yield* sessions.messages({ sessionID: session.id }))
                  .flatMap((message) => message.parts)
                  .filter((part) => part.type === "tool")
                  .map((part) => [part.tool, part.state.status]),
              ).toEqual([["write", "completed"]])
              expect(
                stub.captures[1].messages
                  .flatMap((message) => message.tool_calls ?? [])
                  .map((call) => call.function.name),
              ).toEqual([scenario.name])
            }),
          { git: true, config: config(stub.origin, { edit: "allow" }, scenario.apiID) },
        )
      }),
    30000,
  )
}

it.live(
  "first plan reminder names the default tools without changing the user request",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([textStopResponse("Plan recorded")])
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Plan reminder naming" })
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "default",
              agent: "plan",
              parts: [{ type: "text", text: "Explain read and write before implementing" }],
            })
            const messages = JSON.stringify(stub.captures[0].messages.filter((message) => message.role === "user"))
            expect(messages).toContain("the Read tool (view files), Grep (search contents), Glob (find files)")
            expect(messages).toContain("the Write tool")
            expect(messages).toContain("PlanExit")
            expect(messages).toContain("Explain read and write before implementing")
          }),
        { git: true, config: config(stub.origin) },
      )
    }),
  30000,
)

it.live(
  "flooding runs the first PascalCase call and cancels later calls with canonical names",
  () =>
    Effect.gen(function* () {
      const stub = yield* server([
        toolCallsResponse(
          Array.from({ length: 17 }, (_, index) => ({
            id: `flood-${index}`,
            name: "Write",
            args: JSON.stringify({ file_path: `flood-${index}.txt`, content: "example content" }),
          })),
        ),
        textStopResponse("Stopped flooding"),
      ])
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Flooding tool naming" })
            yield* prompt.prompt({
              sessionID: session.id,
              harness: "default",
              parts: [{ type: "text", text: "Attempt too many calls" }],
            })
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "flood-0.txt")).text())).toBe("example content")
            expect(yield* Effect.promise(() => Bun.file(path.join(dir, "flood-1.txt")).exists())).toBe(false)
            const parts = (yield* sessions.messages({ sessionID: session.id }))
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool")
            expect(parts).toHaveLength(17)
            expect(new Set(parts.map((part) => part.tool))).toEqual(new Set(["write"]))
            expect(parts.find((part) => part.callID === "flood-0")?.state.status).toBe("completed")
            expect(parts.filter((part) => part.callID !== "flood-0").every((part) => part.state.status === "error")).toBe(true)
          }),
        { git: true, config: config(stub.origin) },
      )
    }),
  30000,
)
