import { describe, test, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Tool } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { MessageID, SessionID } from "../../src/session/schema"
import { RecoverableError } from "../../src/tool/recoverable"
import { testEffect } from "../lib/effect"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = z.object({ input: z.string().min(1) })

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

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_example"),
    messageID: MessageID.make("msg_example"),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
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

  it.effect("validation formatters receive the original arguments and Zod error without executing the tool", () =>
    Effect.gen(function* () {
      const calls: { error: z.ZodError; args: unknown }[] = []
      let executed = false
      const info = yield* Tool.define(
        "example-input",
        Effect.succeed({
          ...makeTool("example", () => {
            executed = true
          }),
          formatValidationError(error: z.ZodError, args: unknown) {
            calls.push({ error, args })
            return "Specific argument guidance"
          },
        }),
      )
      const def = yield* info.init()
      const args = Object.freeze({ input: "", extra: "example content" })
      const exit = yield* Effect.exit(def.execute(args, context()))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].error).toBeInstanceOf(z.ZodError)
      expect(calls[0].args).toBe(args)
      expect(args).toEqual({ input: "", extra: "example content" })
      expect(executed).toBe(false)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(RecoverableError)
        if (error instanceof RecoverableError) {
          expect(error.message).toBe("Specific argument guidance")
          expect(error.cause).toBe(calls[0].error)
        }
      }
    }),
  )

  it.effect("validation formatters accepting only the error remain compatible", () =>
    Effect.gen(function* () {
      const errors: z.ZodError[] = []
      const info = yield* Tool.define(
        "example-legacy",
        Effect.succeed({
          ...makeTool("example"),
          formatValidationError(error: z.ZodError) {
            errors.push(error)
            return "Legacy argument guidance"
          },
        }),
      )
      const def = yield* info.init()
      const exit = yield* Effect.exit(def.execute({ input: "" }, context()))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toBeInstanceOf(z.ZodError)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(RecoverableError)
        if (error instanceof RecoverableError) {
          expect(error.message).toBe("Legacy argument guidance")
          expect(error.cause).toBe(errors[0])
        }
      }
    }),
  )

  it.effect("tools without a custom formatter keep the standard validation message", () =>
    Effect.gen(function* () {
      let executed = false
      const info = yield* Tool.define(
        "example-standard",
        Effect.succeed(
          makeTool("example", () => {
            executed = true
          }),
        ),
      )
      const def = yield* info.init()
      const args = { input: "" }
      const validation = params.safeParse(args)
      expect(validation.success).toBe(false)
      const exit = yield* Effect.exit(def.execute(args, context()))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(executed).toBe(false)
      if (Exit.isFailure(exit) && !validation.success) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(RecoverableError)
        if (error instanceof RecoverableError) {
          expect(error.message).toBe(Tool.validationErrorMessage("example-standard", validation.error))
          expect(error.cause).toBeInstanceOf(z.ZodError)
        }
      }
    }),
  )
})
