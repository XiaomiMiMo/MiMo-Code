import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type * as Provider from "./provider"
import type * as ModelsDev from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"
import { compressImage, DEFAULT_MAX_IMAGE_BYTES } from "./image"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
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
// See docs/cache-policy.md and upstream opencode#26786.
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


// A trailing assistant "prefill" — a conversation ending with an assistant
// message the model would continue from — is a pattern some backends (notably
// the Bedrock Converse API) hard-400 on: "This model does not support assistant
// message prefill. The conversation must end with a user message." Our harness
// never *intends* to steer output with a prefill; a trailing assistant on the
// wire is always residue: an interrupted generation, an invalid-output/text-tool
// recovery turn, or a completed reply that a re-entry path (a ReAct step or a
// resumed/continued turn — see session/prompt.ts request assembly) sent without
// appending a following user turn.
//
// The original fix here dropped the trailing assistant run UNCONDITIONALLY. That
// is unsafe: when the trailing assistant is a COMPLETED, content-bearing reply
// (which is exactly the organic case that produced the live Bedrock 400), a bare
// drop DELETES that reply's content from the request. Losing a real answer from
// the transcript is worse than the 400 it avoids.
//
// The safe fix keeps every message and instead APPENDS a minimal continuation
// user turn so the conversation ends with a user message without discarding any
// content. At this choke point we only have `ModelMessage` (role + content); the
// `finish`/`error` completeness metadata lives upstream on `MessageV2.Assistant`
// and isn't visible here, so we can't tell "incomplete residue" from "completed
// reply" — appending is the content-preserving choice for both. A truly empty
// trailing assistant (no text and no tool-call — pure residue with nothing to
// preserve) is dropped instead, since there is no content to keep.
//
// A trailing *tool* message is left untouched: providers accept a conversation
// ending in a tool result (it is the observation half of a tool call), and it is
// not an assistant prefill.
const CONTINUATION_PROMPT = "Continue."

// True when an assistant ModelMessage carries no renderable content (no text and
// no tool-call) — pure residue we can drop without losing anything.
function isEmptyAssistant(msg: ModelMessage): boolean {
  if (msg.role !== "assistant") return false
  if (typeof msg.content === "string") return msg.content.trim() === ""
  if (!Array.isArray(msg.content)) return true
  // Only text and tool-call count as preservable content. A reasoning-only or
  // step-start-only trailing assistant is residue (the model never emitted a
  // final answer or a tool call) — matching MessageV2.toModelMessages, which
  // skips an aborted assistant that carries only step-start/reasoning parts.
  return !msg.content.some(
    (part) => (part.type === "text" && part.text.trim() !== "") || part.type === "tool-call",
  )
}

// Pre-send guard: guarantee the conversation never ends with an assistant
// (prefill) message that a provider like Bedrock rejects, WITHOUT deleting a
// completed reply's content. Empty trailing assistants (residue) are dropped;
// any content-bearing trailing assistant is preserved and a minimal continuation
// user turn is appended so the list ends with a user message. Runs at the
// pre-send choke point in `message()`, so it also self-heals history that
// already ends in an assistant turn.
export function ensureTrailingUserMessage(msgs: ModelMessage[]): ModelMessage[] {
  // Drop only trailing EMPTY assistant residue (nothing to preserve).
  let end = msgs.length
  while (end > 0 && isEmptyAssistant(msgs[end - 1])) end--
  const trimmed = end === msgs.length ? msgs : msgs.slice(0, end)
  const last = trimmed[trimmed.length - 1]
  // Already ends with user or tool (or empty) — safe to send as-is.
  if (!last || last.role !== "assistant") return trimmed
  // A content-bearing assistant is legitimately last: keep it and append a
  // minimal user turn so the request ends with a user message.
  return [...trimmed, { role: "user", content: CONTINUATION_PROMPT }]
}

// Hard prune of the trailing assistant run, discarding its content. Unlike
// `ensureTrailingUserMessage` this DOES delete content, so it is used only by the
// reactive backstop in session/llm.ts — after a provider has already returned the
// deterministic prefill-rejection 400 for a request the proactive guard did not
// (or could not) neutralize. In that last-resort case dropping is preferable to
// re-failing, and it is exported for that single consumer.
export function dropTrailingAssistantPrefill(msgs: ModelMessage[]): ModelMessage[] {
  let end = msgs.length
  while (end > 0 && msgs[end - 1].role === "assistant") end--
  if (end === msgs.length) return msgs
  return msgs.slice(0, end)
}

