import { Log, Process } from "@/util"
import { which } from "@/util/which"
import { RealtimeVAD, type VADSegment } from "./vad"
import z from "zod"
import VOICE_CONTROL_SYSTEM_PROMPT from "./voice-input.txt"
import type { TextPlacement } from "./voice-edit"

const log = Log.create({ service: "tui.voice" })

const DEFAULT_ASR_MODEL = "xiaomi/mimo-v2.5-asr"
const DEFAULT_CONTROL_MODEL = "xiaomi/mimo-v2.5"

export type VoiceProviderConfig = {
  providerID: string
  model: string
}

export type VoiceCredentials = { apiKey: string; baseUrl: string }
export type VoiceCredentialError = { error: "not_found" | "no_key" | "no_url"; providerID: string; model: string }

export function resolveCredentials(
  providers: Array<{ id: string; key?: string; options: Record<string, unknown>; models: Record<string, { api: { url: string } }> }>,
  config: VoiceProviderConfig,
): VoiceCredentials | VoiceCredentialError {
  const provider = providers.find((p) => p.id === config.providerID)
  if (!provider) return { error: "not_found", providerID: config.providerID, model: config.model }
  const apiKey = provider.key || (provider.options?.apiKey as string | undefined)
  if (!apiKey) return { error: "no_key", providerID: config.providerID, model: config.model }
  const baseUrl = (provider.options?.baseURL as string)
    || Object.values(provider.models)[0]?.api?.url
    || (config.providerID === "xiaomi" ? "https://api.xiaomimimo.com/v1" : undefined)
  if (!baseUrl) return { error: "no_url", providerID: config.providerID, model: config.model }
  return { apiKey, baseUrl }
}

export function resolveVoiceConfig(voiceConfig?: { asr_model?: string; control_model?: string }): {
  asr: VoiceProviderConfig
  control: VoiceProviderConfig
} {
  const asrModelID = voiceConfig?.asr_model || DEFAULT_ASR_MODEL
  const controlModelID = voiceConfig?.control_model || DEFAULT_CONTROL_MODEL
  return {
    asr: parseModelID(asrModelID),
    control: parseModelID(controlModelID),
  }
}

function parseModelID(modelID: string): VoiceProviderConfig {
  const slashIndex = modelID.indexOf("/")
  if (slashIndex < 1) return { providerID: "xiaomi", model: modelID }
  return { providerID: modelID.slice(0, slashIndex), model: modelID.slice(slashIndex + 1) }
}

type Recorder = {
  cmd: string
  pipeArgs: () => string[]
}

const RECORDERS: Record<string, Array<() => Recorder | null>> = {
  darwin: [
    () =>
      which("sox")
        ? { cmd: "sox", pipeArgs: () => ["-d", "-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"] }
        : null,
    () =>
      which("rec")
        ? { cmd: "rec", pipeArgs: () => ["-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"] }
        : null,
  ],
  linux: [
    () =>
      which("arecord")
        ? { cmd: "arecord", pipeArgs: () => ["-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"] }
        : null,
    () =>
      which("sox")
        ? { cmd: "sox", pipeArgs: () => ["-d", "-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"] }
        : null,
  ],
  win32: [
    () =>
      which("sox")
        ? { cmd: "sox", pipeArgs: () => ["-d", "-r", "16000", "-c", "1", "-b", "16", "-t", "raw", "-"] }
        : null,
  ],
}

let cachedRecorder: Recorder | null | undefined

function detectRecorder(): Recorder | null {
  if (cachedRecorder !== undefined) return cachedRecorder
  const candidates = RECORDERS[process.platform] ?? []
  for (const factory of candidates) {
    const recorder = factory()
    if (recorder) {
      cachedRecorder = recorder
      return recorder
    }
  }
  cachedRecorder = null
  return null
}

export function isAvailable(): boolean {
  return detectRecorder() !== null
}

