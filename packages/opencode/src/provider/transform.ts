import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type * as Provider from "./provider"
import type * as ModelsDev from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

// MiMo vision support isn't reflected in models.dev modality data, so the
// generic capability check would strip images before they reach the model.
// mimo-auto and mimo-v2.5 accept images; mimo-v2.5-pro is text-only.
function supportsImageInput(model: Provider.Model): boolean {
  if (model.providerID === "mimo" || model.providerID === "xiaomi") {
    const id = model.id.toLowerCase()
    if (id.includes("v2.5-pro")) return false
    if (id === "mimo-auto" || id.includes("v2.5")) return true
  }
  // Claude and GPT models are all multimodal regardless of catalog data.
  const id = model.id.toLowerCase()
  const apiID = model.api.id.toLowerCase()
  if (id.includes("claude") || apiID.includes("claude") || model.providerID === "anthropic") return true
  if (id.includes("gpt") || apiID.includes("gpt")) return true
  return model.capabilities.input.image
}

export const OUTPUT_TOKEN_MAX = Flag.MIMOCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000
const MIMO_OUTPUT_TOKEN_MAX = 128_000

// Maps npm package to the key the AI SDK expects for providerOptions
function sdkKey(npm: string): string | undefined {
  switch (npm) {
    case "@ai-sdk/github-copilot":
      return "copilot"
    case "@ai-sdk/azure":
      return "azure"
    case "@ai-sdk/openai":
      return "openai"
    case "@ai-sdk/amazon-bedrock":
      return "bedrock"
    case "@ai-sdk/anthropic":
    case "@ai-sdk/google-vertex/anthropic":
      return "anthropic"
    case "@ai-sdk/google-vertex":
      return "vertex"
    case "@ai-sdk/google":
      return "google"
    case "@ai-sdk/gateway":
      return "gateway"
    case "@openrouter/ai-sdk-provider":
      return "openrouter"
  }
  return undefined
}

function normalizeMessages(
  msgs: ModelMessage[],
  model: Provider.Model,
  _options: Record<string, unknown>,
): ModelMessage[] {
  // Anthropic rejects messages with empty content - filter out empty string messages
  // and remove empty text/reasoning parts from array content
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
    msgs = msgs
      .map((msg) => {
        if (typeof msg.content === "string") {
          if (msg.content === "") return undefined
          return msg
        }
        if (!Array.isArray(msg.content)) return msg
        const filtered = msg.content.filter((part) => {
          if (part.type === "text" || part.type === "reasoning") {
            return part.text !== ""
          }
          return true
        })
        if (filtered.length === 0) return undefined
        return { ...msg, content: filtered }
      })
      .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
  }

  if (model.api.id.includes("claude")) {
    const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
    msgs = msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          }),
        }
      }
      return msg
    })
  }
  if (["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"].includes(model.api.npm)) {
    // Anthropic rejects assistant turns where tool_use blocks are followed by non-tool
    // content, e.g. [tool_use, tool_use, text], with:
    // `tool_use` ids were found without `tool_result` blocks immediately after...
    //
    // Reorder that invalid shape into [text] + [tool_use, tool_use]. Consecutive
    // assistant messages are later merged by the provider/SDK, so preserving the
    // original [tool_use...] then [text] order still produces the invalid payload.
    //
    // The root cause appears to be somewhere upstream where the stream is originally
    // processed. We were unable to locate an exact narrower reproduction elsewhere,
    // so we keep this transform in place for the time being.
    msgs = msgs.flatMap((msg) => {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [msg]

      const parts = msg.content
      const first = parts.findIndex((part) => part.type === "tool-call")
      if (first === -1) return [msg]
      if (!parts.slice(first).some((part) => part.type !== "tool-call")) return [msg]
      return [
        { ...msg, content: parts.filter((part) => part.type !== "tool-call") },
        { ...msg, content: parts.filter((part) => part.type === "tool-call") },
      ]
    })
  }
  if (
    model.providerID === "mistral" ||
    model.api.id.toLowerCase().includes("mistral") ||
    model.api.id.toLocaleLowerCase().includes("devstral")
  ) {
    const scrub = (id: string) => {
      return id
        .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
        .substring(0, 9) // Take first 9 characters
        .padEnd(9, "0") // Pad with zeros if less than 9 characters
    }
    const result: ModelMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      const nextMsg = msgs[i + 1]

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-call" || part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      if (msg.role === "tool" && Array.isArray(msg.content)) {
        msg.content = msg.content.map((part) => {
          if (part.type === "tool-result") {
            return { ...part, toolCallId: scrub(part.toolCallId) }
          }
          return part
        })
      }
      result.push(msg)

      // Fix message sequence: tool messages cannot be followed by user messages
      if (msg.role === "tool" && nextMsg?.role === "user") {
        result.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done.",
            },
          ],
        })
      }
    }
    return result
  }

  if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
    const field = model.capabilities.interleaved.field
    return msgs.map((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
        const reasoningText = reasoningParts.map((part: any) => part.text).join("")

        // Filter out reasoning parts from content
        const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

        // Include reasoning_content | reasoning_details directly on the message for all assistant messages
        if (reasoningText) {
          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...msg.providerOptions?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
        }

        return {
          ...msg,
          content: filteredContent,
        }
      }

      return msg
    })
  }

  return msgs
}

