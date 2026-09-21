import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer, toolCallsResponse } from "../lib/scripted-llm-server"

const it = testEffect(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

for (const disabled of [false, true])
  it.live(
    disabled
      ? "StructuredOutput can finish after an edit failure when cascade is disabled"
      : "StructuredOutput is cancelled after an edit failure and a later step recovers",
    () =>
      Effect.gen(function* () {
        const previous = {
          cascade: process.env.MIMOCODE_DISABLE_FAIL_CASCADE,
          flooding: process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT,
        }
        delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
        delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
        if (disabled) process.env.MIMOCODE_DISABLE_FAIL_CASCADE = "1"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous.cascade == null) delete process.env.MIMOCODE_DISABLE_FAIL_CASCADE
            else process.env.MIMOCODE_DISABLE_FAIL_CASCADE = previous.cascade
            if (previous.flooding == null) delete process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT
            else process.env.MIMOCODE_DISABLE_TOOLCALL_FLOODING_DETECT = previous.flooding
          }),
        )
        const server = startScriptedLLMServer([
          {
            lines: toolCallsResponse([
              {
                id: "failed-edit",
                name: "edit",
                args: JSON.stringify({ file_path: "source.txt", old_string: "missing", new_string: "replacement" }),
              },
              { id: "early-output", name: "StructuredOutput", args: JSON.stringify({ answer: "premature" }) },
            ]),
          },
          {
            lines: toolCallsResponse([
              { id: "recovered-output", name: "StructuredOutput", args: JSON.stringify({ answer: "recovered" }) },
            ]),
          },
        ])
        yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
        yield* provideTmpdirInstance(
          (dir) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(path.join(dir, "source.txt"), "original"))
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "Structured output cascade" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                harness: "default",
                format: {
                  type: "json_schema",
                  schema: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                    required: ["answer"],
                    additionalProperties: false,
                  },
                  retryCount: 2,
                },
                parts: [{ type: "text", text: "Apply the edit and return the answer" }],
              })
              const tools = (yield* sessions.messages({ sessionID: session.id }))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === "tool")
              const failure = tools.find((part) => part.callID === "failed-edit")!
              const early = tools.find((part) => part.callID === "early-output")!
              expect(failure.state.status === "error" && failure.state.error).toContain("String to replace not found")
              expect(early.state.status).toBe(disabled ? "completed" : "error")
              expect(result.info.role === "assistant" && result.info.structured).toEqual({
                answer: disabled ? "premature" : "recovered",
              })
              expect(result.info.role === "assistant" && result.info.error).toBeUndefined()
              expect(yield* Effect.promise(() => Bun.file(path.join(dir, "source.txt")).text())).toBe("original")
              expect(server.captures).toHaveLength(disabled ? 1 : 2)
              expect(tools).toHaveLength(disabled ? 2 : 3)
              if (disabled) return
              const cancelled = "Tool call cancelled because an earlier tool call in this response failed."
              expect(early.state.status === "error" && early.state.error).toBe(cancelled)
              expect(tools.find((part) => part.callID === "recovered-output")?.state.status).toBe("completed")
              const continuation = JSON.stringify(server.captures[1].messages)
              expect(continuation).toContain("failed-edit")
              expect(continuation).toContain("String to replace not found")
              expect(continuation).toContain("early-output")
              expect(continuation).toContain(cancelled)
            }),
          {
            git: true,
            config: {
              enabled_providers: ["test"],
              model: "test/model",
              provider: {
                test: {
                  npm: "@ai-sdk/openai-compatible",
                  env: [],
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                  models: {
                    model: {
                      name: "Test",
                      tool_call: true,
                      limit: { context: 32000, output: 2000 },
                      modalities: { input: ["text"], output: ["text"] },
                    },
                  },
                },
              },
              agent: { build: { model: "test/model" } },
              permission: { edit: "allow" },
              lsp: false,
              formatter: false,
            },
          },
        )
      }),
    30000,
  )

