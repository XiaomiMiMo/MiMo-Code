import { EventStreamCodec } from "@smithy/eventstream-codec"
import { ProviderHelper, CommonRequest, CommonResponse, CommonChunk } from "./provider"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"

type Usage = {
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  input_tokens?: number
  output_tokens?: number
  server_tool_use?: {
    web_search_requests?: number
  }
}

// ---- Anthropic API request/response types ----
// Pragmatic interfaces covering fields actually accessed by the converters.

interface AnthSource {
  type?: string
  url?: string
  media_type?: string
  data?: string
}

interface AnthContentPart {
  type?: string
  text?: string
  source?: AnthSource
  tool_use_id?: string
  content?: string | object
  name?: string
  id?: string
  input?: object
}

interface AnthMessage {
  role?: string
  content?: string | AnthContentPart[]
}

interface AnthTool {
  name?: string
  description?: string
  input_schema?: object
}

interface AnthToolChoice {
  type?: string
  name?: string
}

interface AnthropicRequestBody {
  model?: string
  system?: Array<{ type?: string; text?: string }>
  messages?: AnthMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop_sequences?: string | string[]
  stream?: boolean
  tools?: AnthTool[]
  tool_choice?: AnthToolChoice
}

interface AnthResponse {
  type?: string
  id?: string
  model?: string
  stop_reason?: string
  content?: AnthContentPart[]
  usage?: Usage
}

interface AnthChunk {
  type?: string
  id?: string
  model?: string
  delta?: { type?: string; text?: string; stop_reason?: string; partial_json?: string }
  content_block?: { type?: string; id?: string; name?: string; text?: string }
  index?: number
  message?: { id?: string; model?: string; usage?: Usage }
  usage?: Usage
  response?: AnthResponse
}

