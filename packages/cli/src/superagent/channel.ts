import type { Source } from "./schema"
import type z from "zod"
import * as Engine from "./dispatcher"

export type ChannelInput = {
  eventId: string
  threadId: string
  senderId: string
  text: string
  human: boolean
  addressed: boolean
  ticketId?: string
  scopeId?: string
  threadKind?: "discussion" | "deliverable"
  url?: string
  closed?: "merged" | "closed"
}
export type ChannelThread = {
  threadId: string
  scopeId: string
  kind: "context" | "deliverable"
  url?: string
  closed?: "merged" | "closed"
}
export type ChannelReply = { id: string; source: z.infer<typeof Source>; text: string }
export interface ChannelAdapter {
  start(ingest: (input: ChannelInput) => Promise<void>): Promise<void>
  stop(): Promise<void>
  health(): { connected: boolean; detail?: string }
  send?(reply: ChannelReply): Promise<{ messageId: string }>
  resolveThread?(reference: string): Promise<ChannelThread>
  watch?(threadId: string): void
  readonly idempotentSend?: boolean
}
export type ChannelRegistration = {
  id: string
  directory: string
  allowedSenders: string[]
  allowedThreads: string[]
  adapter: ChannelAdapter
}
const channels = new Map<string, ChannelRegistration>()
export async function register(registration: ChannelRegistration) {
  if (channels.has(registration.id)) throw new Error("Channel instance already registered")
  channels.set(registration.id, registration)
  try {
    await registration.adapter.start(async (input) => {
      if (
        (input.human && !registration.allowedSenders.includes(input.senderId)) ||
        !registration.allowedThreads.includes(input.scopeId ?? input.threadId)
      )
        return
      if (input.closed) {
        Engine.threadClosed(registration.directory, registration.id, input.threadId, input.closed)
        return
      }
      Engine.ingest(
        registration.directory,
        {
          channel: registration.id,
          eventId: input.eventId,
          threadId: input.threadId,
          senderId: input.senderId,
          threadKind: input.threadKind,
          url: input.url,
        },
        input.text,
        input.human,
        input.addressed,
        input.ticketId,
      )
    })
    for (const t of Engine.list(registration.directory))
      for (const thread of t.subscriptions)
        if (thread.channel === registration.id && !Engine.terminal(t)) registration.adapter.watch?.(thread.threadId)
  } catch (error) {
    channels.delete(registration.id)
    throw error
  }
}
export async function unregister(id: string) {
  const c = channels.get(id)
  if (!c) return
  await c.adapter.stop()
  channels.delete(id)
}
export const list = (directory: string) =>
  [...channels.values()]
    .filter((c) => c.directory === directory)
    .map((c) => ({ id: c.id, ...c.adapter.health(), canReply: !!c.adapter.send }))
export async function send(directory: string, reply: ChannelReply) {
  if (reply.source.channel === "local") return { messageId: reply.id }
  const channel = channels.get(reply.source.channel)
  if (!channel || channel.directory !== directory || !channel.adapter.send)
    throw new Error("Reply Channel unavailable; inspect delivery before retrying")
  return channel.adapter.send(reply)
}
export function retryable(directory: string, channelId?: string) {
  if (channelId === "local") return true
  const channel = channelId ? channels.get(channelId) : undefined
  return channel?.directory === directory && channel.adapter.idempotentSend === true
}
export async function subscribe(directory: string, ticketId: string, channelId: string, reference: string) {
  const channel = channels.get(channelId)
  if (!channel || channel.directory !== directory || !channel.adapter.resolveThread)
    throw new Error("This workspace Channel cannot resolve thread references")
  const thread = await channel.adapter.resolveThread(reference)
  if (!channel.allowedThreads.includes(thread.scopeId))
    throw new Error("Thread is outside the configured Channel scope")
  const t = Engine.subscribe(directory, ticketId, { ...thread, channel: channelId })
  channel.adapter.watch?.(thread.threadId)
  return t
}