export type StreamingHandle = {
  proc: Process.Child
  vad: RealtimeVAD
  startTime: number
  aborted: boolean
  reading: Promise<void>
}

export function startStreaming(opts: {
  onSegment: (segment: VADSegment) => void
  onActiveChange?: (active: boolean) => void
  onError?: (err: Error) => void
  minSilenceS?: number
}): StreamingHandle | null {
  const recorder = detectRecorder()
  if (!recorder) return null

  log.info("recording started", { recorder: recorder.cmd })
  const vad = new RealtimeVAD({
    onSegment: opts.onSegment,
    onActiveChange: opts.onActiveChange,
    minSilenceS: opts.minSilenceS,
  })
  const proc = Process.spawn([recorder.cmd, ...recorder.pipeArgs()], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const handle: StreamingHandle = { proc, vad, startTime: Date.now(), aborted: false, reading: Promise.resolve() }

  const stderrChunks: Buffer[] = []
  if (proc.stderr) {
    ;(async () => {
      for await (const chunk of proc.stderr as AsyncIterable<Buffer>) {
        stderrChunks.push(chunk)
      }
    })().catch(() => {})
  }

  proc.exited
    .then((code) => {
      if (code !== 0 && !handle.aborted) {
        handle.aborted = true
        const stderrText = Buffer.concat(stderrChunks).toString().trim()
        const msg = stderrText || `Recorder exited with code ${code}`
        log.warn("recorder exited with error", { code, stderr: stderrText })
        opts.onError?.(new Error(msg))
      }
    })
    .catch(() => {})

  handle.reading = (async () => {
    await vad.init()
    const stdout = proc.stdout
    if (!stdout) return
    const reader = stdout as AsyncIterable<Buffer>
    let leftover: Buffer | null = null
    for await (const chunk of reader) {
      if (handle.aborted) break
      const buf: Buffer = leftover ? Buffer.concat([leftover, chunk]) : chunk
      leftover = null
      const alignedLen = buf.byteLength & ~1
      if (alignedLen < buf.byteLength) {
        leftover = Buffer.from(buf.subarray(alignedLen))
      }
      if (alignedLen > 0) {
        const aligned = Buffer.alloc(alignedLen)
        buf.copy(aligned, 0, 0, alignedLen)
        const samples = new Int16Array(aligned.buffer, aligned.byteOffset, alignedLen / 2)
        vad.push(samples)
      }
    }
  })().catch((err) => {
    if (handle.aborted) return
    handle.aborted = true
    proc.kill("SIGINT")
    opts.onError?.(err instanceof Error ? err : new Error(String(err)))
  })

  return handle
}

export async function stopStreaming(handle: StreamingHandle) {
  handle.aborted = true
  handle.proc.kill("SIGINT")
  await handle.proc.exited.catch(() => {})
  await handle.reading
  handle.vad.flush()
  handle.vad.destroy()
  log.info("recording stopped", { duration: Date.now() - handle.startTime })
}

// Xiaomi ASR uses a proprietary data-URL audio format and asr_options field, not the standard OpenAI input_audio schema.
export async function transcribeAudio(opts: {
  audio: Int16Array
  apiKey: string
  baseUrl: string
  model?: string
}): Promise<string | null> {
  const model = opts.model || "mimo-v2.5-asr"
  const samples = opts.audio.length
  log.debug("transcribe request", { model, samples })
  const wavBuffer = encodeWav(opts.audio)
  const base64 = Buffer.from(wavBuffer).toString("base64")
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${opts.apiKey}`,
      "X-Mimo-Source": "mimocode-cli",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${base64}` } }] }],
      asr_options: { language: "auto" },
    }),
    signal: controller.signal,
  }).catch(() => null)

  clearTimeout(timeout)
  if (!res || !res.ok) {
    const body = await res?.text().catch(() => "")
    log.warn("transcribe failed", { model, status: res?.status, body })
    return null
  }
  try {
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = data.choices?.[0]?.message?.content?.trim() || null
    log.debug("transcribe result", { model, length: text?.length ?? 0 })
    return text
  } catch {
    return null
  }
}

