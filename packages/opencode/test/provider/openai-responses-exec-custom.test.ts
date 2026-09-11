import { describe, expect, test } from "bun:test"
import type { JSONSchema7, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { convertToOpenAIResponsesInput } from "../../src/provider/sdk/copilot/responses/convert-to-openai-responses-input"
import { prepareResponsesTools } from "../../src/provider/sdk/copilot/responses/openai-responses-prepare-tools"
import { createOpenaiCompatible } from "../../src/provider/sdk/copilot/copilot-provider"
import { generateText, jsonSchema, stepCountIs, tool } from "ai"

const execTool = {
  type: "function",
  name: "exec",
  description: "Run a JavaScript tool orchestration body.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  } satisfies JSONSchema7,
}

const userPrompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "run it" }] }]

function response(output: unknown[]) {
  return {
    id: "resp_exec",
    object: "response",
    created_at: 1_755_000_000,
    status: "completed",
    model: "mimo-ptc",
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    incomplete_details: null,
    service_tier: null,
  }
}

function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
}

describe("Responses exec custom tool", () => {
  test("advertises exec as a free-form custom tool", () => {
    const result = prepareResponsesTools({
      tools: [execTool] as any,
      strictJsonSchema: false,
      customToolNames: new Set(["exec"]),
    })

    expect(result.tools).toEqual([
      {
        type: "custom",
        name: "exec",
        description: execTool.description,
      },
    ])
  })

  test("keeps exec as a function tool when the provider has no custom-tool capability", () => {
    const result = prepareResponsesTools({
      tools: [execTool] as any,
      strictJsonSchema: false,
    })

    expect(result.tools?.[0]).toMatchObject({
      type: "function",
      name: "exec",
      parameters: execTool.inputSchema,
    })
  })

  test("keeps ordinary tools as JSON function tools", () => {
    const result = prepareResponsesTools({
      tools: [{ ...execTool, name: "read" }] as any,
      strictJsonSchema: false,
    })

    expect(result.tools?.[0]).toMatchObject({
      type: "function",
      name: "read",
      parameters: execTool.inputSchema,
    })
  })

  test("round-trips an exec custom call and its output with the original call type", async () => {
    const source = 'const r = await tools.exec_command({ cmd: "pwd" }); return r.output'
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_exec_1",
            toolName: "exec",
            input: { code: source },
            providerOptions: {
              openai: {
                itemId: "ctc_1",
                toolCallType: "custom",
              },
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_exec_1",
            toolName: "exec",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]

    const result = await convertToOpenAIResponsesInput({
      prompt,
      systemMessageMode: "system",
      store: false,
    })

    expect(result.input).toEqual([
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_exec_1",
        name: "exec",
        input: source,
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_exec_1",
        output: "ok",
      },
    ])
  })

  test("keeps legacy function-call round trips unchanged", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_read_1",
            toolName: "read",
            input: { path: "/tmp/a" },
            providerOptions: { openai: { itemId: "fc_1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_read_1",
            toolName: "read",
            output: { type: "text", value: "contents" },
          },
        ],
      },
    ]

    const result = await convertToOpenAIResponsesInput({
      prompt,
      systemMessageMode: "system",
      store: false,
    })

    expect(result.input).toEqual([
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_read_1",
        name: "read",
        arguments: JSON.stringify({ path: "/tmp/a" }),
      },
      {
        type: "function_call_output",
        call_id: "call_read_1",
        output: "contents",
      },
    ])
  })

  test("parses a non-streaming custom exec call into the internal code envelope", async () => {
    const source = 'const r = await tools.exec_command({ cmd: "pwd" }); return r.output'
    const provider = createOpenaiCompatible({
      baseURL: "https://example.test/v1",
      fetch: (async () =>
        new Response(
          JSON.stringify(
            response([
              {
                type: "custom_tool_call",
                id: "ctc_nonstream",
                call_id: "call_nonstream",
                name: "exec",
                input: source,
              },
            ]),
          ),
          { headers: { "content-type": "application/json" } },
        )) as any,
    })

    const result = await provider.responses("mimo-ptc").doGenerate({ prompt: userPrompt })

    expect(result.content).toContainEqual({
      type: "tool-call",
      toolCallId: "call_nonstream",
      toolName: "exec",
      input: JSON.stringify({ code: source }),
      providerMetadata: { openai: { itemId: "ctc_nonstream", toolCallType: "custom" } },
    })
  })

  test("parses fragmented and adjacent streaming custom exec calls without separators", async () => {
    const sources = [
      'const a = await tools.exec_command({ cmd: "pwd" }); return a.output',
      'const b = await tools.exec_command({ cmd: "git status" }); return b.output',
    ]
    const events: unknown[] = [
      {
        type: "response.created",
        response: { id: "resp_stream", created_at: 1_755_000_000, model: "mimo-ptc", service_tier: null },
      },
    ]
    for (const [outputIndex, source] of sources.entries()) {
      const item = {
        type: "custom_tool_call",
        id: `ctc_${outputIndex}`,
        call_id: `call_${outputIndex}`,
        name: "exec",
        input: source,
      }
      events.push(
        { type: "response.output_item.added", output_index: outputIndex, item: { ...item, input: "" } },
        {
          type: "response.custom_tool_call_input.delta",
          item_id: item.id,
          output_index: outputIndex,
          delta: source.slice(0, 17),
        },
        {
          type: "response.custom_tool_call_input.delta",
          item_id: item.id,
          output_index: outputIndex,
          delta: source.slice(17),
        },
        {
          type: "response.custom_tool_call_input.done",
          item_id: item.id,
          output_index: outputIndex,
          input: source,
        },
        { type: "response.output_item.done", output_index: outputIndex, item: { ...item, status: "completed" } },
      )
    }
    events.push({
      type: "response.completed",
      response: {
        incomplete_details: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        service_tier: null,
      },
    })

    const provider = createOpenaiCompatible({
      baseURL: "https://example.test/v1",
      fetch: (async () => sse(events)) as any,
    })
    const result = await provider.responses("mimo-ptc").doStream({ prompt: userPrompt })
    const parts: any[] = []
    const reader = result.stream.getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }

    expect(parts.filter((part) => part.type === "tool-call")).toEqual(
      sources.map((source, index) => ({
        type: "tool-call",
        toolCallId: `call_${index}`,
        toolName: "exec",
        input: JSON.stringify({ code: source }),
        providerMetadata: { openai: { itemId: `ctc_${index}`, toolCallType: "custom" } },
      })),
    )
  })

  test("executes and returns a custom-tool output in the next Responses request", async () => {
    const source = "return 42"
    const bodies: any[] = []
    let request = 0
    const provider = createOpenaiCompatible({
      name: "xiaomi",
      customToolNames: ["exec"],
      baseURL: "https://example.test/v1",
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        request++
        const output =
          request === 1
            ? [
                {
                  type: "custom_tool_call",
                  id: "ctc_loop",
                  call_id: "call_loop",
                  name: "exec",
                  input: source,
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_done",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "done", annotations: [] }],
                },
              ]
        return new Response(JSON.stringify(response(output)), { headers: { "content-type": "application/json" } })
      }) as any,
    })

    const result = await generateText({
      model: provider.responses("mimo-ptc"),
      prompt: "run it",
      tools: {
        exec: tool({
          description: execTool.description,
          inputSchema: jsonSchema(execTool.inputSchema),
          execute: async ({ code }) => `executed:${code}`,
        }),
      },
      providerOptions: { xiaomi: { store: false } },
      stopWhen: stepCountIs(2),
    })

    expect(result.text).toBe("done")
    expect(bodies[0].tools).toEqual([
      { type: "custom", name: "exec", description: execTool.description },
    ])
    expect(bodies[0].store).toBe(false)
    expect(bodies[1].input).toContainEqual({
      type: "custom_tool_call",
      id: "ctc_loop",
      call_id: "call_loop",
      name: "exec",
      input: source,
    })
    expect(bodies[1].input).toContainEqual({
      type: "custom_tool_call_output",
      call_id: "call_loop",
      output: "executed:return 42",
    })
  })
})
