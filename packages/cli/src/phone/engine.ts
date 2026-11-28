// The server API the phone backend needs, over the SDK client the TUI already
// holds (in the TUI that client reaches the in-process server, so no network
// port or password is involved).

import type { OpencodeClient } from "@mimo-ai/sdk/v2"
import { MESSAGE_LIMIT, type EngineApi, type Receipt } from "./backend"

export function engineFrom(client: () => OpencodeClient): EngineApi {
  return {
    async listSessions(since) {
      return (await client().session.list({ start: since, roots: true }, { throwOnError: true })).data
    },
    async messages(sessionId) {
      const messages = (await client().session.messages({ sessionID: sessionId }, { throwOnError: true })).data
      return { messages, complete: messages.length < MESSAGE_LIMIT }
    },
    async status() {
      return (await client().session.status(undefined, { throwOnError: true })).data
    },
    async receipt(sessionId, messageId) {
      const result = await client().session.receiptByMessage({ sessionID: sessionId, messageID: messageId })
      if (result.response?.status === 404) return undefined
      if (!result.data) throw new Error(`receipt lookup failed: ${result.response?.status ?? "no response"}`)
      return result.data as Receipt
    },
    async promptAsync(input) {
      const result = await client().session.promptAsync(input)
      return result.response?.status ?? 0
    },
  }
}