export function encodeWav(samples: Int16Array): ArrayBuffer {
  const sampleRate = 16000
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, "WAVE")
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, "data")
  view.setUint32(40, dataSize, true)
  new Int16Array(buffer, 44).set(samples)

  return buffer
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

// --- Voice Control (forced voice_input tool call) ---
// Protocol mirrors desktop: unique function tool, three-part text snapshot,
// protocol-failure self-repair (<=2). No agent/model switching.

export const VOICE_INPUT_TOOL_NAME = "voice_input"

export const VOICE_INPUT_TOOL_DESCRIPTION = `Call this tool exactly once with the complete operation for this voice segment. Do not answer in plain text.

First clearly distinguish whether the utterance is an edit command or content for the coding agent, and identify the user's intent. Then fill the fields accordingly.

One call may carry several actions at once — at most one \`operation\` and one \`send\`. The client runs them in this order: text edit, then send.

Use \`operation\` for any prompt text edit. Choose exactly one arm:

- \`insert\` (default): exact fragment placed at the supplied cursor, or replacing the supplied selection. Never the complete prompt text. Use whenever the edit target is the supplied cursor/selection — appending dictated content, typing at the cursor, delete/replace the selection.
- \`set\`: complete final prompt text as a plain string. The client places the cursor at the end. Use only when the edit target is NOT the supplied cursor/selection — whole rewrite, clear, or changing a span somewhere else.
- \`set_with_cursor\`: complete final text plus explicit final cursor/selection (\`before_cursor\` / \`selection\` / \`after_cursor\`). The three parts must concatenate to the complete final text. Keep \`selection\` empty unless the user explicitly asked to keep a range selected. Use when the cursor must land somewhere other than the end.

After any text edit the cursor sits immediately after the changed or inserted text unless the user asked for another position.

Almost everything the user says is content for a coding agent that runs after you. Transcribe that content with \`insert\`. Do not perform the spoken task yourself.

Use \`send: true\` only for an explicit submit at the end of the utterance when send_enabled is true.

Call this tool once with an empty object only when the audio has no usable speech (noise, silence, breathing, or unintelligible). Omit \`operation\` and \`send\` in that case.`

const VoiceInputArgsSchema = z.object({
  operation: z
    .discriminatedUnion("action", [
      z
        .object({
          action: z.literal("insert"),
          text: z
            .string()
            .describe("Exact fragment to insert at the cursor or replace the selection with."),
        })
        .strict(),
      z
        .object({
          action: z.literal("set"),
          text: z.string().describe("Complete final prompt text; cursor ends at the end."),
        })
        .strict(),
      z
        .object({
          action: z.literal("set_with_cursor"),
          before_cursor: z.string().describe("Text before the final cursor/selection."),
          selection: z.string().describe("Selected text; empty means a collapsed cursor."),
          after_cursor: z.string().describe("Text after the final cursor/selection."),
        })
        .strict(),
    ])
    // Same as actor/task/cron `operation`: without this the emitted schema has
    // only anyOf and some models stringify the whole envelope.
    .meta({ type: "object" })
    .optional()
    .describe("Text edit, if any. Choose exactly one arm: insert, set, or set_with_cursor."),
  send: z.boolean().optional().describe("true to submit. Only when send_enabled is true."),
}).strict()

export type VoiceInputArgs = z.infer<typeof VoiceInputArgsSchema>

// Single source of truth: zod is the runtime validator; JSON Schema is derived for the API.
// Drop $schema — some OpenAI-compatible gateways reject unknown top-level keys in tool parameters.
function stripSchemaKeyword(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaKeyword)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "$schema")
        .map(([key, child]) => [key, stripSchemaKeyword(child)]),
    )
  }
  return value
}