// Determines whether a model's provider respects inline cache_control / cachePoint
// markers. Pure name matching (model.api.id.includes("claude")) is fragile — a Claude
// model behind an OpenAI-compatible proxy gets matched but markers are silently dropped.
// See upstream opencode#26786.
function supportsCacheMarkers(model: Provider.Model): boolean {
  // Anthropic-only SDKs — always support inline markers
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
  if (model.providerID === "anthropic" || model.providerID === "google-vertex-anthropic") return true
  // Bedrock cachePoint is a Converse API feature, works across model families
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
  // Multi-model providers: only Anthropic/Claude models support cache markers
  if (
    model.api.npm === "@openrouter/ai-sdk-provider" ||
    model.api.npm === "@ai-sdk/github-copilot" ||
    model.api.npm === "@ai-sdk/alibaba"
  ) {
    return (
      model.api.id.includes("claude") ||
      model.api.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.id.includes("anthropic")
    )
  }
  return false
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  // Only Anthropic and OpenRouter expose a cache-control TTL in their AI SDK;
  // the other providers ignore an unknown `ttl` field, so we only thread it
  // into those two branches. Default (unset) stays the provider 5m default.
  const ttl = model.cachePromptTTL === "1h" ? { ttl: "1h" as const } : {}
  const providerOptions = {
    anthropic: {
      cacheControl: { type: "ephemeral", ...ttl },
    },
    openrouter: {
      cacheControl: { type: "ephemeral", ...ttl },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openaiCompatible: {
      cache_control: { type: "ephemeral" },
    },
    copilot: {
      copilot_cache_control: { type: "ephemeral" },
    },
    alibaba: {
      cacheControl: { type: "ephemeral" },
    },
  }

  // Strategy: place cache breakpoints at stable prefix boundaries (max 4 allowed by Anthropic)
  // 1. Last system message — system prompt never changes
  // 2. Midpoint of conversation history — long prefix second-level cache
  // 3. Message before the last user message — stable history boundary
  const targets: ModelMessage[] = []

  const systemMsgs = msgs.filter((msg) => msg.role === "system")
  if (systemMsgs.length > 0) targets.push(systemMsgs[systemMsgs.length - 1])

  const nonSystem = msgs.filter((msg) => msg.role !== "system")
  const lastUserIdx = nonSystem.findLastIndex((msg) => msg.role === "user")
  if (lastUserIdx >= 1) {
    targets.push(nonSystem[lastUserIdx - 1])
    const midpoint = Math.floor(lastUserIdx / 2)
    if (midpoint > 0 && midpoint < lastUserIdx - 1) targets.push(nonSystem[midpoint])
  } else if (lastUserIdx === 0) {
    targets.push(nonSystem[0])
  }

  for (const msg of unique(targets)) {
    const useMessageLevelOptions =
      model.providerID === "anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

    if (shouldUseContentOptions) {
      const lastContent = msg.content[msg.content.length - 1]
      if (
        lastContent &&
        typeof lastContent === "object" &&
        lastContent.type !== "tool-approval-request" &&
        lastContent.type !== "tool-approval-response"
      ) {
        lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
        continue
      }
    }

    msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
  }

  return msgs
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      const supported = modality === "image" ? supportsImageInput(model) : model.capabilities.input[modality]
      if (supported) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

// Returns the decoded byte size of a base64 data URL, or undefined for inputs
// that aren't data URLs (remote URLs, raw binary) and therefore can't be sized.
function imageByteSize(image: string): number | undefined {
  if (!image.startsWith("data:")) return undefined
  const base64 = image.slice(image.indexOf(",") + 1)
  if (!base64) return 0
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function limitImages(msgs: ModelMessage[]): ModelMessage[] {
  const maxImages = Flag.MIMOCODE_MAX_PROMPT_IMAGES
  const maxSize = Flag.MIMOCODE_MAX_PROMPT_IMAGE_SIZE
  if (maxImages === undefined && maxSize === undefined) return msgs

  const total = msgs.reduce(
    (sum, msg) =>
      msg.role === "user" && Array.isArray(msg.content)
        ? sum + msg.content.filter((part) => part.type === "image").length
        : sum,
    0,
  )
  // Drop the oldest excess images so the most recent ones reach the model.
  let toDrop = maxImages === undefined ? 0 : Math.max(0, total - maxImages)

  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg
    const content = msg.content.map((part) => {
      if (part.type !== "image") return part
      if (toDrop > 0) {
        toDrop--
        return { type: "text" as const, text: `[Image omitted: exceeds the configured limit of ${maxImages} prompt image(s).]` }
      }
      if (maxSize !== undefined) {
        const size = imageByteSize(String(part.image))
        if (size !== undefined && size > maxSize) {
          return { type: "text" as const, text: `[Image omitted: exceeds the configured ${maxSize}-byte prompt image size limit.]` }
        }
      }
      return part
    })
    return { ...msg, content }
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = limitImages(msgs)
  msgs = normalizeMessages(msgs, model, options)
  if (supportsCacheMarkers(model)) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => {
          if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
            return { ...part }
          }
          return { ...part, providerOptions: remap(part.providerOptions) }
        }),
      } as typeof msg
    })
  }

  return msgs
}