// Signature of the non-retryable 400 a Bedrock Converse backend returns when the
// conversation ends with an assistant (prefill) message. The primary defense is
// the proactive `ensureTrailingUserMessage` guard in `message()`, so we should
// never send a trailing assistant prefill in the first place. This regex backs
// the reactive backstop in session/llm.ts: if any path still slips a trailing
// assistant through to the wire (e.g. a provider-side transform re-adds one) and
// the backend rejects it, we detect the rejection and reprune. The error body
// reads:
//   "This model does not support assistant message prefill. The conversation
//    must end with a user message." (Service: BedrockRuntime)
// Matching the deterministic failure text is provider-agnostic: it works
// regardless of gateway naming, providerID, or model-id namespace. We inspect
// both the error message and the raw response body, case-insensitively, and key
// only on the specific prefill-rejection phrase — not all 400s.
const ASSISTANT_PREFILL_REJECTION = /does not support assistant message prefill|must end with a user message/i

export function isAssistantPrefillRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { message?: unknown; responseBody?: unknown; statusCode?: unknown }
  const status = typeof e.statusCode === "string" ? Number.parseInt(e.statusCode, 10) : e.statusCode
  // The prefill rejection is always a 400; require it so an unrelated error that
  // happens to echo the phrase (e.g. our own log line) can't trigger a reprune.
  if (typeof status === "number" && !Number.isNaN(status) && status !== 400) return false
  const haystack = [
    typeof e.message === "string" ? e.message : "",
    typeof e.responseBody === "string" ? e.responseBody : "",
  ].join("\n")
  return ASSISTANT_PREFILL_REJECTION.test(haystack)
}

// The cache-control marker shape differs per provider/SDK. This is the single
// source of truth, keyed by the SDK provider-options namespace. `applyCaching`
// attaches the whole object (keyed by stored providerID) and lets `message()`
// remap the active provider's namespace to its SDK key; `tools()` (which
// bypasses that remap) resolves a single namespace up front via `cacheMarkerFor`.
// Only Anthropic and OpenRouter expose a TTL in their AI SDK — the others ignore
// an unknown `ttl`, so we thread it only there.
function cacheMarkerOptions(model: Provider.Model) {
  const ttl = model.cachePromptTTL === "1h" ? { ttl: "1h" as const } : {}
  return {
    anthropic: { cacheControl: { type: "ephemeral", ...ttl } },
    openrouter: { cacheControl: { type: "ephemeral", ...ttl } },
    bedrock: { cachePoint: { type: "default" } },
    openaiCompatible: { cache_control: { type: "ephemeral" } },
    copilot: { copilot_cache_control: { type: "ephemeral" } },
    alibaba: { cacheControl: { type: "ephemeral" } },
  }
}

// Resolve the marker for a single model, already keyed under the SDK namespace
// the AI SDK expects — i.e. the remap that `message()` performs for messages,
// done up front. Used by `tools()`, whose tools never pass through `message()`.
// Returns undefined for providers that don't take inline markers (callers gate
// on `supportsCacheMarkers` first, so this is just a type-safety fallback).
function cacheMarkerFor(model: Provider.Model): Record<string, unknown> | undefined {
  const shapes = cacheMarkerOptions(model)
  const ns: keyof typeof shapes | undefined =
    model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic"
      ? "anthropic"
      : model.api.npm === "@openrouter/ai-sdk-provider"
        ? "openrouter"
        : model.api.npm === "@ai-sdk/amazon-bedrock"
          ? "bedrock"
          : model.api.npm === "@ai-sdk/github-copilot"
            ? "copilot"
            : model.api.npm === "@ai-sdk/alibaba"
              ? "alibaba"
              : undefined
  if (!ns) return undefined
  return { [ns]: shapes[ns] }
}

