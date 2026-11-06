import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface, type Interface } from "node:readline"
import z from "zod"
import type { ChannelAdapter, ChannelInput, ChannelReply } from "../channel"
import { command, type Command } from "./command"

export const FeishuConfig = z.strictObject({
  kind: z.literal("feishu"),
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  directory: z.string(),
  cli: z.string().min(1).default("lark-cli"),
  botId: z.string().min(1),
  appId: z.string().min(1),
  allowedSenders: z.array(z.string().min(1)).min(1),
  chats: z.array(z.string().min(1)).min(1),
})
export type FeishuConfig = z.infer<typeof FeishuConfig>
const Event = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  chat_type: z.enum(["group", "p2p"]),
  sender_id: z.string(),
  sender_type: z.enum(["user", "bot"]),
  content: z.string(),
  mentions: z.array(z.object({ id: z.string() })).default([]),
  root_id: z.string().optional(),
})
export function feishuInput(raw: unknown, config: Pick<FeishuConfig, "botId" | "appId">): ChannelInput | undefined {
  const event = Event.parse(raw)
  if (event.sender_id === config.botId || event.sender_id === config.appId || event.sender_type !== "user") return
  return {
    eventId: event.message_id,
    threadId: `${event.chat_id}:${event.root_id || event.message_id}`,
    scopeId: event.chat_id,
    senderId: event.sender_id,
    text: event.content,
    human: true,
    addressed: event.chat_type === "p2p" || event.mentions.some((m) => m.id === config.botId || m.id === config.appId),
  }
}
export class FeishuChannel implements ChannelAdapter {
  readonly idempotentSend = true
  private child?: ChildProcessWithoutNullStreams
  private lines: Interface[] = []
  private timer?: ReturnType<typeof setTimeout>
  private readyTimer?: ReturnType<typeof setTimeout>
  private stopped = true
  private delay = 1000
  private controller = new AbortController()
  private status = { connected: false, detail: "Not started" }
  private receive?: (input: ChannelInput) => Promise<void>
  constructor(
    private readonly config: FeishuConfig,
    private readonly run: Command = command,
  ) {}
  health() {
    return this.status
  }
  async start(ingest: (input: ChannelInput) => Promise<void>) {
    this.receive = ingest
    this.stopped = false
    this.controller = new AbortController()
    this.connect()
  }
  private connect() {
    if (this.stopped) return
    this.status = { connected: false, detail: "Connecting lark-cli event consumer" }
    const child = (this.child = spawn(this.config.cli, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
    }))
    const stdout = createInterface({ input: child.stdout }),
      stderr = createInterface({ input: child.stderr })
    this.lines = [stdout, stderr]
    this.readyTimer = setTimeout(() => {
      this.status = { connected: false, detail: "lark-cli did not become ready within 45 seconds" }
      child.kill("SIGTERM")
    }, 45000)
    this.readyTimer.unref()
    let chain = Promise.resolve()
    stdout.on("line", (line) => {
      chain = chain
        .then(async () => {
          if (this.stopped) return
          if (line.length > 1_048_576) throw new Error("Feishu event exceeds 1 MiB")
          const input = feishuInput(JSON.parse(line), this.config)
          if (input?.text.trim()) await this.receive?.(input)
        })
        .catch((error) => {
          this.status = { connected: false, detail: error instanceof Error ? error.message : "Unreadable Feishu event" }
        })
    })
    stderr.on("line", (line) => {
      if (line.startsWith("[event] ready")) {
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.delay = 1000
        this.status = { connected: true, detail: "Listening through the bot's lark-cli long connection" }
      } else if (/WARN|error|drop/i.test(line)) this.status = { connected: false, detail: line.slice(0, 2000) }
    })
    child.on("error", (error) => {
      this.status = { connected: false, detail: error.message }
    })
    child.on("close", () => {
      if (this.readyTimer) clearTimeout(this.readyTimer)
      stdout.close()
      stderr.close()
      if (this.stopped) return
      this.status = { connected: false, detail: "Feishu consumer exited; reconnecting" }
      this.timer = setTimeout(() => this.connect(), this.delay)
      this.timer.unref()
      this.delay = Math.min(this.delay * 2, 60000)
    })
  }
  async stop() {
    this.stopped = true
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    if (this.readyTimer) clearTimeout(this.readyTimer)
    for (const lines of this.lines) lines.close()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
        }, 2000)
        child.once("close", () => {
          clearTimeout(timer)
          resolve()
        })
        child.stdin.end()
        child.kill("SIGTERM")
      })
    this.child = undefined
    this.status = { connected: false, detail: "Stopped" }
  }
  async send(reply: ChannelReply) {
    if (!/^om_[A-Za-z0-9_-]+$/.test(reply.source.eventId)) throw new Error("Invalid Feishu reply message")
    const result = z
      .object({
        ok: z.boolean(),
        data: z.object({ message_id: z.string().optional() }).optional(),
        error: z.object({ message: z.string().optional() }).optional(),
      })
      .parse(
        JSON.parse(
          await this.run(
            this.config.cli,
            [
              "im",
              "+messages-reply",
              "--message-id",
              reply.source.eventId,
              "--markdown",
              reply.text,
              "--reply-in-thread",
              "--idempotency-key",
              reply.id,
              "--as",
              "bot",
              "--format",
              "json",
            ],
            undefined,
            this.controller.signal,
          ),
        ),
      )
    if (!result.ok) throw new Error(result.error?.message ?? "Feishu reply rejected")
    return { messageId: result.data?.message_id ?? reply.id }
  }
}
