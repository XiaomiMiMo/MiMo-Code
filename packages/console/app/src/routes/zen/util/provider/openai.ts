import { ProviderHelper, CommonRequest, CommonResponse, CommonChunk } from "./provider"

type Usage = {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

// ---- OpenAI Responses/Chat API request body types ----
// Pragmatic interfaces covering fields actually accessed by the converters below.
// All fields optional: the code does runtime checks (typeof, Array.isArray) before use.

interface OaiContentPart {
  type?: string
  text?: string
  image_url?: { url: string }
  source?: { type: string; url?: string; media_type?: string; data?: string }
  tool_call_id?: string
  content?: string | object
}

interface OaiToolCall {
  type?: string
  id?: string
  function?: { name: string; arguments: string | object }
}

interface OaiInputItem {
  role?: string
  type?: string
  content?: string | OaiContentPart[]
  tool_calls?: OaiToolCall[]
  tool_call_id?: string
  id?: string
  name?: string
  arguments?: string | object
  call_id?: string
  output?: string | object
}

interface OaiToolChoice {
  type?: string
  function?: { name: string }
}

interface OaiTool {
  type?: string
  function?: { name?: string; description?: string; parameters?: object; strict?: boolean }
}

interface OpenAIRequestBody {
  model?: string
  input?: OaiInputItem[]
  messages?: OaiInputItem[]
  max_output_tokens?: number
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stop?: string | string[]
  stream?: boolean
  tools?: OaiTool[]
  tool_choice?: "auto" | "required" | OaiToolChoice
  include?: string[]
  truncation?: string
  metadata?: object
  store?: boolean
  user?: string
}

// ---- OpenAI Responses API response types ----

interface OaiResponseItem {
  type?: string
  content?: Array<{ type?: string; text?: string }>
  id?: string
  name?: string
  arguments?: string | object
}

interface OaiUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface OaiResponse {
  id?: string
  model?: string
  output?: OaiResponseItem[]
  stop_reason?: string
  usage?: OaiUsage
}

interface OpenAIResponseWrapper {
  response?: OaiResponse
  id?: string
  model?: string
  usage?: OaiUsage
  choices?: unknown[]
}

// ---- OpenAI Responses API SSE chunk types ----

interface OaiChunkData {
  delta?: string
  text?: string
  output_text_delta?: string
  arguments_delta?: string
  item?: { type?: string; name?: string; id?: string }
  response?: { id?: string; model?: string; stop_reason?: string; usage?: OaiUsage }
  id?: string
  model?: string
  stop_reason?: string
}

export const openaiHelper: ProviderHelper = ({ workspaceID }) => ({
  format: "openai",
  modifyUrl: (providerApi: string) => providerApi + "/responses",
  modifyHeaders: (headers: Headers, body: Record<string, any>, apiKey: string) => {
    headers.set("authorization", `Bearer ${apiKey}`)
  },
  modifyBody: (body: Record<string, any>) => ({
    ...body,
    ...(workspaceID ? { safety_identifier: workspaceID } : {}),
  }),
  createBinaryStreamDecoder: () => undefined,
  streamSeparator: "\n\n",
  createUsageParser: () => {
    let usage: Usage

    return {
      parse: (chunk: string) => {
        const [event, data] = chunk.split("\n")
        if (event !== "event: response.completed") return
        if (!data.startsWith("data: ")) return

        let json
        try {
          json = JSON.parse(data.slice(6)) as { response?: { usage?: Usage } }
        } catch {
          return
        }

        if (!json.response?.usage) return
        usage = json.response.usage
      },
      retrieve: () => usage,
    }
  },
  normalizeUsage: (usage: Usage) => {
    const inputTokens = usage.input_tokens ?? 0
    const outputTokens = usage.output_tokens ?? 0
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? undefined
    const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? undefined
    return {
      inputTokens: inputTokens - (cacheReadTokens ?? 0),
      outputTokens: outputTokens - (reasoningTokens ?? 0),
      reasoningTokens,
      cacheReadTokens,
      cacheWrite5mTokens: undefined,
      cacheWrite1hTokens: undefined,
    }
  },
})

export function fromOpenaiRequest(body: OpenAIRequestBody): CommonRequest {
  if (!body || typeof body !== "object") return body

  const toImg = (p: OaiContentPart) => {
    if (!p || typeof p !== "object") return undefined
    if (p.type === "image_url" && p.image_url) return { type: "image_url", image_url: p.image_url }
    if (p.type === "input_image" && p.image_url) return { type: "image_url", image_url: p.image_url }
    const s = p.source
    if (!s || typeof s !== "object") return undefined
    if (s.type === "url" && typeof s.url === "string") return { type: "image_url", image_url: { url: s.url } }
    if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string")
      return {
        type: "image_url",
        image_url: { url: `data:${s.media_type};base64,${s.data}` },
      }
    return undefined
  }

  const msgs: any[] = []

  const inMsgs: OaiInputItem[] = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : []

  for (const m of inMsgs) {
    if (!m) continue

    // Responses API items without role:
    if (!m.role && m.type) {
      if (m.type === "function_call") {
        const name = m.name
        const a = m.arguments
        const args = typeof a === "string" ? a : JSON.stringify(a ?? {})
        msgs.push({
          role: "assistant",
          tool_calls: [{ id: m.id, type: "function", function: { name, arguments: args } }],
        })
      }
      if (m.type === "function_call_output") {
        const id = m.call_id
        const out = m.output
        const content = typeof out === "string" ? out : JSON.stringify(out)
        msgs.push({ role: "tool", tool_call_id: id, content })
      }
      continue
    }

    if (m.role === "system" || m.role === "developer") {
      const c = m.content
      if (typeof c === "string" && c.length > 0) msgs.push({ role: "system", content: c })
      if (Array.isArray(c)) {
        const t = c.find((p) => p && typeof p.text === "string")
        if (t && typeof t.text === "string" && t.text.length > 0) msgs.push({ role: "system", content: t.text })
      }
      continue
    }

    if (m.role === "user") {
      const c = m.content
      if (typeof c === "string") {
        msgs.push({ role: "user", content: c })
      } else if (Array.isArray(c)) {
        const parts: any[] = []
        for (const p of c) {
          if (!p || !p.type) continue
          if ((p.type === "text" || p.type === "input_text") && typeof p.text === "string")
            parts.push({ type: "text", text: p.text })
          const ip = toImg(p)
          if (ip) parts.push(ip)
          if (p.type === "tool_result") {
            const id = p.tool_call_id
            const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content)
            msgs.push({ role: "tool", tool_call_id: id, content })
          }
        }
        if (parts.length === 1 && parts[0].type === "text") msgs.push({ role: "user", content: parts[0].text })
        else if (parts.length > 0) msgs.push({ role: "user", content: parts })
      }
      continue
    }

    if (m.role === "assistant") {
      const c = m.content
      const out: any = { role: "assistant" }
      if (typeof c === "string" && c.length > 0) out.content = c
      if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls
      msgs.push(out)
      continue
    }

    if (m.role === "tool") {
      msgs.push({
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: m.content,
      })
      continue
    }
  }

  const tcIn = body.tool_choice
  const tc = (() => {
    if (!tcIn) return undefined
    if (tcIn === "auto") return "auto"
    if (tcIn === "required") return "required"
    if (typeof tcIn !== "string" && tcIn.type === "function" && tcIn.function?.name)
      return { type: "function" as const, function: { name: tcIn.function.name } }
    return undefined
  })()

  const stop = (() => {
    const v = body.stop_sequences ?? body.stop
    if (!v) return undefined
    if (Array.isArray(v)) return v.length === 1 ? v[0] : v
    if (typeof v === "string") return v
    return undefined
  })()

  return {
    model: body.model ?? "",
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop,
    messages: msgs,
    stream: !!body.stream,
    tools: Array.isArray(body.tools) ? (body.tools as CommonRequest["tools"]) : undefined,
    tool_choice: tc,
  }
}