export function temperature(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6")) return 1.0
  if (id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("mimo")) return 1.0
  if (id.includes("kimi-k2")) {
    // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function topP(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  return undefined
}

export function topK(model: Provider.Model) {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

function anthropicAdaptiveEfforts(apiId: string): string[] | null {
  if (["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => apiId.includes(v))) {
    return ["low", "medium", "high", "max"]
  }
  return null
}

export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const id = model.id.toLowerCase()
  const adaptiveEfforts = anthropicAdaptiveEfforts(model.api.id)
  if (
    id.includes("deepseek") ||
    id.includes("minimax") ||
    id.includes("glm") ||
    id.includes("mistral") ||
    id.includes("kimi") ||
    id.includes("k2p5") ||
    id.includes("qwen") ||
    id.includes("big-pickle")
  )
    return {}

  // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
  if (id.includes("grok") && id.includes("grok-3-mini")) {
    if (model.api.npm === "@openrouter/ai-sdk-provider") {
      return {
        low: { reasoning: { effort: "low" } },
        high: { reasoning: { effort: "high" } },
      }
    }
    return {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    }
  }
  if (id.includes("grok")) return {}

  switch (model.api.npm) {
    case "@openrouter/ai-sdk-provider":
      if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("claude")) return {}
      return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))

    case "@ai-sdk/gateway":
      if (model.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.id.includes("google")) {
        if (id.includes("2.5")) {
          return {
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        return Object.fromEntries(
          ["low", "high"].map((effort) => [
            effort,
            {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          ]),
        )
      }
      return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/github-copilot":
      if (model.id.includes("gemini")) {
        // currently github copilot only returns thinking
        return {}
      }
      if (model.id.includes("claude")) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      const copilotEfforts = iife(() => {
        if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
          return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
        return arr
      })
      return Object.fromEntries(
        copilotEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )

    case "@ai-sdk/cerebras":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
    case "@ai-sdk/togetherai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
    case "@ai-sdk/xai":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
    case "@ai-sdk/deepinfra":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
    case "venice-ai-sdk-provider":
    // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
    case "@ai-sdk/openai-compatible":
      return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

    case "@ai-sdk/azure":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
      if (id === "o1-mini") return {}
      const azureEfforts = ["low", "medium", "high"]
      if (id.includes("gpt-5-") || id === "gpt-5") {
        azureEfforts.unshift("minimal")
      }
      return Object.fromEntries(
        azureEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )
    case "@ai-sdk/openai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
      if (id === "gpt-5-pro") return {}
      const openaiEfforts = iife(() => {
        if (id.includes("codex")) {
          if (id.includes("5.2") || id.includes("5.3")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
          return WIDELY_SUPPORTED_EFFORTS
        }
        const arr = [...WIDELY_SUPPORTED_EFFORTS]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          arr.unshift("minimal")
        }
        if (model.release_date >= "2025-11-13") {
          arr.unshift("none")
        }
        if (model.release_date >= "2025-12-04") {
          arr.push("xhigh")
        }
        return arr
      })
      return Object.fromEntries(
        openaiEfforts.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        ]),
      )

    case "@ai-sdk/anthropic":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
    case "@ai-sdk/google-vertex/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider

      if (model.providerID === "github-copilot") {
        if (model.api.id.includes("opus-4.7")) {
          return Object.fromEntries(["medium"].map((effort) => [effort, { reasoningEffort: effort }]))
        }
      }

      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              thinking: {
                type: "adaptive",
                ...(["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8"].some((v) => model.api.id.includes(v))
                  ? { display: "summarized" }
                  : {}),
              },
              effort,
            },
          ]),
        )
      }

      return {
        high: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
          },
        },
        max: {
          thinking: {
            type: "enabled",
            budgetTokens: Math.min(31_999, model.limit.output - 1),
          },
        },
      }

    case "@ai-sdk/amazon-bedrock":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
      if (adaptiveEfforts) {
        return Object.fromEntries(
          adaptiveEfforts.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "adaptive",
                maxReasoningEffort: effort,
                ...(["opus-4-7", "opus-4.7", "opus-4-8", "opus-4.8"].some((v) => model.api.id.includes(v))
                  ? { display: "summarized" }
                  : {}),
              },
            },
          ]),
        )
      }
      // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
      if (model.api.id.includes("anthropic")) {
        return {
          high: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }

      // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
      return Object.fromEntries(
        WIDELY_SUPPORTED_EFFORTS.map((effort) => [
          effort,
          {
            reasoningConfig: {
              type: "enabled",
              maxReasoningEffort: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/google-vertex":
    // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
    case "@ai-sdk/google":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
      if (id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      let levels = ["low", "high"]
      if (id.includes("3.1")) {
        levels = ["low", "medium", "high"]
      }

      return Object.fromEntries(
        levels.map((effort) => [
          effort,
          {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: effort,
            },
          },
        ]),
      )

    case "@ai-sdk/mistral":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
      return {}

    case "@ai-sdk/cohere":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
      return {}

    case "@ai-sdk/groq":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
      const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
      return Object.fromEntries(
        groqEffort.map((effort) => [
          effort,
          {
            reasoningEffort: effort,
          },
        ]),
      )

    case "@ai-sdk/perplexity":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
      return {}

    case "@jerome-benoit/sap-ai-provider-v2":
      if (model.api.id.includes("anthropic")) {
        if (adaptiveEfforts) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [
              effort,
              {
                thinking: {
                  type: "adaptive",
                },
                effort,
              },
            ]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: 16000,
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: 31999,
            },
          },
        }
      }
      if (model.api.id.includes("gemini") && id.includes("2.5")) {
        return {
          high: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 16000,
            },
          },
          max: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 24576,
            },
          },
        }
      }
      if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id)) {
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))
      }
      return {}
  }
  return {}
}