export const anthropicHelper: ProviderHelper = ({ reqModel, providerModel }) => {
  const isBedrockModelArn = providerModel.startsWith("arn:aws:bedrock:")
  const isBedrockModelID = providerModel.startsWith("global.anthropic.")
  const isBedrock = isBedrockModelArn || isBedrockModelID
  const isDatabricks = providerModel.startsWith("databricks-claude-")
  const supports1m = reqModel.includes("sonnet") || reqModel.includes("opus-4-6")
  return {
    format: "anthropic",
    modifyUrl: (providerApi: string, isStream?: boolean) =>
      isBedrock
        ? `${providerApi}/model/${isBedrockModelArn ? encodeURIComponent(providerModel) : providerModel}/${isStream ? "invoke-with-response-stream" : "invoke"}`
        : providerApi + "/messages",
    modifyHeaders: (headers: Headers, body: Record<string, any>, apiKey: string) => {
      if (isBedrock || isDatabricks) {
        headers.set("Authorization", `Bearer ${apiKey}`)
      } else {
        headers.set("x-api-key", apiKey)
        headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01")
        if (supports1m) {
          headers.set("anthropic-beta", "context-1m-2025-08-07")
        }
      }
    },
    modifyBody: (body: Record<string, any>) => ({
      ...body,
      ...(isBedrock
        ? {
            anthropic_version: "bedrock-2023-05-31",
            anthropic_beta: supports1m ? ["context-1m-2025-08-07"] : undefined,
            model: undefined,
            stream: undefined,
          }
        : isDatabricks
          ? {
              anthropic_version: "bedrock-2023-05-31",
              anthropic_beta: supports1m ? ["context-1m-2025-08-07"] : undefined,
            }
          : {
              service_tier: "standard_only",
            }),
    }),
    createBinaryStreamDecoder: () => {
      if (!isBedrock) return undefined

      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      const codec = new EventStreamCodec(toUtf8, fromUtf8)
      let buffer = new Uint8Array(0)
      return (value: Uint8Array) => {
        const newBuffer = new Uint8Array(buffer.length + value.length)
        newBuffer.set(buffer)
        newBuffer.set(value, buffer.length)
        buffer = newBuffer

        const messages = []
        while (buffer.length >= 4) {
          // first 4 bytes are the total length (big-endian)
          const totalLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false)

          // wait for more chunks
          if (buffer.length < totalLength) break

          try {
            const subView = buffer.subarray(0, totalLength)
            const decoded = codec.decode(subView)
            buffer = buffer.slice(totalLength)

            /* Example of Bedrock data
      ```
        {
          bytes: 'eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsibW9kZWwiOiJjbGF1ZGUtb3B1cy00LTUtMjAyNTExMDEiLCJpZCI6Im1zZ19iZHJrXzAxMjVGdHRGb2lkNGlwWmZ4SzZMbktxeCIsInR5cGUiOiJtZXNzYWdlIiwicm9sZSI6ImFzc2lzdGFudCIsImNvbnRlbnQiOltdLCJzdG9wX3JlYXNvbiI6bnVsbCwic3RvcF9zZXF1ZW5jZSI6bnVsbCwidXNhZ2UiOnsiaW5wdXRfdG9rZW5zIjo0LCJjYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMiOjEsImNhY2hlX3JlYWRfaW5wdXRfdG9rZW5zIjoxMTk2MywiY2FjaGVfY3JlYXRpb24iOnsiZXBoZW1lcmFsXzVtX2lucHV0X3Rva2VucyI6MSwiZXBoZW1lcmFsXzFoX2lucHV0X3Rva2VucyI6MH0sIm91dHB1dF90b2tlbnMiOjF9fX0=',
          p: '...'
        }
      ```

      Decoded bytes
      ```
        {
          type: 'message_start',
          message: {
            model: 'claude-opus-4-5-20251101',
            id: 'msg_bdrk_0125FttFoid4ipZfxK6LnKqx',
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 4,
              cache_creation_input_tokens: 1,
              cache_read_input_tokens: 11963,
              cache_creation: [Object],
              output_tokens: 1
            }
          }
        }
      ```
      */

            /* Example of Anthropic data
      ```
        event: message_delta
        data: {"type":"message_start","message":{"model":"claude-opus-4-5-20251101","id":"msg_01ETvwVWSKULxzPdkQ1xAnk2","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":11543,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":11543,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard"}}}
      ```
      */
            if (decoded.headers[":message-type"]?.value === "event") {
              const data = decoder.decode(decoded.body, { stream: true })

              const parsedDataResult = JSON.parse(data)
              delete parsedDataResult.p
              const binary = atob(parsedDataResult.bytes)
              const uint8 = Uint8Array.from(binary, (c) => c.charCodeAt(0))
              const bytes = decoder.decode(uint8)
              const eventName = JSON.parse(bytes).type
              messages.push([`event: ${eventName}`, "\n", `data: ${bytes}`, "\n\n"].join(""))
            }
          } catch (e) {
            console.log("@@@EE@@@")
            console.log(e)
            break
          }
        }
        return encoder.encode(messages.join(""))
      }
    },
    streamSeparator: "\n\n",
    createUsageParser: () => {
      let usage: Usage

      return {
        parse: (chunk: string) => {
          const data = chunk.split("\n")[1]
          if (!data.startsWith("data: ")) return

          let json
          try {
            json = JSON.parse(data.slice(6))
          } catch {
            return
          }

          const usageUpdate = json.usage ?? json.message?.usage
          if (!usageUpdate) return
          usage = {
            ...usage,
            ...usageUpdate,
            cache_creation: {
              ...usage?.cache_creation,
              ...usageUpdate.cache_creation,
            },
            server_tool_use: {
              ...usage?.server_tool_use,
              ...usageUpdate.server_tool_use,
            },
          }
        },
        retrieve: () => usage,
      }
    },
    normalizeUsage: (usage: Usage) => ({
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      reasoningTokens: undefined,
      cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
      cacheWrite5mTokens:
        usage.cache_creation?.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? undefined,
      cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? undefined,
    }),
  }
}