export function toOpenaiRequest(body: CommonRequest) {
  if (!body || typeof body !== "object") return body

  const msgsIn = Array.isArray(body.messages) ? body.messages : []
  const input: any[] = []

  const toPart = (p: {
    type?: string
    text?: string
    image_url?: { url: string }
    source?: { type: string; url?: string; media_type?: string; data?: string }
  }) => {
    if (!p || typeof p !== "object") return undefined
    if (p.type === "text" && typeof p.text === "string") return { type: "input_text", text: p.text }
    if (p.type === "image_url" && p.image_url) return { type: "input_image", image_url: p.image_url }
    const s = p.source
    if (!s || typeof s !== "object") return undefined
    if (s.type === "url" && typeof s.url === "string") return { type: "input_image", image_url: { url: s.url } }
    if (s.type === "base64" && typeof s.media_type === "string" && typeof s.data === "string")
      return {
        type: "input_image",
        image_url: { url: `data:${s.media_type};base64,${s.data}` },
      }
    return undefined
  }

  for (const m of msgsIn) {
    if (!m || !m.role) continue

    if (m.role === "system") {
      const c = m.content
      if (typeof c === "string") input.push({ role: "system", content: c })
      continue
    }

    if (m.role === "user") {
      const c = m.content
      if (typeof c === "string") {
        input.push({ role: "user", content: [{ type: "input_text", text: c }] })
      } else if (Array.isArray(c)) {
        const parts: any[] = []
        for (const p of c) {
          const op = toPart(p)
          if (op) parts.push(op)
        }
        if (parts.length > 0) input.push({ role: "user", content: parts })
      }
      continue
    }

    if (m.role === "assistant") {
      const c = m.content
      if (typeof c === "string" && c.length > 0) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: c }] })
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.type === "function" && tc.function) {
            const name = tc.function.name
            const a = tc.function.arguments
            const args = typeof a === "string" ? a : JSON.stringify(a)
            input.push({ type: "function_call", call_id: tc.id, name, arguments: args })
          }
        }
      }
      continue
    }

    if (m.role === "tool") {
      const out = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: out })
      continue
    }
  }

  const stop_sequences = (() => {
    const v = body.stop
    if (!v) return undefined
    if (Array.isArray(v)) return v
    if (typeof v === "string") return [v]
    return undefined
  })()

  const tcIn = body.tool_choice
  const tool_choice = (() => {
    if (!tcIn) return undefined
    if (tcIn === "auto") return "auto"
    if (tcIn === "required") return "required"
    if (typeof tcIn !== "string" && tcIn.type === "function" && tcIn.function?.name)
      return { type: "function", function: { name: tcIn.function.name } }
    return undefined
  })()

  const tools = (() => {
    if (!Array.isArray(body.tools)) return undefined
    return body.tools.map((tool) => {
      if (tool.type === "function") {
        return {
          type: "function",
          name: tool.function?.name,
          description: tool.function?.description,
          parameters: tool.function?.parameters,
          strict: (tool.function as { strict?: boolean }).strict,
        }
      }
      return tool
    })
  })()

  return {
    model: body.model,
    input,
    max_output_tokens: body.max_tokens,
    top_p: body.top_p,
    stop_sequences,
    stream: !!body.stream,
    tools,
    tool_choice,
    include: undefined,
    truncation: undefined,
    metadata: undefined,
    store: undefined,
    user: undefined,
    text: { verbosity: body.model === "gpt-5-codex" ? "medium" : "low" },
    reasoning: { effort: "medium" },
  }
}

