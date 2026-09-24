import { type LanguageModelV3Prompt, type SharedV3Warning, UnsupportedFunctionalityError } from "@ai-sdk/provider"
import { convertToBase64, parseProviderOptions } from "@ai-sdk/provider-utils"
import { z } from "zod/v4"
import { reasoningItemSchema } from "./reasoning"
import type { OpenAIResponsesInput, OpenAIResponsesReasoning, OpenAIResponsesToolOutput } from "./openai-responses-api-types"
import { localShellInputSchema, localShellOutputSchema } from "./tool/local-shell"

/**
 * Check if a string is a file ID based on the given prefixes
 * Returns false if prefixes is undefined (disables file ID detection)
 */
function isFileId(data: string, prefixes?: readonly string[]): boolean {
  if (!prefixes) return false
  return prefixes.some((prefix) => data.startsWith(prefix))
}

function customExecSource(input: unknown): string {
  if (typeof input !== "string") {
    if (input && typeof input === "object" && "code" in input && typeof input.code === "string") return input.code
    throw new Error("Custom exec calls require a string code field")
  }
  try {
    const parsed = JSON.parse(input) as unknown
    if (typeof parsed === "string") return parsed
    if (parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string") {
      return parsed.code
    }
  } catch {
    // A raw JavaScript body is the native custom-tool representation.
  }
  return input
}