function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const providerOptions = cacheMarkerOptions(model)

  // Strategy: prefix caching is longest-common-prefix based with a backward
  // lookback window (Anthropic walks back ~20 blocks from a breakpoint to find
  // a prior write). The markers that grow the cached prefix are pinned to the
  // *tail* of the request. We place up to three stable breakpoints (Anthropic
  // allows max 4):
  // 1. Last system message — the immutable prompt prefix.
  // 2+3. The last TWO messages — a "rolling double buffer". Each turn marks
  //      messages[-2] and messages[-1]; next turn the old [-1] is now [-2] and
  //      still carries its marker, so the lookback gets a cache READ hit, while
  //      the new [-1] is the WRITE for the turn after.
  //
  //      Why two and not one: the second (next-to-last) marker is the safety
  //      net for the tail boundary. When the last message is removed — a
  //      tool-call retry, a Ctrl-C, or the user editing/deleting their latest
  //      message — a lone tail marker disappears with it, and how much of the
  //      surrounding prefix the provider then evicts depends on the upstream
  //      (Anthropic) KV-cache implementation. The next-to-last marker is a
  //      still-present, further-back write the next lookback can land on, so the
  //      worst case degrades to "recompute only the removed message" instead of
  //      "recompute the whole history". It also covers turns that append >20
  //      blocks (tool spam pushes the prior write outside the lookback window).
  //      Cost is ~equal to a single marker: the two adjacent breakpoints write
  //      roughly the same incremental bytes as one, split in two, and a hit
  //      never rewrites. A third marker would write a segment never read
  //      independently, so two is the minimum that covers the boundary.
  // We deliberately do NOT mark a drifting midpoint or a fixed before-last-user
  // INDEX: those shift every turn without tracking the tail.
  const targets: ModelMessage[] = []

  const systemMsgs = msgs.filter((msg) => msg.role === "system")
  if (systemMsgs.length > 0) targets.push(systemMsgs[systemMsgs.length - 1])

  const nonSystem = msgs.filter((msg) => msg.role !== "system")
  for (const msg of nonSystem.slice(-2)) targets.push(msg)

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
      const supported = model.capabilities.input[modality]
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