export const VOICE_INPUT_TOOL_SCHEMA = stripSchemaKeyword(z.toJSONSchema(VoiceInputArgsSchema)) as Record<string, unknown>

export type VoiceControlAction =
  | { action: "insert"; text: string }
  | { action: "set"; text: string }
  | { action: "set_with_cursor"; placement: TextPlacement }
  | { action: "send" }

export type VoiceControlBody = {
  model: string
  messages: Array<Record<string, unknown>>
  tools: Array<Record<string, unknown>>
}

export function buildVoiceControlBody(opts: {
  model: string
  audioBase64: string
  context: { text: string | TextPlacement; sendEnabled?: boolean }
}): VoiceControlBody {
  const userContext = JSON.stringify({
    text: opts.context.text,
    send_enabled: !!opts.context.sendEnabled,
  })
  return {
    model: opts.model,
    messages: [
      { role: "system", content: VOICE_CONTROL_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userContext },
          { type: "input_audio", input_audio: { data: opts.audioBase64, format: "wav" } },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: VOICE_INPUT_TOOL_NAME,
          description: VOICE_INPUT_TOOL_DESCRIPTION,
          parameters: VOICE_INPUT_TOOL_SCHEMA,
        },
      },
    ],
  }
}

export function buildVoiceControlRetryBody(
  base: VoiceControlBody,
  previous: { role: "assistant"; content?: string | null; tool_calls?: unknown[] | null; reasoning_content?: string | null },
  protocolError: string,
): VoiceControlBody {
  const assistant: Record<string, unknown> = { role: "assistant", content: previous.content ?? null }
  if (previous.tool_calls?.length) assistant.tool_calls = previous.tool_calls
  if (previous.reasoning_content) assistant.reasoning_content = previous.reasoning_content
  const follow: Record<string, unknown>[] = []
  // OpenAI-compatible servers expect a tool role reply per tool_call_id after assistant.tool_calls.
  if (previous.tool_calls?.length) {
    for (const call of previous.tool_calls) {
      const id = (call as { id?: string }).id
      if (id) follow.push({ role: "tool", tool_call_id: id, content: protocolError })
    }
  }
  if (!follow.length) follow.push({ role: "user", content: protocolError })
  return {
    ...base,
    messages: [...base.messages, assistant, ...follow],
  }
}

export function voiceToolArgsToActions(args: VoiceInputArgs, opts: { sendEnabled?: boolean }): VoiceControlAction[] {
  const actions: VoiceControlAction[] = []
  if (args.operation?.action === "insert") actions.push({ action: "insert", text: args.operation.text })
  else if (args.operation?.action === "set") actions.push({ action: "set", text: args.operation.text })
  else if (args.operation?.action === "set_with_cursor") {
    actions.push({
      action: "set_with_cursor",
      placement: {
        before_cursor: args.operation.before_cursor,
        selection: args.operation.selection,
        after_cursor: args.operation.after_cursor,
      },
    })
  }
  if (args.send === true && opts.sendEnabled) actions.push({ action: "send" })
  return actions
}

export type VoiceControlParseResult = {
  ok: boolean
  actions: VoiceControlAction[]
  protocolError?: string
  previous: { role: "assistant"; content?: string | null; tool_calls?: unknown[] | null; reasoning_content?: string | null }
}