describe("structured-output.OutputFormat", () => {
  test("parses text format", () => {
    const result = MessageV2.Format.safeParse({ type: "text" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("text")
    }
  })

  test("parses json_schema format with defaults", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object", properties: { name: { type: "string" } } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.type).toBe("json_schema")
      if (result.data.type === "json_schema") {
        expect(result.data.retryCount).toBe(2) // default value
      }
    }
  })

  test("parses json_schema format with custom retryCount", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: 5,
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === "json_schema") {
      expect(result.data.retryCount).toBe(5)
    }
  })

  test("rejects invalid type", () => {
    const result = MessageV2.Format.safeParse({ type: "invalid" })
    expect(result.success).toBe(false)
  })

  test("rejects json_schema without schema", () => {
    const result = MessageV2.Format.safeParse({ type: "json_schema" })
    expect(result.success).toBe(false)
  })

  test("rejects negative retryCount", () => {
    const result = MessageV2.Format.safeParse({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: -1,
    })
    expect(result.success).toBe(false)
  })
})

describe("structured-output.StructuredOutputError", () => {
  test("creates error with message and retries", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Failed to validate",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toBe("Failed to validate")
    expect(error.data.retries).toBe(3)
  })

  test("converts to object correctly", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Test error",
      retries: 2,
    })

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.message).toBe("Test error")
    expect(obj.data.retries).toBe(2)
  })

  test("isInstance correctly identifies error", () => {
    const error = new MessageV2.StructuredOutputError({
      message: "Test",
      retries: 1,
    })

    expect(MessageV2.StructuredOutputError.isInstance(error)).toBe(true)
    expect(MessageV2.StructuredOutputError.isInstance({ name: "other" })).toBe(false)
  })
})

describe("MessageV2.ContentFilterError", () => {
  test("creates, serializes, and round-trips isInstance", () => {
    const error = new MessageV2.ContentFilterError({ message: "withheld by safety filter" })

    expect(error.name).toBe("ContentFilterError")
    expect(error.data.message).toBe("withheld by safety filter")

    const obj = error.toObject()
    expect(obj.name).toBe("ContentFilterError")
    expect(obj.data.message).toBe("withheld by safety filter")

    expect(MessageV2.ContentFilterError.isInstance(error)).toBe(true)
    expect(MessageV2.ContentFilterError.isInstance({ name: "other" })).toBe(false)
  })
})

describe("structured-output.UserMessage", () => {
  test("user message accepts outputFormat", () => {
    const result = MessageV2.User.safeParse({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    })
    expect(result.success).toBe(true)
  })

  test("user message works without outputFormat (optional)", () => {
    const result = MessageV2.User.safeParse({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
    })
    expect(result.success).toBe(true)
  })
})

