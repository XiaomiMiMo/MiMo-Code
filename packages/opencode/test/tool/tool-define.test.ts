import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Tool } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { MessageID, SessionID } from "../../src/session/schema"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = z.object({ input: z.string() })

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  test("object-defined tool does not mutate the original init object", async () => {
    const original = makeTool("test")
    const originalExecute = original.execute

    const info = await runtime.runPromise(Tool.define("test-tool", Effect.succeed(original)))

    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())

    expect(original.execute).toBe(originalExecute)
  })

  test("effect-defined tool returns fresh objects and is unaffected", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      ),
    )

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("object-defined tool returns distinct objects per init() call", async () => {
    const info = await runtime.runPromise(Tool.define("test-copy", Effect.succeed(makeTool("test"))))

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("execute validates recovered args when direct JSON tool args use a stringified envelope", async () => {
    const parameters = z.object({
      operation: z.object({
        action: z.literal("list"),
      }),
    })
    let received: z.infer<typeof parameters> | undefined
    const info = await runtime.runPromise(
      Tool.define(
        "recovering-tool",
        Effect.succeed({
          description: "test tool",
          parameters,
          recover(rawArgs: unknown) {
            if (rawArgs == null || typeof rawArgs !== "object") return undefined
            const args = rawArgs as Record<string, unknown>
            if (typeof args.operation !== "string") return undefined
            return { operation: JSON.parse(args.operation) as { action: "list" } }
          },
          execute(args: z.infer<typeof parameters>) {
            received = args
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      ),
    )
    const def = await Effect.runPromise(info.init())

    const result = await Effect.runPromise(
      def.execute(
        { operation: '{"action":"list"}' } as unknown as z.infer<typeof parameters>,
        {
          sessionID: SessionID.descending(),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      ),
    )

    expect(result.output).toBe("ok")
    expect(received).toEqual({ operation: { action: "list" } })
  })
})
