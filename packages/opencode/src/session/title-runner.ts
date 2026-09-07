import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { Effect, Stream } from "effect"
import type { ModelMessage } from "ai"

export type TitleReference = { name: string; path: string }
export const TITLE_PURPOSE_SIGNAL = "<!-- thread-purpose-changed -->"

export function createTitleReviewGate() {
  const turns = new Map<string, { messageID: string; revision: number; count: number }>()
  return (sessionID: string, messageID: string, revision: number, signaled: boolean) => {
    const previous = turns.get(sessionID)
    if (previous?.messageID === messageID) return false
    const count = signaled ? (previous?.revision === revision ? previous.count : 0) + 1 : 0
    turns.set(sessionID, { messageID, revision, count: count >= 2 ? 0 : count })
    return count >= 2
  }
}

// No registry/plugin lookup, permission escalation, globbing or directory walk.
// A capability consists of the exact absolute path supplied by this user turn.
export function createTitleReader(references: readonly TitleReference[]) {
  const allowed = new Set(references.filter(ref => path.isAbsolute(ref.path)).map(ref => ref.path))
  let remaining = 32 * 1024
  return async (filename: string) => {
    if (!allowed.has(filename)) throw new Error("Title resource not authorized")
    if (remaining <= 0) throw new Error("Title read budget exhausted")
    const limit = Math.min(16 * 1024, remaining)
    remaining -= limit // Reserve before awaits; parallel tool calls share this budget.
    if (await realpath(filename) !== filename) throw new Error("Title resource symlinks are not allowed")
    const identity = await lstat(filename)
    if (!identity.isFile()) throw new Error("Title resource is not a regular file")
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino || await realpath(filename) !== filename) throw new Error("Title resource changed during authorization")
      const bytes = Buffer.alloc(limit)
      const { bytesRead } = await file.read(bytes, 0, limit, 0)
      const content = bytes.subarray(0, bytesRead)
      if (/\.(?:pdf|zip|gz|dmg|png|jpe?g|gif|webp|mp[34]|wav|exe|dll|bin|docx?|xlsx?|pptx?)$/i.test(filename)
        || content.some(byte => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)))
        throw new Error("Binary title resource rejected")
      return new TextDecoder("utf-8", { fatal: true }).decode(content, { stream: bytesRead === limit })
    } finally {
      await file.close()
    }
  }
}

type TitleEvent = {
  type: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
}

// LLM.stream is one SDK step. Carry only local tool calls/results to the next
// step; never persist assistant/tool messages or allocate a child session.
export function runTitleSteps(
  initial: ModelMessage[],
  stream: (messages: ModelMessage[]) => Stream.Stream<TitleEvent, unknown>,
  candidate: () => unknown,
) {
  return Effect.gen(function* () {
    const messages = [...initial]
    for (let step = 0; step < 4; step++) {
      const events = yield* stream(messages).pipe(Stream.runCollect)
      if (events.some(event => event.type === "error" || event.type === "tool-error")) return
      const calls = events.filter(event => event.type === "tool-call")
      if (calls.some(event => event.toolName !== "read" && event.toolName !== "StructuredOutput")) return
      if (candidate() !== undefined) return candidate()
      if (!calls.length) return
      messages.push({ role: "assistant", content: calls.map(event => ({ type: "tool-call" as const, toolCallId: event.toolCallId!, toolName: event.toolName!, input: event.input })) })
      const results = events.filter(event => event.type === "tool-result")
      if (results.length) messages.push({ role: "tool", content: results.map(event => ({ type: "tool-result" as const, toolCallId: event.toolCallId!, toolName: event.toolName!, output: { type: "text" as const, value: typeof event.output === "string" ? event.output : JSON.stringify(event.output) } })) })
    }
  }).pipe(Effect.timeout(30_000), Effect.catchCause(() => Effect.succeed(undefined)))
}
