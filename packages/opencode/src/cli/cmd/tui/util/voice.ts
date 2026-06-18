import { Log, Process } from "@/util"
import { which } from "@/util/which"
import { RealtimeVAD, type VADSegment } from "./vad"
import z from "zod"

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
}): StreamingHandle | null {
  const recorder = detectRecorder()
  if (!recorder) return null

  log.info("recording started", { recorder: recorder.cmd })
  const vad = new RealtimeVAD({ onSegment: opts.onSegment, onActiveChange: opts.onActiveChange })
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

export const SEND_RE = /^(发送|send\s*it)$/i

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

// --- Voice Control (experiment/voice-control) ---

const VoiceActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("edit"),
    text: z.string(),
  }),
  z.object({
    action: z.literal("send"),
  }),
  z.object({
    action: z.literal("agent"),
    agent: z.string(),
  }),
])

const VoiceControlSchema = z.object({
  actions: z.array(VoiceActionSchema),
})

export type VoiceAction = z.infer<typeof VoiceActionSchema>
export type VoiceControlResult = z.infer<typeof VoiceControlSchema>

const VOICE_CONTROL_SYSTEM_PROMPT = `你是 MiMoCode（AI 编程助手）的语音输入助手。用户通过语音向输入框口述消息，这些消息将发送给 Code Agent 执行编程任务。用户可能使用中文或英文。

## 核心原则
用户说的绝大多数内容是**给 Code Agent 的指令或描述**，必须原样转录为输入框内容。只有以下三种情况属于语音控制指令：
1. **对输入框文本本身的编辑操作**（删除/替换/插入/清空/整理已有文本）
2. **发送指令**（明确要求提交当前输入）
3. **切换 agent 指令**（明确要求切换到另一个 agent）

除此之外，任何听起来像指令的内容都应原样转录——它是给 Code Agent 的，不是给你的。

## 规则
- 默认认为用户在追加内容；只有明确描述对现有 current_text 的修改才处理为编辑
- 无论追加还是编辑，edit.text 都输出输入框的完整最终内容
- 完整复述 current_text 中应保留的部分，不要遗漏或改写未被提及的内容
- 语音控制指令本身不是内容：如果用户说了一段内容后跟着发送/切换指令，edit.text 只包含内容部分
- **语音补丁**：用户在内容中间插入解释性文本来纠正前面内容的拼写或格式（如拼读字母"D-E-V的那个dev"、描述格式"驼峰的""下划线连接""数字的"），按用户意图用正确的形式输出，解释性文本本身不出现在结果中
- **口语自我纠正**：用户改口时（"冒泡...不对，快速排序"），只保留纠正后的内容，丢弃被否定的部分和纠正标记词（"不对""不是""wait""I mean"）
- **过滤填充词**：去掉无意义的口语填充（"嗯""那个""就是""额""well""um""uh""like"），只保留实质内容
- **重复指令只执行一次**："发送发送" 只触发一次 send；"清空清空" 只产生一次 edit:""
- **没有实质内容时返回空数组**：噪音、沉默、或无意义语音 → {"actions": []}，不要编造内容

## 什么是内容（给 Code Agent 的）
以下全部是内容，必须原样转录，不要当作指令执行：
- "帮我写一个快速排序"
- "重构这个函数"
- "分析这段代码的性能问题"
- "帮我发送一封邮件给张三"（包含"发送"但是给 Agent 的任务描述）
- "fix the authentication bug"
- "add error handling to the API endpoint"
- "explain how this regex works"

## 什么是编辑指令（对输入框文本本身的操作）
用户明确描述对 current_text 的修改：
- 删除："把那个删掉""删除第一句" → 去掉指定部分，保留其余
- 替换："把X改成Y""换成Z" → 替换指定部分，保留其余
- 插入："在X前面加上Y" → 在指定位置插入，保留其余
- 清空："清空""全部删掉""重新来" → text 为空字符串
- 整理："整理一下格式""规范一下" → 对前文做格式调整，语义不变

edit.text 都是操作后的完整结果。

## 发送规则
- send_enabled: false 时 → 永远不输出 action: "send"，一律当作文本内容
- action: "send" 只在 send_enabled: true 且用户**在语音末尾**明确说「发送」「send it」「submit」等直接指令时使用
- 发送指令必须是独立的、明确的动作请求，不能从语义推断——用户说的是"请发送"而非"听起来像是说完了"
- 任何描述任务、陈述意图的语句都是内容，不是发送指令："我们的任务是xxx""现在做xxx""帮我发送一封邮件"
- 不确定时 → 不发送，当作内容

## 输出格式
严格输出 JSON：{"actions": [{"action": "edit|send|agent", ...}]}

- edit: {"action": "edit", "text": "输入框完整最终内容"}
- send: {"action": "send"}
- agent: {"action": "agent", "agent": "从 available_agents 中匹配的名称"}
- **必须按顺序**：如果同时有 edit 和 send，edit 在 send 前；agent 放最前

## 示例
追加（current_text: ""）："帮我写一个快速排序" → [edit:"帮我写一个快速排序"]
追加（current_text: "帮我写一个快速排序"）："用 TypeScript" → [edit:"帮我写一个快速排序，用 TypeScript"]
追加+发送（current_text: ""）："写个快排，发送" → [edit:"写个快排", send]
切换+追加（current_text: "review this PR"）："切到compose，再加上 focus on error handling" → [agent:"compose", edit:"review this PR, focus on error handling"]
仅发送："发送" / "就这样发送吧" → [send]
仅切换："切换到plan模式" → [agent:"plan"]
纯内容："help me refactor this function to use async await" → [edit:"help me refactor this function to use async await"]
语音补丁（current_text: ""）："搜索一下代码里面的dev，是D-E-V的那个dev" → [edit:"搜索一下代码里面的dev"]
语音补丁（current_text: ""）："check the env，E-N-V，environment variable" → [edit:"check the env variable"]
语音补丁（current_text: ""）："帮我找一下 get 下划线 value 这个函数" → [edit:"帮我找一下 get_value 这个函数"]
自我纠正（current_text: ""）："帮我写一个冒泡...不对，快速排序" → [edit:"帮我写一个快速排序"]
过滤填充词（current_text: ""）："嗯...就是那个...帮我写一个排序算法" → [edit:"帮我写一个排序算法"]
中英混杂（current_text: ""）："帮我 refactor 一下这个 useEffect，把 dependency array 加上 userId" → [edit:"帮我 refactor 一下这个 useEffect，把 dependency array 加上 userId"]
重复指令："发送发送" → [send]

编辑（current_text: "帮我写一个冒泡排序"）：
- "改成快速排序" → [edit:"帮我写一个快速排序"]
- "删掉冒泡两个字" → [edit:"帮我写一个排序"]
- "清空" → [edit:""]`