export function fromAnthropicRequest(body: AnthropicRequestBody): CommonRequest {
  if (!body || typeof body !== "object") return body

  const msgs: any[] = []

  const sys = Array.isArray(body.system) ? body.system : undefined
  if (sys && sys.length > 0) {
    for (const s of sys) {
      if (!s) continue
      if (s.type !== "text") continue
      if (typeof s.text !== "string") continue
      if (s.text.length === 0) continue
      msgs.push({ role: "system", content: s.text })
    }
  }

  const toImg = (src: AnthSource | undefined) => {
    if (!src || typeof src !== "object") return undefined
    if (src.type === "url" && typeof src.url === "string") return { type: "image_url", image_url: { url: src.url } }
    if (src.type === "base64" && typeof src.media_type === "string" && typeof src.data === "string")
      return {
        type: "image_url",
        image_url: { url: `data:${src.media_type};base64,${src.data}` },
      }
    return undefined
  }

  const inMsgs: AnthMessage[] = Array.isArray(body.messages) ? body.messages : []
  for (const m of inMsgs) {
    if (!m || !m.role) continue

    if (m.role === "user") {
      const partsIn = Array.isArray(m.content) ? m.content : []
      const partsOut: any[] = []
      for (const p of partsIn) {
        if (!p || !p.type) continue
        if (p.type === "text" && typeof p.text === "string") partsOut.push({ type: "text", text: p.text })
        if (p.type === "image") {
          const ip = toImg(p.source)
          if (ip) partsOut.push(ip)
        }
        if (p.type === "tool_result") {
          const id = p.tool_use_id
          const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content)
          msgs.push({ role: "tool", tool_call_id: id, content })
        }
      }
      if (partsOut.length > 0) {
        if (partsOut.length === 1 && partsOut[0].type === "text") msgs.push({ role: "user", content: partsOut[0].text })
        else msgs.push({ role: "user", content: partsOut })
      }
      continue
    }

    if (m.role === "assistant") {
      const partsIn = Array.isArray(m.content) ? m.content : []
      const texts: string[] = []
      const tcs: any[] = []
      for (const p of partsIn) {
        if (!p || !p.type) continue
        if (p.type === "text" && typeof p.text === "string") texts.push(p.text)
        if (p.type === "tool_use") {
          const name = p.name
          const id = p.id
          const inp = p.input
          const input = (() => {
            if (typeof inp === "string") return inp
            try {
              return JSON.stringify(inp ?? {})
            } catch {
              return String(inp ?? "")
            }
          })()
          tcs.push({ id, type: "function", function: { name, arguments: input } })
        }
      }
      const out: any = { role: "assistant", content: texts.join("") }
      if (tcs.length > 0) out.tool_calls = tcs
      msgs.push(out)
      continue
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t) => t && typeof t === "object" && "input_schema" in t)
        .map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }))
    : undefined

  const tcin = body.tool_choice
  const tc = (() => {
    if (!tcin) return undefined
    if (tcin.type === "auto") return "auto"
    if (tcin.type === "any") return "required"
    if (tcin.type === "tool" && typeof tcin.name === "string")
      return { type: "function" as const, function: { name: tcin.name } }
    return undefined
  })()

  const stop = (() => {
    const v = body.stop_sequences
    if (!v) return undefined
    if (Array.isArray(v)) return v.length === 1 ? v[0] : v
    if (typeof v === "string") return v
    return undefined
  })()

  return {
    model: body.model ?? "",
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop,
    messages: msgs,
    stream: !!body.stream,
    tools: tools as CommonRequest["tools"],
    tool_choice: tc,
  }
}