export function parseVoiceControlResponse(message: unknown, opts: { sendEnabled?: boolean }): VoiceControlParseResult {
  const msg = (message && typeof message === "object" ? message : {}) as Record<string, unknown>
  const content = typeof msg.content === "string" ? msg.content : null
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null
  const reasoningContent = typeof msg.reasoning_content === "string" ? msg.reasoning_content : null
  const previous = { role: "assistant" as const, content, tool_calls: toolCalls, reasoning_content: reasoningContent }

  if (toolCalls?.length) {
    if (toolCalls.length > 1) {
      return { ok: false, actions: [], protocolError: `Call the ${VOICE_INPUT_TOOL_NAME} tool exactly once.`, previous }
    }
    const fn = ((toolCalls[0] as { function?: { name?: string; arguments?: string | Record<string, unknown> } })?.function) ?? {}
    // Some gateways omit function.name when only one tool is registered.
    if (fn.name && fn.name !== VOICE_INPUT_TOOL_NAME) {
      return { ok: false, actions: [], protocolError: `Call the ${VOICE_INPUT_TOOL_NAME} tool.`, previous }
    }
    const rawArg = fn.arguments
    const raw: unknown = typeof rawArg === "string" ? (() => {
      try {
        return JSON.parse(rawArg)
      } catch {
        return undefined
      }
    })() : rawArg
    if (raw === undefined) {
      return { ok: false, actions: [], protocolError: `${VOICE_INPUT_TOOL_NAME} arguments must be valid JSON.`, previous }
    }
    const parsed = VoiceInputArgsSchema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
        .slice(0, 5)
        .join("; ")
      return { ok: false, actions: [], protocolError: `${VOICE_INPUT_TOOL_NAME} arguments are invalid — ${detail}`, previous }
    }
    return { ok: true, actions: voiceToolArgsToActions(parsed.data, opts), previous }
  }

  return { ok: false, actions: [], protocolError: `You MUST call the ${VOICE_INPUT_TOOL_NAME} tool exactly once.`, previous }
}

const VOICE_CONTROL_MAX_PROTOCOL_RETRIES = 2

export type VoiceControlResult =
  | { ok: true; actions: VoiceControlAction[] }
  | { ok: false; reason: "network" | "protocol" }

export async function processVoiceControl(opts: {
  audio: Int16Array
  apiKey: string
  baseUrl: string
  model?: string
  contextText: string | TextPlacement
  sendEnabled?: boolean
}): Promise<VoiceControlResult> {
  const model = opts.model || "mimo-v2.5"
  log.debug("voice control request", { model, samples: opts.audio.length })
  const wavBuffer = encodeWav(opts.audio)
  const base64 = Buffer.from(wavBuffer).toString("base64")
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    "X-Mimo-Source": "mimocode-cli",
  }

  let body = buildVoiceControlBody({
    model,
    audioBase64: base64,
    context: { text: opts.contextText, sendEnabled: opts.sendEnabled },
  })

  for (let attempt = 0; attempt <= VOICE_CONTROL_MAX_PROTOCOL_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => null)
    clearTimeout(timeout)

    if (!res || !res.ok) {
      const errBody = await res?.text().catch(() => "")
      log.warn("voice control failed", { model, status: res?.status, body: errBody })
      return { ok: false, reason: "network" }
    }

    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: Record<string, unknown> }>
    } | null
    const message = data?.choices?.[0]?.message
    if (!message) return { ok: false, reason: "network" }

    const parsed = parseVoiceControlResponse(message, { sendEnabled: opts.sendEnabled })
    if (parsed.ok) {
      log.debug("voice control result", { model, actions: parsed.actions.length, attempt })
      return { ok: true, actions: parsed.actions }
    }
    log.warn("voice control protocol error", {
      model,
      attempt,
      protocolError: parsed.protocolError,
      hasToolCalls: !!parsed.previous.tool_calls?.length,
      toolCallNames: parsed.previous.tool_calls?.map((c) => (c as { function?: { name?: string } })?.function?.name),
      contentPreview: parsed.previous.content?.slice(0, 200),
    })
    if (attempt >= VOICE_CONTROL_MAX_PROTOCOL_RETRIES) return { ok: false, reason: "protocol" }
    body = buildVoiceControlRetryBody(body, parsed.previous, parsed.protocolError ?? "protocol error")
  }
  return { ok: false, reason: "protocol" }
}