export function fromOpenaiResponse(resp: OpenAIResponseWrapper): CommonResponse {
  if (!resp || typeof resp !== "object") return resp as unknown as CommonResponse
  if (Array.isArray(resp.choices)) return resp as unknown as CommonResponse

  const r = (resp.response ?? resp) as OaiResponse
  if (!r || typeof r !== "object") return resp as unknown as CommonResponse

  const idIn = r.id
  const id =
    typeof idIn === "string" ? idIn.replace(/^resp_/, "chatcmpl_") : `chatcmpl_${Math.random().toString(36).slice(2)}`
  const model = r.model ?? resp.model

  const out = Array.isArray(r.output) ? r.output : []
  const text = out
    .filter((o) => o && o.type === "message" && Array.isArray(o.content))
    .flatMap((o) => o.content)
    .filter(
      (p): p is { type?: string; text?: string } => p != null && p.type === "output_text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("")

  const tcs = out
    .filter((o) => o && o.type === "function_call")
    .map((o) => {
      const name = o.name ?? ""
      const a = o.arguments
      const args = typeof a === "string" ? a : JSON.stringify(a ?? {})
      const tid = typeof o.id === "string" && o.id.length > 0 ? o.id : `toolu_${Math.random().toString(36).slice(2)}`
      return { id: tid, type: "function" as const, function: { name, arguments: args } }
    })

  const finish = (r: string | null) => {
    if (r === "stop") return "stop"
    if (r === "tool_call" || r === "tool_calls") return "tool_calls"
    if (r === "length" || r === "max_output_tokens") return "length"
    if (r === "content_filter") return "content_filter"
    return null
  }

  const u = r.usage ?? resp.usage
  const usage = (() => {
    if (!u) return undefined
    const pt = typeof u.input_tokens === "number" ? u.input_tokens : undefined
    const ct = typeof u.output_tokens === "number" ? u.output_tokens : undefined
    const total = pt != null && ct != null ? pt + ct : undefined
    const cached = u.input_tokens_details?.cached_tokens
    const details = typeof cached === "number" ? { cached_tokens: cached } : undefined
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
        finish_reason: finish(r.stop_reason ?? null),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

export function toOpenaiResponse(resp: CommonResponse) {
  if (!resp || typeof resp !== "object") return resp
  if (!Array.isArray(resp.choices)) return resp

  const choice = resp.choices[0]
  if (!choice) return resp

  const msg = choice.message
  if (!msg) return resp

  const outputItems: any[] = []

  if (typeof msg.content === "string" && msg.content.length > 0) {
    outputItems.push({
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [], logprobs: [] }],
    })
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.type === "function" && tc.function) {
        outputItems.push({
          id: tc.id,
          type: "function_call",
          name: tc.function.name,
          call_id: tc.id,
          arguments: tc.function.arguments,
        })
      }
    }
  }

  const stop_reason = (() => {
    const r = choice.finish_reason
    if (r === "stop") return "stop"
    if (r === "tool_calls") return "tool_call"
    if (r === "length") return "max_output_tokens"
    if (r === "content_filter") return "content_filter"
    return null
  })()

  const usage = (() => {
    const u = resp.usage
    if (!u) return undefined
    return {
      input_tokens: u.prompt_tokens,
      output_tokens: u.completion_tokens,
      total_tokens: u.total_tokens,
      ...(u.prompt_tokens_details?.cached_tokens
        ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
        : {}),
    }
  })()

  return {
    id: resp.id?.replace(/^chatcmpl_/, "resp_") ?? `resp_${Math.random().toString(36).slice(2)}`,
    object: "response",
    model: resp.model,
    output: outputItems,
    stop_reason,
    usage,
  }
}