export function toAnthropicRequest(body: CommonRequest) {
  if (!body || typeof body !== "object") return body

  const sysIn = Array.isArray(body.messages) ? body.messages.filter((m: any) => m && m.role === "system") : []
  let ccCount = 0
  const cc = () => {
    ccCount++
    return ccCount <= 4 ? { cache_control: { type: "ephemeral" } } : {}
  }
  const system = sysIn
    .filter((m: any) => typeof m.content === "string" && m.content.length > 0)
    .map((m: any) => ({ type: "text", text: m.content, ...cc() }))

  const msgsIn = Array.isArray(body.messages) ? body.messages : []
  const msgsOut: any[] = []

  const toSrc = (p: { type?: string; image_url?: { url: string } | string }) => {
    if (!p || typeof p !== "object") return undefined
    if (p.type === "image_url" && p.image_url) {
      const u = typeof p.image_url === "string" ? p.image_url : p.image_url.url
      if (typeof u === "string" && u.startsWith("data:")) {
        const m = u.match(/^data:([^;]+);base64,(.*)$/)
        if (m) return { type: "base64", media_type: m[1], data: m[2] }
      }
      if (typeof u === "string") return { type: "url", url: u }
    }
    return undefined
  }

  for (const m of msgsIn) {
    if (!m || !m.role) continue

    if (m.role === "user") {
      if (typeof m.content === "string") {
        msgsOut.push({
          role: "user",
          content: [{ type: "text", text: m.content, ...cc() }],
        })
      } else if (Array.isArray(m.content)) {
        const parts: any[] = []
        for (const p of m.content) {
          if (!p || !p.type) continue
          if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text, ...cc() })
          if (p.type === "image_url") {
            const s = toSrc(p)
            if (s) parts.push({ type: "image", source: s, ...cc() })
          }
        }
        if (parts.length > 0) msgsOut.push({ role: "user", content: parts })
      }
      continue
    }

    if (m.role === "assistant") {
      const out: { role: string; content: any[] } = { role: "assistant", content: [] }
      if (typeof m.content === "string" && m.content.length > 0) {
        out.content.push({ type: "text", text: m.content, ...cc() })
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.type === "function" && tc.function) {
            let input: any
            const a = tc.function.arguments
            if (typeof a === "string") {
              try {
                input = JSON.parse(a)
              } catch {
                input = a
              }
            } else input = a
            const id = tc.id || `toolu_${Math.random().toString(36).slice(2)}`
            out.content.push({
              type: "tool_use",
              id,
              name: tc.function.name,
              input,
              ...cc(),
            })
          }
        }
      }
      if (out.content.length > 0) msgsOut.push(out)
      continue
    }

    if (m.role === "tool") {
      msgsOut.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
            ...cc(),
          },
        ],
      })
      continue
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t) => t && typeof t === "object" && t.type === "function")
        .map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
          ...cc(),
        }))
    : undefined

  const tcIn = body.tool_choice
  const tool_choice = (() => {
    if (!tcIn) return undefined
    if (tcIn === "auto") return { type: "auto" }
    if (tcIn === "required") return { type: "any" }
    if (typeof tcIn !== "string" && tcIn.type === "function" && tcIn.function?.name)
      return { type: "tool", name: tcIn.function.name }
    return undefined
  })()

  const stop_sequences = (() => {
    const v = body.stop
    if (!v) return undefined
    if (Array.isArray(v)) return v
    if (typeof v === "string") return [v]
    return undefined
  })()

  return {
    max_tokens: body.max_tokens ?? 32_000,
    temperature: body.temperature,
    top_p: body.top_p,
    system: system.length > 0 ? system : undefined,
    messages: msgsOut,
    stream: !!body.stream,
    tools,
    tool_choice,
    stop_sequences,
  }
}

export function fromAnthropicResponse(resp: AnthResponse): CommonResponse {
  if (!resp || typeof resp !== "object") return resp as unknown as CommonResponse

  if (Array.isArray(resp.content) === false && !("type" in resp)) return resp as unknown as CommonResponse

  const isAnthropic = typeof resp.type === "string" && resp.type === "message"
  if (!isAnthropic) return resp as unknown as CommonResponse

  const idIn = resp.id
  const id =
    typeof idIn === "string" ? idIn.replace(/^msg_/, "chatcmpl_") : `chatcmpl_${Math.random().toString(36).slice(2)}`
  const model = resp.model

  const blocks: AnthContentPart[] = Array.isArray(resp.content) ? resp.content : []
  const text = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
  const tcs = blocks
    .filter((b) => b && b.type === "tool_use")
    .map((b) => {
      const name = b.name
      const args = (() => {
        const inp = b.input
        if (typeof inp === "string") return inp
        try {
          return JSON.stringify(inp ?? {})
        } catch {
          return String(inp ?? "")
        }
      })()
      const tid = typeof b.id === "string" && b.id.length > 0 ? b.id : `toolu_${Math.random().toString(36).slice(2)}`
      return { id: tid, type: "function" as const, function: { name: name ?? "", arguments: args } }
    })

  const finish = (r: string | null) => {
    if (r === "end_turn") return "stop"
    if (r === "tool_use") return "tool_calls"
    if (r === "max_tokens") return "length"
    if (r === "content_filter") return "content_filter"
    return null
  }

  const u = resp.usage
  const usage = (() => {
    if (!u) return undefined
    const pt = typeof u.input_tokens === "number" ? u.input_tokens : undefined
    const ct = typeof u.output_tokens === "number" ? u.output_tokens : undefined
    const total = pt != null && ct != null ? pt + ct : undefined
    const cached = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined
    const details = cached != null ? { cached_tokens: cached } : undefined
    return {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: total,
      ...(details ? { prompt_tokens_details: details } : {}),
    }
  })()

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(text && text.length > 0 ? { content: text } : {}),
          ...(tcs.length > 0 ? { tool_calls: tcs } : {}),
        },
        finish_reason: finish(resp.stop_reason ?? null),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

