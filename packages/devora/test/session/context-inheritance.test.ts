import { describe, expect, test } from "bun:test"
import { Info } from "../../src/session/session"
import { Identifier } from "../../src/id/id"
import { SessionID, MessageID } from "../../src/session/schema"

describe("Session context inheritance", () => {
  test("Session.Info accepts contextFrom and contextWatermark fields", () => {
    const sessionId = Identifier.descending("session")
    const parentSessionId = SessionID.make(Identifier.descending("session"))
    const parentMessageId = MessageID.make(Identifier.ascending("message"))
    const result = Info.safeParse({
      id: sessionId,
      slug: "test",
      projectID: "proj",
      directory: "/tmp",
      title: "test",
      version: "1.0.0",
      time: { created: 1, updated: 1 },
      contextFrom: parentSessionId,
      contextWatermark: parentMessageId,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.contextFrom).toBe(parentSessionId)
      expect(result.data.contextWatermark).toBe(parentMessageId)
    }
  })

  test("Session.Info contextFrom and contextWatermark are optional", () => {
    const sessionId = Identifier.descending("session")
    const result = Info.safeParse({
      id: sessionId,
      slug: "test",
      projectID: "proj",
      directory: "/tmp",
      title: "test",
      version: "1.0.0",
      time: { created: 1, updated: 1 },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.contextFrom).toBeUndefined()
      expect(result.data.contextWatermark).toBeUndefined()
    }
  })
})