export async function convertToOpenAIResponsesInput({
  prompt,
  systemMessageMode,
  fileIdPrefixes,
  store,
  hasLocalShellTool = false,
  providerOptionsKey = "copilot",
}: {
  prompt: LanguageModelV3Prompt
  systemMessageMode: "system" | "developer" | "remove"
  fileIdPrefixes?: readonly string[]
  store: boolean
  hasLocalShellTool?: boolean
  providerOptionsKey?: string
}): Promise<{
  input: OpenAIResponsesInput
  warnings: Array<SharedV3Warning>
}> {
  const input: OpenAIResponsesInput = []
  const warnings: Array<SharedV3Warning> = []
  const processedApprovalIds = new Set<string>()
  const customToolCallIds = new Set<string>()

  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        switch (systemMessageMode) {
          case "system": {
            input.push({ role: "system", content })
            break
          }
          case "developer": {
            input.push({ role: "developer", content })
            break
          }
          case "remove": {
            warnings.push({
              type: "other",
              message: "system messages are removed for this model",
            })
            break
          }
          default: {
            const _exhaustiveCheck: never = systemMessageMode
            throw new Error(`Unsupported system message mode: ${_exhaustiveCheck}`)
          }
        }
        break
      }

      case "user": {
        input.push({
          role: "user",
          content: content.map((part, index) => {
            switch (part.type) {
              case "text": {
                return { type: "input_text", text: part.text }
              }
              case "file": {
                if (part.mediaType.startsWith("image/")) {
                  const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType

                  return {
                    type: "input_image",
                    ...(part.data instanceof URL
                      ? { image_url: part.data.toString() }
                      : typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
                        ? { file_id: part.data }
                        : {
                            image_url: `data:${mediaType};base64,${convertToBase64(part.data)}`,
                          }),
                    detail: part.providerOptions?.openai?.imageDetail,
                  }
                } else if (part.mediaType === "application/pdf") {
                  if (part.data instanceof URL) {
                    return {
                      type: "input_file",
                      file_url: part.data.toString(),
                    }
                  }
                  return {
                    type: "input_file",
                    ...(typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
                      ? { file_id: part.data }
                      : {
                          filename: part.filename ?? `part-${index}.pdf`,
                          file_data: `data:application/pdf;base64,${convertToBase64(part.data)}`,
                        }),
                  }
                } else {
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
        })

        break
      }

      case "assistant": {
        const reasoningMessages: Record<string, OpenAIResponsesReasoning> = {}
        const canonicalReasoning = new Map<string, OpenAIResponsesReasoning>()
        for (const part of content) {
          if (part.type !== "reasoning") continue
          const raw = (part.providerOptions?.[providerOptionsKey] ?? part.providerOptions?.openai)?.reasoningItem
          if (raw == null) continue
          const item = reasoningItemSchema.parse(raw)
          canonicalReasoning.set(item.id, {
            ...item,
            summary: item.summary ?? [],
            content: item.content ?? undefined,
            status: item.status ?? undefined,
          })
        }

        for (const part of content) {
          switch (part.type) {
            case "text": {
              const phase = part.providerOptions?.openai?.phase
              input.push({
                role: "assistant",
                content: [{ type: "output_text", text: part.text }],
                ...(phase === "commentary" || phase === "final_answer" ? { phase } : {}),
                id: (part.providerOptions?.openai?.itemId as string) ?? undefined,
              })
              break
            }
            case "tool-call": {
              if (part.providerExecuted) {
                break
              }

              if (hasLocalShellTool && part.toolName === "local_shell") {
                const parsedInput = localShellInputSchema.parse(part.input)
                input.push({
                  type: "local_shell_call",
                  call_id: part.toolCallId,
                  id: (part.providerOptions?.openai?.itemId as string) ?? undefined,
                  action: {
                    type: "exec",
                    command: parsedInput.action.command,
                    timeout_ms: parsedInput.action.timeoutMs,
                    user: parsedInput.action.user,
                    working_directory: parsedInput.action.workingDirectory,
                    env: parsedInput.action.env,
                  },
                })

                break
              }

              if (part.providerOptions?.openai?.toolCallType === "custom") {
                customToolCallIds.add(part.toolCallId)
                input.push({
                  type: "custom_tool_call",
                  call_id: part.toolCallId,
                  name: part.toolName,
                  input: customExecSource(part.input),
                  id: (part.providerOptions?.openai?.itemId as string) ?? undefined,
                })
                break
              }

              input.push({
                type: "function_call",
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: JSON.stringify(part.input),
                id: (part.providerOptions?.openai?.itemId as string) ?? undefined,
              })
              break
            }

            // assistant tool result parts are from provider-executed tools:
            case "tool-result": {
              if (store) {
                // use item references to refer to tool results from built-in tools
                input.push({ type: "item_reference", id: part.toolCallId })
              } else {
                warnings.push({
                  type: "other",
                  message: `Results for OpenAI tool ${part.toolName} are not sent to the API when store is false`,
                })
              }

              break
            }

            case "reasoning": {
              const providerOptions = await parseProviderOptions({
                // Responses metadata is emitted under openai, including by Copilot.
                provider: part.providerOptions?.[providerOptionsKey] ? providerOptionsKey : "openai",
                providerOptions: part.providerOptions,
                schema: openaiResponsesReasoningProviderOptionsSchema,
              })

              const reasoningId = providerOptions?.itemId ?? providerOptions?.reasoningItem?.id
              const canonical = reasoningId != null ? canonicalReasoning.get(reasoningId) : undefined
              if (canonical) {
                if (!reasoningMessages[canonical.id]) {
                  input.push(store ? { type: "item_reference", id: canonical.id } : canonical)
                  reasoningMessages[canonical.id] = canonical
                }
                break
              }

              if (reasoningId != null) {
                const reasoningMessage = reasoningMessages[reasoningId]

                if (store) {
                  if (reasoningMessage === undefined) {
                    // use item references to refer to reasoning (single reference)
                    input.push({ type: "item_reference", id: reasoningId })

                    // store unused reasoning message to mark id as used
                    reasoningMessages[reasoningId] = {
                      type: "reasoning",
                      id: reasoningId,
                      summary: [],
                    }
                  }
                } else {
                  // A cancelled stream can have channel metadata without a final
                  // canonical item. Keep the received text in its original channel.
                  const message = reasoningMessage ?? {
                    type: "reasoning" as const,
                    id: reasoningId,
                    encrypted_content: providerOptions?.reasoningEncryptedContent,
                    summary: [],
                  }
                  if (reasoningMessage === undefined) {
                    reasoningMessages[reasoningId] = message
                    input.push(message)
                  }
                  if (providerOptions?.reasoningChannel === "content") {
                    message.content ??= []
                    message.content.push({ type: "reasoning_text", text: part.text })
                  } else if (providerOptions?.reasoningChannel !== "item" && part.text.length > 0) {
                    message.summary.push({ type: "summary_text", text: part.text })
                  }
                }
              } else {
                warnings.push({
                  type: "other",
                  message: `Non-OpenAI reasoning parts are not supported. Skipping reasoning part: ${JSON.stringify(part)}.`,
                })
              }
              break
            }
          }
        }

        break
      }

      case "tool": {
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            if (processedApprovalIds.has(part.approvalId)) {
              continue
            }
            processedApprovalIds.add(part.approvalId)

            if (store) {
              input.push({
                type: "item_reference",
                id: part.approvalId,
              })
            }

            input.push({
              type: "mcp_approval_response",
              approval_request_id: part.approvalId,
              approve: part.approved,
            })
            continue
          }
          const output = part.output

          if (output.type === "execution-denied") {
            const approvalId = (output.providerOptions?.openai as { approvalId?: string } | undefined)?.approvalId

            if (approvalId) {
              continue
            }
          }

          if (hasLocalShellTool && part.toolName === "local_shell" && output.type === "json") {
            input.push({
              type: "local_shell_call_output",
              call_id: part.toolCallId,
              output: localShellOutputSchema.parse(output.value).output,
            })
            break
          }

          let contentValue: OpenAIResponsesToolOutput
          switch (output.type) {
            case "text":
            case "error-text":
              contentValue = output.value
              break
            case "execution-denied":
              contentValue = output.reason ?? "Tool execution denied."
              break
            case "content":
              contentValue = output.value.flatMap((item): Exclude<OpenAIResponsesToolOutput, string> => {
                switch (item.type) {
                  case "text":
                    return [{ type: "input_text", text: item.text }]
                  case "image-data":
                    return [{ type: "input_image", image_url: `data:${item.mediaType};base64,${item.data}` }]
                  case "image-url":
                    return [{ type: "input_image", image_url: item.url }]
                  case "file-data":
                    return [{
                      type: "input_file",
                      filename: item.filename ?? "data",
                      file_data: `data:${item.mediaType};base64,${item.data}`,
                    }]
                  case "file-url":
                    return [{ type: "input_file", file_url: item.url }]
                  default:
                    warnings.push({ type: "other", message: `Unsupported tool content part type: ${item.type}` })
                    return []
                }
              })
              break
            case "json":
            case "error-json":
              contentValue = JSON.stringify(output.value)
              break
          }

          input.push(
            customToolCallIds.has(part.toolCallId)
              ? {
                  type: "custom_tool_call_output",
                  call_id: part.toolCallId,
                  output: contentValue,
                }
              : {
                  type: "function_call_output",
                  call_id: part.toolCallId,
                  output: contentValue,
                },
          )
        }

        break
      }

      default: {
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  return { input, warnings }
}

const openaiResponsesReasoningProviderOptionsSchema = z.object({
  itemId: z.string().nullish(),
  reasoningItem: reasoningItemSchema.optional(),
  reasoningChannel: z.enum(["content", "summary", "item"]).optional(),
  reasoningEncryptedContent: z.string().nullish(),
})

export type OpenAIResponsesReasoningProviderOptions = z.infer<typeof openaiResponsesReasoningProviderOptionsSchema>