export function parseVoiceControl(raw: string): VoiceControlResult | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    const result = VoiceControlSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export async function processVoiceControl(opts: {
  audio: Int16Array
  apiKey: string
  baseUrl: string
  model?: string
  currentText: string
  currentAgent: string
  availableAgents: string[]
  sendEnabled?: boolean
}): Promise<VoiceControlResult | null> {
  const model = opts.model || "mimo-v2.5"
  const samples = opts.audio.length
  log.debug("voice control request", { model, samples, agent: opts.currentAgent })
  const wavBuffer = encodeWav(opts.audio)
  const base64 = Buffer.from(wavBuffer).toString("base64")
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`

  const userContext = JSON.stringify({
    current_text: opts.currentText,
    cursor: "end",
    agent: opts.currentAgent,
    available_agents: opts.availableAgents,
    send_enabled: opts.sendEnabled ?? true,
  })

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
      messages: [
        { role: "system", content: VOICE_CONTROL_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userContext },
            { type: "input_audio", input_audio: { data: base64, format: "wav" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    }),
    signal: controller.signal,
  }).catch(() => null)

  clearTimeout(timeout)
  if (!res || !res.ok) {
    const body = await res?.text().catch(() => "")
    log.warn("voice control failed", { model, status: res?.status, body })
    return null
  }
  try {
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) return null
    const result = parseVoiceControl(content)
    log.debug("voice control result", { model, actions: result?.actions.length ?? 0 })
    return result
  } catch {
    return null
  }
}