export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}): Record<string, any> {
  const result: Record<string, any> = {}

  // openai and providers using openai package should set store to false by default.
  if (
    input.model.providerID === "openai" ||
    input.model.api.npm === "@ai-sdk/openai" ||
    input.model.api.npm === "@ai-sdk/github-copilot"
  ) {
    result["store"] = false
  }

  if (input.model.api.npm === "@ai-sdk/azure") {
    result["store"] = true
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@openrouter/ai-sdk-provider" || input.model.api.npm === "@llmgateway/ai-sdk-provider") {
    result["usage"] = {
      include: true,
    }
    if (input.model.api.id.includes("gemini-3")) {
      result["reasoning"] = { effort: "high" }
    }
  }

  if (
    input.model.providerID === "baseten" ||
    (input.model.providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
  ) {
    result["chat_template_args"] = { enable_thinking: true }
  }

  if (
    ["zai", "zhipuai"].some((id) => input.model.providerID.includes(id)) &&
    input.model.api.npm === "@ai-sdk/openai-compatible"
  ) {
    result["thinking"] = {
      type: "enabled",
      clear_thinking: false,
    }
  }

  if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
    if (input.model.capabilities.reasoning) {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }
  }

  // Enable thinking by default for kimi-k2.5/k2p5 models using anthropic SDK
  const modelId = input.model.api.id.toLowerCase()
  if (
    (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
    (modelId.includes("k2p5") || modelId.includes("kimi-k2.5") || modelId.includes("kimi-k2p5"))
  ) {
    result["thinking"] = {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
    }
  }

  // Enable thinking for reasoning models on alibaba-cn (DashScope).
  // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
  // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
  // deepseek-r1, etc. never output thinking/reasoning tokens.
  // Note: kimi-k2-thinking is excluded as it returns reasoning_content by default.
  if (
    input.model.providerID === "alibaba-cn" &&
    input.model.capabilities.reasoning &&
    input.model.api.npm === "@ai-sdk/openai-compatible" &&
    !modelId.includes("kimi-k2-thinking")
  ) {
    result["enable_thinking"] = true
  }

  if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
    if (!input.model.api.id.includes("gpt-5-pro")) {
      result["reasoningEffort"] = "medium"
      // Only inject reasoningSummary for providers that support it natively.
      // @ai-sdk/openai-compatible proxies (e.g. LiteLLM) do not understand this
      // parameter and return "Unknown parameter: 'reasoningSummary'".
      if (
        input.model.api.npm === "@ai-sdk/openai" ||
        input.model.api.npm === "@ai-sdk/azure" ||
        input.model.api.npm === "@ai-sdk/github-copilot"
      ) {
        result["reasoningSummary"] = "auto"
      }
    }

    // Only set textVerbosity for non-chat gpt-5.x models
    // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
    if (
      input.model.api.id.includes("gpt-5.") &&
      !input.model.api.id.includes("codex") &&
      !input.model.api.id.includes("-chat") &&
      input.model.providerID !== "azure"
    ) {
      result["textVerbosity"] = "low"
    }

    if (input.model.providerID.startsWith("opencode")) {
      result["promptCacheKey"] = input.sessionID
      result["include"] = ["reasoning.encrypted_content"]
      result["reasoningSummary"] = "auto"
    }
  }

  if (input.model.providerID === "venice") {
    result["promptCacheKey"] = input.sessionID
  }

  if (input.model.providerID === "openrouter") {
    result["prompt_cache_key"] = input.sessionID
  }
  if (input.model.api.npm === "@ai-sdk/gateway") {
    result["gateway"] = {
      caching: "auto",
    }
  }

  return result
}