// Decoded byte count of raw base64. Mirrors what the provider measures against
// its 5 MB image limit.
function base64ByteSize(base64: string): number {
  if (!base64) return 0
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

// Split a data URL into its mime + raw base64. Returns undefined for anything
// that isn't a base64 data URL.
function parseDataUrl(image: string): { mime: string; base64: string } | undefined {
  if (!image.startsWith("data:")) return undefined
  const comma = image.indexOf(",")
  if (comma === -1) return undefined
  const mime = image.slice(5, image.indexOf(";") === -1 ? comma : image.indexOf(";"))
  return { mime, base64: image.slice(comma + 1) }
}

type ImagePayload =
  | { kind: "data-url" | "base64"; mime?: string; base64: string; size: number }
  | { kind: "bytes"; mime?: string; bytes: Uint8Array; size: number }

function isRawBase64(value: string) {
  if (!value || value.length % 4 === 1) return false
  return /^[a-z0-9+/_-]+={0,2}$/i.test(value)
}

function compactBase64(value: string) {
  return value.replace(/[\t\n\f\r ]/g, "")
}

// AI SDK normalizes user files before middleware runs: data URLs become raw
// base64 strings, binary DataContent becomes Uint8Array, and remote URLs remain
// URL objects. Accept the pre-conversion data-URL shape too because tests and
// a few internal callers still pass ModelMessage values directly.
function imagePayload(value: unknown, mediaType?: string): ImagePayload | undefined {
  if (value instanceof URL) return undefined
  if (typeof value === "string") {
    const parsed = parseDataUrl(value)
    if (parsed) {
      const base64 = compactBase64(parsed.base64)
      if (!isRawBase64(base64)) return undefined
      return {
        kind: "data-url",
        mime: parsed.mime || mediaType,
        base64,
        size: base64ByteSize(base64),
      }
    }

    const base64 = compactBase64(value)
    if (!isRawBase64(base64)) return undefined
    return { kind: "base64", mime: mediaType, base64, size: base64ByteSize(base64) }
  }

  const bytes =
    value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined
  if (!bytes) return undefined
  return { kind: "bytes", mime: mediaType, bytes, size: bytes.byteLength }
}

// Bring one oversized image under maxSize: recompress if we can decode it,
// otherwise return undefined so the caller strips it to a text placeholder.
// Never returns something still over the limit.
function shrinkBase64(
  mime: string,
  base64: string,
  maxSize: number,
): { mime: string; base64: string } | undefined {
  const compressed = compressImage(mime, Buffer.from(base64, "base64"), maxSize)
  if (compressed && base64ByteSize(compressed.data) <= maxSize) {
    return { mime: compressed.mediaType, base64: compressed.data }
  }
  return undefined
}

const OVERSIZE_PLACEHOLDER = (size: number, maxSize: number) =>
  `[Image omitted: ${size} bytes exceeds the ${maxSize}-byte limit and could not be compressed.]`

// Per-provider inline-image byte cap. Only Anthropic and Bedrock reject a single
// image whose decoded base64 exceeds ~5 MB with a non-retryable 400 — that is the
// limit DEFAULT_MAX_IMAGE_BYTES is tuned to. Every other provider we route to
// accepts larger images, so capping them just wastes cycles recompressing and
// degrades quality for no reason. Returns Infinity (no cap) for those.
//
// Detection mirrors supportsCacheMarkers: match the Anthropic/Bedrock SDKs and
// providerIDs directly, and for multi-model gateways (gateway/openrouter/copilot)
// only the Claude/Anthropic models — a Claude behind a gateway still terminates
// at the Anthropic API and inherits its 5 MB limit.
function providerImageCap(model: Provider.Model): number {
  const npm = model.api.npm
  if (
    npm === "@ai-sdk/anthropic" ||
    npm === "@ai-sdk/google-vertex/anthropic" ||
    npm === "@ai-sdk/amazon-bedrock"
  )
    return DEFAULT_MAX_IMAGE_BYTES
  if (
    model.providerID === "anthropic" ||
    model.providerID === "google-vertex-anthropic" ||
    model.providerID.includes("bedrock")
  )
    return DEFAULT_MAX_IMAGE_BYTES
  if (
    npm === "@ai-sdk/gateway" ||
    npm === "@openrouter/ai-sdk-provider" ||
    npm === "@ai-sdk/github-copilot"
  ) {
    const routesToAnthropic =
      model.api.id.includes("claude") ||
      model.api.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.id.includes("anthropic")
    if (routesToAnthropic) return DEFAULT_MAX_IMAGE_BYTES
  }
  return Infinity
}

// Two responsibilities:
// 1. Count cap (maxImages): drop the oldest excess *user* prompt images,
//    including image-typed `file` parts produced by synthetic tool attachments.
// 2. Size cap (maxSize): for EVERY image the provider would measure — user
//    `image`/image-`file` parts AND tool-result `media`/`image-data`/`file-data`
//    parts on tool/assistant messages — recompress oversized ones under the
//    limit, or strip them to a text placeholder.
//
// The size cap is PROVIDER-AWARE (providerImageCap): only Anthropic/Bedrock have
// the ~5 MB hard limit, so only they get DEFAULT_MAX_IMAGE_BYTES; other providers
// get Infinity (untouched). An explicit Flag.MIMOCODE_MAX_PROMPT_IMAGE_SIZE always
// wins when set.
//
// For the capped providers the size cap runs by default (no flag needed) because a
// single >5 MB image in history otherwise 400s on every subsequent request and
// permanently wedges the session — a non-retryable client error. Stripping/
// compressing it in transform, which runs immediately before send, self-heals such
// "poison" history (including images already sitting in history / tool_result).
function limitImages(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  const maxImages = Flag.MIMOCODE_MAX_PROMPT_IMAGES
  const maxSize = Flag.MIMOCODE_MAX_PROMPT_IMAGE_SIZE ?? providerImageCap(model)

  // Zero-allocation fast path: with no image-count cap and no size cap there is
  // nothing to drop or shrink, so return the messages untouched instead of
  // rebuilding every tool-result content object on each send.
  if (maxImages === undefined && maxSize === Infinity) return msgs

  const total = msgs.reduce(
    (sum, msg) =>
      msg.role === "user" && Array.isArray(msg.content)
        ? sum +
          msg.content.filter(
            (part) => part.type === "image" || (part.type === "file" && part.mediaType.startsWith("image/")),
          ).length
        : sum,
    0,
  )
  // Drop the oldest excess images so the most recent ones reach the model.
  let toDrop = maxImages === undefined ? 0 : Math.max(0, total - maxImages)

  // The provider content shape for tool-result output values is untyped in the
  // AI SDK, so we narrow the one variant we act on: base64 image bytes carried
  // as `media` / `image-data` / `file-data`. Anything else is passed through.
  type MediaEntry = { type: "media" | "image-data" | "file-data"; data: string; mediaType: string }
  const isImageMediaEntry = (entry: unknown): entry is MediaEntry => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return (
      (e.type === "media" || e.type === "image-data" || e.type === "file-data") &&
      typeof e.data === "string" &&
      typeof e.mediaType === "string" &&
      e.mediaType.startsWith("image/")
    )
  }

  // Enforce the byte-size cap on one tool-result content entry. Rewrites the
  // media bytes in place when we can recompress, otherwise swaps it for a text
  // entry so the oversized payload never reaches the provider.
  const capToolMedia = (entry: unknown) => {
    if (!isImageMediaEntry(entry)) return entry
    const size = base64ByteSize(entry.data)
    if (size <= maxSize) return entry
    const shrunk = shrinkBase64(entry.mediaType, entry.data, maxSize)
    if (shrunk) return { ...entry, data: shrunk.base64, mediaType: shrunk.mime }
    return { type: "text" as const, text: OVERSIZE_PLACEHOLDER(size, maxSize) }
  }

  return msgs.map((msg) => {
    if (!Array.isArray(msg.content)) return msg

    // Tool-result images live on tool/assistant messages, not user messages.
    // The SDK's tool-result `output.value` union is opaque, so this branch stays
    // loosely typed for reconstruction — the typed narrowing happens in
    // `capToolMedia`/`isImageMediaEntry` on each entry.
    if (msg.role === "tool" || msg.role === "assistant") {
      const content = msg.content.map((part: any) => {
        if (part?.type !== "tool-result") return part
        const output = part.output
        if (!output || output.type !== "content" || !Array.isArray(output.value)) return part
        return { ...part, output: { ...output, value: output.value.map(capToolMedia) } }
      })
      return { ...msg, content }
    }

    if (msg.role !== "user") return msg
    const content = msg.content.map((part) => {
      const isImageFile = part.type === "file" && part.mediaType.startsWith("image/")
      if (part.type !== "image" && !isImageFile) return part
      if (toDrop > 0) {
        toDrop--
        return {
          type: "text" as const,
          text: `[Image omitted: exceeds the configured limit of ${maxImages} prompt image(s).]`,
        }
      }
      const payload = imagePayload(
        part.type === "image" ? part.image : part.data,
        part.mediaType,
      )
      if (!payload || payload.size <= maxSize) return part
      if (payload.mime?.startsWith("image/")) {
        const base64 =
          payload.kind === "bytes"
            ? Buffer.from(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength).toString("base64")
            : payload.base64
        const shrunk = shrinkBase64(payload.mime, base64, maxSize)
        if (shrunk) {
          const data =
            payload.kind === "data-url"
              ? `data:${shrunk.mime};base64,${shrunk.base64}`
              : payload.kind === "bytes"
                ? new Uint8Array(Buffer.from(shrunk.base64, "base64"))
                : shrunk.base64
          return part.type === "image"
            ? { ...part, image: data, mediaType: shrunk.mime }
            : { ...part, data, mediaType: shrunk.mime }
        }
      }
      return { type: "text" as const, text: OVERSIZE_PLACEHOLDER(payload.size, maxSize) }
    })
    return { ...msg, content }
  })
}

