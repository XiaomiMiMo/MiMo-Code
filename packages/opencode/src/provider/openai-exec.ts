import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"

function execCode(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object" && "code" in input && typeof input.code === "string") return input.code
  throw new Error("Custom exec calls require a string code field")
}

/** Keep the engine's {code} contract while using the standard SDK's custom tools. */
export const openAIExecMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  async transformParams({ params }) {
    if (!params.tools?.some((tool) => tool.type === "function" && tool.name === "exec")) return params
    return {
      ...params,
      tools: params.tools.map((tool) =>
        tool.type === "function" && tool.name === "exec"
          ? {
              type: "provider" as const,
              id: "openai.custom" as const,
              name: "exec",
              args: { name: "exec", description: tool.description },
            }
          : tool,
      ),
      prompt: params.prompt.map((message) =>
        message.role !== "assistant"
          ? message
          : {
              ...message,
              content: message.content.map((part) =>
                part.type === "tool-call" && part.toolName === "exec" ? { ...part, input: execCode(part.input) } : part,
              ),
            },
      ),
    }
  },
  async wrapGenerate({ doGenerate, params }) {
    const result = await doGenerate()
    if (!params.tools?.some((tool) => tool.name === "exec" && tool.type === "provider" && tool.id === "openai.custom"))
      return result
    return {
      ...result,
      content: result.content.map((part) =>
        part.type === "tool-call" && part.toolName === "exec"
          ? { ...part, input: JSON.stringify({ code: execCode(JSON.parse(part.input)) }) }
          : part,
      ),
    }
  },
  async wrapStream({ doStream, params }) {
    const result = await doStream()
    if (!params.tools?.some((tool) => tool.name === "exec" && tool.type === "provider" && tool.id === "openai.custom"))
      return result
    const active = new Set<string>()
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(part, controller) {
            if (part.type === "tool-input-start" && part.toolName === "exec") {
              active.add(part.id)
              controller.enqueue(part)
              controller.enqueue({ type: "tool-input-delta", id: part.id, delta: '{"code":"' })
              return
            }
            if (part.type === "tool-input-delta" && active.has(part.id)) {
              controller.enqueue({ ...part, delta: JSON.stringify(part.delta).slice(1, -1) })
              return
            }
            if (part.type === "tool-input-end" && active.delete(part.id)) {
              controller.enqueue({ type: "tool-input-delta", id: part.id, delta: '"}' })
            }
            if (part.type === "tool-call" && part.toolName === "exec") {
              controller.enqueue({ ...part, input: JSON.stringify({ code: execCode(JSON.parse(part.input)) }) })
              return
            }
            controller.enqueue(part)
          },
        }),
      ),
    }
  },
}