export function smallOptions(model: Provider.Model) {
  if (
    model.providerID === "openai" ||
    model.api.npm === "@ai-sdk/openai" ||
    model.api.npm === "@ai-sdk/github-copilot"
  ) {
    if (model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.") || model.api.id.includes("5-mini")) {
        return { store: false, reasoningEffort: "low" }
      }
      return { store: false, reasoningEffort: "minimal" }
    }
    return { store: false }
  }
  if (model.providerID === "google") {
    // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
    if (model.api.id.includes("gemini-3")) {
      return { thinkingConfig: { thinkingLevel: "minimal" } }
    }
    return { thinkingConfig: { thinkingBudget: 0 } }
  }
  if (model.providerID === "openrouter" || model.providerID === "llmgateway") {
    if (model.api.id.includes("google")) {
      return { reasoning: { enabled: false } }
    }
    return { reasoningEffort: "minimal" }
  }

  if (model.providerID === "venice") {
    return { veniceParameters: { disableThinking: true } }
  }

  return {}
}

// Maps model ID prefix to provider slug used in providerOptions.
// Example: "amazon/nova-2-lite" → "bedrock"
const SLUG_OVERRIDES: Record<string, string> = {
  amazon: "bedrock",
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  if (model.api.npm === "@ai-sdk/gateway") {
    // Gateway providerOptions are split across two namespaces:
    // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
    // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
    // We keep `gateway` as-is and route every other top-level option under the
    // model-derived upstream slug.
    const i = model.api.id.indexOf("/")
    const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
    const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
    const gateway = options.gateway
    const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
    const has = Object.keys(rest).length > 0

    const result: Record<string, any> = {}
    if (gateway !== undefined) result.gateway = gateway

    if (has) {
      if (slug) {
        // Route model-specific options under the provider slug
        result[slug] = rest
      } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
        result.gateway = { ...gateway, ...rest }
      } else {
        result.gateway = rest
      }
    }

    return result
  }

  const key = sdkKey(model.api.npm) ?? model.providerID
  // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
  // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
  // "azure" first. Pass both so model options work on either code path.
  if (model.api.npm === "@ai-sdk/azure") {
    return { openai: options, azure: options }
  }
  return { [key]: options }
}

