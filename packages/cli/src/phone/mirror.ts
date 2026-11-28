// A live copy of one session's main conversation for the phone connector.
//
// It is loaded once from the message list and then kept current from the
// event stream, so a streaming reply costs one event per token instead of a
// full re-read. Events cannot be ordered against a load that is in flight, so
// the mirror never guesses: structural events seen during a load trigger
// another load, and streamed text is only appended to parts whose creation the
// mirror itself observed. A part that was already streaming when the mirror
// loaded keeps its stored text until the engine publishes the finished part.

import type { Event, Message, Part } from "@mimo-ai/sdk/v2"

export type MessageWithParts = { info: Message; parts: Part[] }

/** Events that change a session's conversation, in the shape the event stream delivers them. */
export type ConversationEvent = Extract<
  Event,
  {
    type:
      | "message.updated"
      | "message.removed"
      | "message.part.updated"
      | "message.part.delta"
      | "message.part.removed"
      | "session.compacted"
  }
>

const MAIN = "main"

export class SessionMirror {
  private readonly messages = new Map<string, { info: Message; parts: Map<string, Part> }>()
  /** Parts whose text deltas may be appended: their creation was seen after the last load. */
  private readonly live = new Set<string>()
  private loading: Promise<void> | undefined
  private inFlight = false
  private changedDuringLoad = false
  private loaded = false
  /** The last load could not prove it holds the whole conversation. */
  truncated = false

  constructor(
    readonly sessionId: string,
    private readonly read: (sessionId: string) => Promise<{ messages: MessageWithParts[]; complete: boolean }>,
  ) {}

  /** Load if needed and settle any load that raced with structural events. */
  async ready(): Promise<void> {
    for (let attempt = 0; !this.loaded || this.changedDuringLoad; attempt++) {
      if (attempt >= 3) break
      await this.load()
    }
  }

  /** Apply one event; returns whether it concerned this session. */
  apply(event: ConversationEvent): boolean {
    if (event.properties.sessionID !== this.sessionId) return false
    if (this.inFlight) {
      // Text deltas during a load are covered by the finished part; anything
      // else may or may not be in the loaded copy, so load again.
      if (event.type !== "message.part.delta") this.changedDuringLoad = true
      return true
    }
    if (!this.loaded) return true
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info
        if ((info.agentID ?? MAIN) !== MAIN) return true
        const entry = this.messages.get(info.id)
        if (entry) entry.info = info
        else this.messages.set(info.id, { info, parts: new Map() })
        return true
      }
      case "message.removed":
        this.messages.delete(event.properties.messageID)
        return true
      case "message.part.updated": {
        // A private copy: deltas are appended in place, and the event object is shared with other listeners.
        const part = structuredClone(event.properties.part)
        const entry = this.messages.get(part.messageID)
        if (!entry) return true
        entry.parts.set(part.id, part)
        this.live.add(part.id)
        return true
      }
      case "message.part.delta": {
        const { messageID, partID, field, delta } = event.properties
        const part = this.messages.get(messageID)?.parts.get(partID)
        if (!part || !this.live.has(partID) || field !== "text" || part.type !== "text") return true
        part.text = (part.text ?? "") + delta
        return true
      }
      case "message.part.removed":
        this.messages.get(event.properties.messageID)?.parts.delete(event.properties.partID)
        return true
      case "session.compacted":
        this.loaded = false
        return true
    }
  }

  /** Messages in conversation order, each with its parts in order. */
  conversation(): MessageWithParts[] {
    return [...this.messages.values()]
      .sort((a, b) => compare(a.info.id, b.info.id))
      .map(({ info, parts }) => ({ info, parts: [...parts.values()].sort((a, b) => compare(a.id, b.id)) }))
  }

  private load(): Promise<void> {
    if (this.loading) return this.loading
    this.changedDuringLoad = false
    // In flight before the read starts, so no event can slip in between.
    this.inFlight = true
    this.loading = this.read(this.sessionId)
      .then(({ messages, complete }) => {
        this.messages.clear()
        this.live.clear()
        for (const { info, parts } of messages) {
          if ((info.agentID ?? MAIN) !== MAIN) continue
          this.messages.set(info.id, { info, parts: new Map(parts.map((part) => [part.id, structuredClone(part)])) })
        }
        this.truncated = !complete
        this.loaded = true
      })
      .finally(() => {
        this.inFlight = false
        this.loading = undefined
      })
    return this.loading
  }
}

/** Engine IDs are ascending strings; order them by code unit like the engine does. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