describe("structured-output.AssistantMessage", () => {
  const baseAssistantMessage = {
    id: MessageID.ascending(),
    sessionID: SessionID.descending(),
    role: "assistant" as const,
    parentID: MessageID.ascending(),
    modelID: "claude-3",
    providerID: "anthropic",
    mode: "default",
    agent: "default",
    path: { cwd: "/test", root: "/test" },
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }

  test("assistant message accepts structured", () => {
    const result = MessageV2.Assistant.safeParse({
      ...baseAssistantMessage,
      structured: { company: "Anthropic", founded: 2021 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.structured).toEqual({ company: "Anthropic", founded: 2021 })
    }
  })

  test("assistant message works without structured_output (optional)", () => {
    const result = MessageV2.Assistant.safeParse(baseAssistantMessage)
    expect(result.success).toBe(true)
  })
})

describe("structured-output.createStructuredOutputTool", () => {
  test("creates tool with description", () => {
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object" },
      onSuccess: () => {},
    })

    expect(tool.description).toContain("structured format")
  })

  test("creates tool with schema as inputSchema", () => {
    const schema = {
      type: "object",
      properties: {
        company: { type: "string" },
        founded: { type: "number" },
      },
      required: ["company"],
    }

    const tool = SessionPrompt.createStructuredOutputTool({
      schema,
      onSuccess: () => {},
    })

    // AI SDK wraps schema in { jsonSchema: {...} }
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.company).toBeDefined()
    expect(inputSchema.jsonSchema?.properties?.founded).toBeDefined()
  })

  test("strips $schema property from inputSchema", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { name: { type: "string" } },
    }

    const tool = SessionPrompt.createStructuredOutputTool({
      schema,
      onSuccess: () => {},
    })

    // AI SDK wraps schema in { jsonSchema: {...} }
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.$schema).toBeUndefined()
  })

  test("execute calls onSuccess with valid args", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object", properties: { name: { type: "string" } } },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    expect(tool.execute).toBeDefined()
    const testArgs = { name: "Test Company" }
    const result = await tool.execute!(testArgs, {
      toolCallId: "test-call-id",
      messages: [],
      abortSignal: undefined as any,
    })

    expect(capturedOutput).toEqual(testArgs)
    expect(result.output).toBe("Structured output captured successfully.")
    expect(result.metadata.valid).toBe(true)
  })

  test("AI SDK validates schema before execute - missing required field", async () => {
    // Note: The AI SDK validates the input against the schema BEFORE calling execute()
    // So invalid inputs never reach the tool's execute function
    // This test documents the expected schema behavior
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      },
      onSuccess: () => {},
    })

    // The schema requires both 'name' and 'age'
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.required).toContain("name")
    expect(inputSchema.jsonSchema?.required).toContain("age")
  })

  test("AI SDK validates schema types before execute - wrong type", async () => {
    // Note: The AI SDK validates the input against the schema BEFORE calling execute()
    // So invalid inputs never reach the tool's execute function
    // This test documents the expected schema behavior
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
        required: ["count"],
      },
      onSuccess: () => {},
    })

    // The schema defines 'count' as a number
    expect(tool.inputSchema).toBeDefined()
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.count?.type).toBe("number")
  })

  test("execute handles nested objects", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name"],
          },
        },
        required: ["user"],
      },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    // Valid nested object - AI SDK validates before calling execute()
    const validResult = await tool.execute!(
      { user: { name: "John", email: "john@test.com" } },
      {
        toolCallId: "test-call-id",
        messages: [],
        abortSignal: undefined as any,
      },
    )

    expect(capturedOutput).toEqual({ user: { name: "John", email: "john@test.com" } })
    expect(validResult.metadata.valid).toBe(true)

    // Verify schema has correct nested structure
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.user?.type).toBe("object")
    expect(inputSchema.jsonSchema?.properties?.user?.properties?.name?.type).toBe("string")
    expect(inputSchema.jsonSchema?.properties?.user?.required).toContain("name")
  })

  test("execute handles arrays", async () => {
    let capturedOutput: unknown

    const tool = SessionPrompt.createStructuredOutputTool({
      schema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["tags"],
      },
      onSuccess: (output) => {
        capturedOutput = output
      },
    })

    // Valid array - AI SDK validates before calling execute()
    const validResult = await tool.execute!(
      { tags: ["a", "b", "c"] },
      {
        toolCallId: "test-call-id",
        messages: [],
        abortSignal: undefined as any,
      },
    )

    expect(capturedOutput).toEqual({ tags: ["a", "b", "c"] })
    expect(validResult.metadata.valid).toBe(true)

    // Verify schema has correct array structure
    const inputSchema = tool.inputSchema as any
    expect(inputSchema.jsonSchema?.properties?.tags?.type).toBe("array")
    expect(inputSchema.jsonSchema?.properties?.tags?.items?.type).toBe("string")
  })

  test("toModelOutput returns text value", async () => {
    const tool = SessionPrompt.createStructuredOutputTool({
      schema: { type: "object" },
      onSuccess: () => {},
    })

    expect(tool.toModelOutput).toBeDefined()
    const modelOutput = await Promise.resolve(
      tool.toModelOutput!({
        toolCallId: "test-call-id",
        input: {},
        output: {
          output: "Test output",
        },
      }),
    )

    expect(modelOutput.type).toBe("text")
    if (modelOutput.type !== "text") throw new Error("expected text model output")
    expect(modelOutput.value).toBe("Test output")
  })

  // Note: Retry behavior is handled by the AI SDK and the prompt loop, not the tool itself
  // The tool simply calls onSuccess when execute() is called with valid args
  // See prompt.ts loop() for actual retry logic
})