export function maxOutputTokens(model: Provider.Model): number {
  if (model.providerID === "mimo" || model.providerID === "xiaomi" || model.id.toLowerCase().includes("mimo")) {
    return MIMO_OUTPUT_TOKEN_MAX
  }
  return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

// Flatten a root-level `anyOf` / `oneOf` (typically from `z.discriminatedUnion`)
// into a single `type: "object"` schema with all variant properties merged at
// the root. The discriminator key becomes an `enum`, and per-variant required
// fields are encoded as a textual hint on the discriminator's description.
//
// OpenAI's function-calling validator rejects oneOf/anyOf/allOf/enum/not at the
// top level outright, so this is the only shape that gets through. We retain
// `additionalProperties: false` to keep the model from inventing fields, and
// rely on zod's runtime parse (still using the original discriminated union)
// to enforce per-action required fields strictly.
function flattenDiscriminatedUnion(schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
  const root = schema as Record<string, any>
  const variants = (root.anyOf ?? root.oneOf) as Array<Record<string, any>> | undefined
  if (!variants?.length) return schema as JSONSchema7

  // Find the discriminator: a property whose `const` differs across all variants.
  const constByKey = new Map<string, Set<unknown>>()
  for (const v of variants) {
    if (!v.properties) continue
    for (const [key, prop] of Object.entries(v.properties as Record<string, any>)) {
      if (prop && typeof prop === "object" && "const" in prop) {
        if (!constByKey.has(key)) constByKey.set(key, new Set())
        constByKey.get(key)!.add(prop.const)
      }
    }
  }
  let discriminator: string | undefined
  for (const [key, values] of constByKey) {
    if (values.size === variants.length) {
      discriminator = key
      break
    }
  }

  // Merge non-discriminator properties from every variant. Track which variants
  // each property appeared in so the description can tell the model
  // "(only when action='X'|'Y')" — flat schemas tempt some models (notably
  // gpt-5.5) to fill every property regardless of which action they chose.
  const properties: Record<string, any> = {}
  const propertyOwners: Record<string, unknown[]> = {}
  for (const v of variants) {
    if (!v.properties) continue
    const variantValue = discriminator
      ? (v.properties as Record<string, any>)[discriminator]?.const
      : undefined
    for (const [key, prop] of Object.entries(v.properties as Record<string, any>)) {
      if (key === discriminator) continue
      if (!(key in properties)) properties[key] = prop
      if (variantValue !== undefined) {
        if (!propertyOwners[key]) propertyOwners[key] = []
        propertyOwners[key].push(variantValue)
      }
    }
  }
  if (discriminator) {
    for (const [key, owners] of Object.entries(propertyOwners)) {
      if (owners.length === variants.length) continue // present in every variant — no annotation
      const tag = `(only when ${discriminator}=${owners.map((o) => JSON.stringify(o)).join("|")})`
      const original = (properties[key] as Record<string, any>).description as string | undefined
      properties[key] = {
        ...properties[key],
        description: original ? `${tag} ${original}` : tag,
      }
    }
  }

  // Discriminator becomes an enum with per-variant required fields hinted in
  // its description. Without this hint the model only sees a flat bag of
  // optional fields and forgets what to provide for each action.
  if (discriminator) {
    const proto = (variants[0].properties as Record<string, any>)[discriminator]
    const enumValues = variants.map((v) => (v.properties as Record<string, any>)[discriminator!]?.const)
    const baseDescription = (proto?.description as string | undefined) ?? ""
    const hints = variants
      .map((v) => {
        const value = (v.properties as Record<string, any>)[discriminator!]?.const
        const required = ((v.required as string[] | undefined) ?? []).filter((r) => r !== discriminator)
        return required.length > 0 ? `${value}: requires ${required.join(", ")}` : `${value}: no extra required fields`
      })
      .join("; ")
    properties[discriminator] = {
      type: "string",
      enum: enumValues,
      description: baseDescription ? `${baseDescription}\n\nPer-${discriminator}: ${hints}.` : `Per-${discriminator}: ${hints}.`,
    }
  }

  return {
    type: "object",
    properties,
    required: discriminator ? [discriminator] : [],
    additionalProperties: false,
  } as JSONSchema7
}

export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
  /*
  if (["openai", "azure"].includes(providerID)) {
    if (schema.type === "object" && schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key)) continue
        schema.properties[key] = {
          anyOf: [
            value as JSONSchema.JSONSchema,
            {
              type: "null",
            },
          ],
        }
      }
    }
  }
  */

  // Many providers reject root-level `anyOf`/`oneOf` in tool schemas:
  // - OpenAI/Azure: "schema must have type 'object' and not have 'oneOf'/'anyOf'"
  // - Bedrock: "input_schema.type: Field required"
  // - Anthropic proxies to Bedrock: same Bedrock error
  // Flatten unconditionally — all providers accept a flat `type: "object"` schema,
  // and zod's runtime parse still enforces per-variant required fields strictly.
  schema = flattenDiscriminatedUnion(schema)

  // Convert integer enums to string enums for Google/Gemini
  if (model.providerID === "google" || model.api.id.includes("gemini")) {
    const isPlainObject = (node: unknown): node is Record<string, any> =>
      typeof node === "object" && node !== null && !Array.isArray(node)
    const hasCombiner = (node: unknown) =>
      isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
    const hasSchemaIntent = (node: unknown) => {
      if (!isPlainObject(node)) return false
      if (hasCombiner(node)) return true
      return [
        "type",
        "properties",
        "items",
        "prefixItems",
        "enum",
        "const",
        "$ref",
        "additionalProperties",
        "patternProperties",
        "required",
        "not",
        "if",
        "then",
        "else",
      ].some((key) => key in node)
    }

    const sanitizeGemini = (obj: any): any => {
      if (obj === null || typeof obj !== "object") {
        return obj
      }

      if (Array.isArray(obj)) {
        return obj.map(sanitizeGemini)
      }

      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (key === "enum" && Array.isArray(value)) {
          // Convert all enum values to strings
          result[key] = value.map((v) => String(v))
          // If we have integer type with enum, change type to string
          if (result.type === "integer" || result.type === "number") {
            result.type = "string"
          }
        } else if (typeof value === "object" && value !== null) {
          result[key] = sanitizeGemini(value)
        } else {
          result[key] = value
        }
      }

      // Filter required array to only include fields that exist in properties
      if (result.type === "object" && result.properties && Array.isArray(result.required)) {
        result.required = result.required.filter((field: any) => field in result.properties)
      }

      if (result.type === "array" && !hasCombiner(result)) {
        if (result.items == null) {
          result.items = {}
        }
        // Ensure items has a type only when it's still schema-empty.
        if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
          result.items.type = "string"
        }
      }

      // Remove properties/required from non-object types (Gemini rejects these)
      if (result.type && result.type !== "object" && !hasCombiner(result)) {
        delete result.properties
        delete result.required
      }

      return result
    }

    schema = sanitizeGemini(schema)
  }

  return schema as JSONSchema7
}