export function toAnthropicResponse(resp: CommonResponse) {
  if (!resp || typeof resp !== "object") return resp

  if (!Array.isArray(resp.choices)) return resp

  const choice = resp.choices[0]
  if (!choice) return resp

  const message = choice.message
  if (!message) return resp

  const content: any[] = []

  if (typeof message.content === "string" && message.content.length > 0)
    content.push({ type: "text", text: message.content })

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc.type === "function" && tc.function) {
        let input: any
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = tc.function.arguments
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }
  }

  const stop_reason = (() => {
    const r = choice.finish_reason
    if (r === "stop") return "end_turn"
    if (r === "tool_calls") return "tool_use"
    if (r === "length") return "max_tokens"
    if (r === "content_filter") return "content_filter"
    return null
  })()

  const usage = (() => {
    const u = resp.usage
    if (!u) return undefined
    return {
      input_tokens: u.prompt_tokens,
      output_tokens: u.completion_tokens,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens,
    }
  })()

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: resp.model,
    stop_reason,
    usage,
  }
}

export function fromAnthropicChunk(chunk: string): CommonChunk | string {
  // Anthropic sends two lines per part: "event: <type>\n" + "data: <json>"
  const lines = chunk.split("\n")
  const dataLine = lines.find((l) => l.startsWith("data: "))
  if (!dataLine) return chunk

  let json: AnthChunk
  try {
    json = JSON.parse(dataLine.slice(6))
  } catch {
    return chunk
  }

  const out: CommonChunk = {
    id: json.id ?? json.message?.id ?? "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: json.model ?? json.message?.model ?? "",
    choices: [],
  }

  if (json.type === "content_block_start") {
    const cb = json.content_block
    if (cb?.type === "text") {
      out.choices.push({
        index: json.index ?? 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      })
    } else if (cb?.type === "tool_use") {
      out.choices.push({
        index: json.index ?? 0,
        delta: {
          tool_calls: [
            {
              index: json.index ?? 0,
              id: cb.id,
              type: "function",
              function: { name: cb.name, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      })
    }
  }

  if (json.type === "content_block_delta") {
    const d = json.delta
    if (d?.type === "text_delta") {
      out.choices.push({ index: json.index ?? 0, delta: { content: d.text }, finish_reason: null })
    } else if (d?.type === "input_json_delta") {
      out.choices.push({
        index: json.index ?? 0,
        delta: {
          tool_calls: [{ index: json.index ?? 0, function: { arguments: d.partial_json } }],
        },
        finish_reason: null,
      })
    }
  }

  if (json.type === "message_delta") {
    const d = json.delta
    const finish_reason = (() => {
      const r = d?.stop_reason
      if (r === "end_turn") return "stop"
      if (r === "tool_use") return "tool_calls"
      if (r === "max_tokens") return "length"
      if (r === "content_filter") return "content_filter"
      return null
    })()

    out.choices.push({ index: 0, delta: {}, finish_reason })
  }

  if (json.usage) {
    const u = json.usage
    out.usage = {
      prompt_tokens: u.input_tokens,
      completion_tokens: u.output_tokens,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
      ...(u.cache_read_input_tokens ? { prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens } } : {}),
    }
  }

  return out
}

export function toAnthropicChunk(chunk: CommonChunk): string {
  if (!chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    return JSON.stringify({})
  }

  const choice = chunk.choices[0]
  const delta = choice.delta
  if (!delta) return JSON.stringify({})

  const result: any = {}

  if (delta.content) {
    result.type = "content_block_delta"
    result.index = 0
    result.delta = { type: "text_delta", text: delta.content }
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.function?.name) {
        result.type = "content_block_start"
        result.index = tc.index ?? 0
        result.content_block = { type: "tool_use", id: tc.id, name: tc.function.name, input: {} }
      } else if (tc.function?.arguments) {
        result.type = "content_block_delta"
        result.index = tc.index ?? 0
        result.delta = { type: "input_json_delta", partial_json: tc.function.arguments }
      }
    }
  }

  if (choice.finish_reason) {
    const stop_reason = (() => {
      const r = choice.finish_reason
      if (r === "stop") return "end_turn"
      if (r === "tool_calls") return "tool_use"
      if (r === "length") return "max_tokens"
      if (r === "content_filter") return "content_filter"
      return null
    })()
    result.type = "message_delta"
    result.delta = { stop_reason, stop_sequence: null }
  }

  if (chunk.usage) {
    const u = chunk.usage
    result.usage = {
      input_tokens: u.prompt_tokens,
      output_tokens: u.completion_tokens,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens,
    }
  }

  return JSON.stringify(result)
}