function mapProviderOptions(
  msgs: ModelMessage[],
  transform: (options: Record<string, any> | undefined) => Record<string, any> | undefined,
): ModelMessage[] {
  return msgs.map((msg) => {
    if (!Array.isArray(msg.content)) return { ...msg, providerOptions: transform(msg.providerOptions) }
    return {
      ...msg,
      providerOptions: transform(msg.providerOptions),
      content: msg.content.map((part) =>
        part.type === "tool-approval-request" || part.type === "tool-approval-response"
          ? part
          : { ...part, providerOptions: transform(part.providerOptions) },
      ),
    } as typeof msg
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
  msgs = unsupportedParts(msgs, model)
  msgs = limitImages(msgs, model)
  msgs = normalizeMessages(msgs, model, options)
  // SAFE prefill guard: never let the request end with an assistant (prefill)
  // message a provider (e.g. Bedrock) would reject, without deleting a completed
  // reply. Drops only empty residue; appends a continuation user turn otherwise.
  msgs = ensureTrailingUserMessage(msgs)
  if (supportsCacheMarkers(model)) {
    msgs = applyCaching(msgs, model)
  }

  // Remap providerOptions keys from stored providerID to expected SDK key
  const key = sdkKey(model.api.npm)
  if (key && key !== model.providerID) {
    msgs = mapProviderOptions(msgs, (opts) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    })
  }

  // Strip Responses item IDs before serialization, following Codex and keeping
  // signed request bodies immutable. Removing `itemId` here (rather than mutating
  // the already-serialized fetch body) lets the SDK build a clean request that
  // works against proxies which validate reasoning `rs_` references. Only applies
  // to stateless (store !== true) OpenAI Responses-family providers.
  if (options.store !== true && key && ["@ai-sdk/openai", "@ai-sdk/azure"].includes(model.api.npm)) {
    msgs = mapProviderOptions(msgs, (opts) => {
      if (!opts?.[key] || !("itemId" in opts[key])) return opts
      const metadata = { ...opts[key] }
      delete metadata.itemId
      return { ...opts, [key]: metadata }
    })
  }

  return msgs
}

// Place a cache breakpoint on the tool definitions. The cache hierarchy is
// `tools` → `system` → `messages`, so marking the LAST tool caches the entire
// tool-schema block (often several KB) as a stable prefix that sits in front of
// the system + message caches. Tools are passed to the SDK separately from
// `message()` and never go through its providerID→SDK-key remap, so we resolve
// the SDK-keyed marker via `cacheMarkerFor`. Tool registration order is stable
// (insertion order of the tools record), so "last tool" is deterministic.
export function tools<T extends Record<string, any>>(tools: T, model: Provider.Model): T {
  if (!supportsCacheMarkers(model)) return tools
  const marker = cacheMarkerFor(model)
  if (!marker) return tools
  const names = Object.keys(tools)
  if (names.length === 0) return tools

  const last = tools[names[names.length - 1]]
  last.providerOptions = mergeDeep(last.providerOptions ?? {}, marker)
  return tools
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
      // Responses API with store:false is stateless, so encrypted reasoning
      // items must be echoed back on the next turn. Without requesting them via
      // `include`, gpt-5.x returns reasoning-only/empty steps on tool loops,
      // which classify.ts flags as "empty output". Match upstream opencode.
      if (input.model.api.npm === "@ai-sdk/openai") {
        result["include"] = ["reasoning.encrypted_content"]
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
    // Match the main-model path: request encrypted reasoning so store:false
    // stays round-trippable if a small-model call ever runs a tool loop.
    const include = model.api.npm === "@ai-sdk/openai" ? { include: ["reasoning.encrypted_content"] } : {}
    if (model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.") || model.api.id.includes("5-mini")) {
        return { store: false, reasoningEffort: "low", ...include }
      }
      return { store: false, reasoningEffort: "minimal", ...include }
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

// Models served by Moonshot AI (Kimi). Matched on both the provider id
// (moonshotai, moonshotai-cn, kimi-for-coding, …) and the model id (kimi-*), so
// Kimi models reached through a gateway/proxy still get the schema fixup below.
function isMoonshot(model: Provider.Model): boolean {
  const provider = model.providerID.toLowerCase()
  const apiID = model.api.id.toLowerCase()
  return (
    provider.includes("moonshot") ||
    provider.includes("kimi") ||
    apiID.includes("moonshot") ||
    apiID.includes("kimi")
  )
}

// Moonshot's "flavored" JSON-schema validator rejects a tool-parameter node that
// carries a `type` as a sibling of an `anyOf`: it wants the type inside each
// `anyOf` item instead. Our discriminated-union tool parameters
// (task/actor/cron/session `operation`, declared as
// `z.discriminatedUnion(...).meta({ type: "object" })`) serialize to
// `{ type: "object", anyOf: [...] }`, so Moonshot 400s with:
//   "when using anyOf, type should be defined in anyOf items instead of the parent schema"
// Push the parent `type` into any item that lacks its own, then drop the parent
// `type` — the variants already declare `type: "object"`, so this removes only
// the redundant, rejected parent keyword and preserves the schema's meaning.
// `oneOf` is normalized the same way defensively (some SDKs, e.g.
// `@ai-sdk/anthropic` used by kimi-for-coding, rewrite `oneOf` → `anyOf`).
// Scoped to Moonshot/Kimi so the parent `type` other models rely on (e.g.
// mimo-v2.5-pro / MiniMax-M3, which stringify the whole envelope without it —
// see #1371) stays intact.
function sanitizeMoonshot(node: any): any {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(sanitizeMoonshot)

  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(node)) result[key] = sanitizeMoonshot(value)

  const combiner = (["anyOf", "oneOf"] as const).find((key) => Array.isArray(result[key]))
  if (combiner && "type" in result) {
    const parentType = result.type
    result[combiner] = result[combiner].map((item: any) =>
      item !== null && typeof item === "object" && !Array.isArray(item) && !("type" in item)
        ? { type: parentType, ...item }
        : item,
    )
    delete result.type
  }

  return result
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

  // Moonshot/Kimi reject a sibling `type` next to an `anyOf` in tool schemas;
  // normalize those nodes so our discriminated-union tools pass their validator.
  if (isMoonshot(model)) {
    schema = sanitizeMoonshot(schema)
  }

  return schema as JSONSchema7
}