export function fromOpenaiChunk(chunk: string): CommonChunk | string {
  const lines = chunk.split("\n")
  const ev = lines[0]
  const dl = lines[1]
  if (!ev || !dl || !dl.startsWith("data: ")) return chunk

  let json: OaiChunkData
  try {
    json = JSON.parse(dl.slice(6))
  } catch {
    return chunk
  }

  const respObj = json.response ?? {}

  const out: CommonChunk = {
    id: respObj.id ?? json.id ?? "",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: respObj.model ?? json.model ?? "",
    choices: [],
  }

  const e = ev.replace("event: ", "").trim()

  if (e === "response.output_text.delta") {
    const d = json.delta ?? json.text ?? json.output_text_delta
    if (typeof d === "string" && d.length > 0)
      out.choices.push({ index: 0, delta: { content: d }, finish_reason: null })
  }

  if (e === "response.output_item.added" && json.item?.type === "function_call") {
    const name = json.item?.name
    const id = json.item?.id
    if (typeof name === "string" && name.length > 0) {
      out.choices.push({
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
        },
        finish_reason: null,
      })
    }
  }

  if (e === "response.function_call_arguments.delta") {
    const a = json.delta ?? json.arguments_delta
    if (typeof a === "string" && a.length > 0) {
      out.choices.push({
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: a } }] },
        finish_reason: null,
      })
    }
  }

  if (e === "response.completed") {
    const fr = (() => {
      const sr = respObj.stop_reason ?? json.stop_reason
      if (sr === "stop") return "stop"
      if (sr === "tool_call" || sr === "tool_calls") return "tool_calls"
      if (sr === "length" || sr === "max_output_tokens") return "length"
      if (sr === "content_filter") return "content_filter"
      return null
    })()
    out.choices.push({ index: 0, delta: {}, finish_reason: fr })

    const u = respObj.usage ?? json.response?.usage
    if (u) {
      out.usage = {
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        ...(u.input_tokens_details?.cached_tokens
          ? { prompt_tokens_details: { cached_tokens: u.input_tokens_details.cached_tokens } }
          : {}),
      }
    }
  }

  return out
}

export function toOpenaiChunk(chunk: CommonChunk): string {
  if (!chunk.choices || !Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    return ""
  }

  const choice = chunk.choices[0]
  const d = choice.delta
  if (!d) return ""

  const id = chunk.id
  const model = chunk.model

  if (d.content) {
    const data = {
      id,
      type: "response.output_text.delta",
      delta: d.content,
      response: { id, model },
    }
    return `event: response.output_text.delta\ndata: ${JSON.stringify(data)}`
  }

  if (d.tool_calls) {
    for (const tc of d.tool_calls) {
      if (tc.function?.name) {
        const data = {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: tc.id,
            type: "function_call",
            name: tc.function.name,
            call_id: tc.id,
            arguments: "",
          },
        }
        return `event: response.output_item.added\ndata: ${JSON.stringify(data)}`
      }
      if (tc.function?.arguments) {
        const data = {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: tc.function.arguments,
        }
        return `event: response.function_call_arguments.delta\ndata: ${JSON.stringify(data)}`
      }
    }
  }

  if (choice.finish_reason) {
    const u = chunk.usage
    const usage = u
      ? {
          input_tokens: u.prompt_tokens,
          output_tokens: u.completion_tokens,
          total_tokens: u.total_tokens,
          ...(u.prompt_tokens_details?.cached_tokens
            ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
            : {}),
        }
      : undefined

    const data: any = {
      id,
      type: "response.completed",
      response: { id, model, ...(usage ? { usage } : {}) },
    }
    return `event: response.completed\ndata: ${JSON.stringify(data)}`
  }

  return ""
}
