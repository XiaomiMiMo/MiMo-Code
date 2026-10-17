import { describe, expect, test } from "bun:test"
import z from "zod"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { WorkspaceID } from "../../src/control-plane/schema"
import { updateSchema } from "../../src/util/update-schema"

describe("updateSchema", () => {
  test("makes every field optional and nullable without weakening supplied value constraints", () => {
    const original = z.object({ name: z.string().min(1), count: z.number().int().optional() })
    const update = updateSchema(original)
    expect(update.parse({})).toEqual({})
    expect(update.parse({ name: "next" })).toEqual({ name: "next" })
    expect(update.parse({ name: null, count: null })).toEqual({ name: null, count: null })
    expect(update.parse({ name: undefined })).toEqual({ name: undefined })
    expect(update.safeParse({ name: "" }).success).toBe(false)
    expect(update.safeParse({ name: 1 }).success).toBe(false)
    expect(update.safeParse({ count: 1.5 }).success).toBe(false)
    expect(original.safeParse({}).success).toBe(false)
    expect(original.safeParse({ name: null }).success).toBe(false)
  })

  test("composes nested partial objects explicitly while untouched nested objects retain their schema", () => {
    const original = z.object({
      time: z.object({ created: z.number(), updated: z.number(), archived: z.number().optional() }),
      location: z.object({ directory: z.string(), branch: z.string() }),
    })
    const update = updateSchema(original).extend({ time: updateSchema(original.shape.time).optional() })
    expect(update.parse({ time: { updated: 42 } })).toEqual({ time: { updated: 42 } })
    expect(update.parse({ time: { archived: null } })).toEqual({ time: { archived: null } })
    expect(update.parse({ time: {} })).toEqual({ time: {} })
    expect(update.parse({ location: null })).toEqual({ location: null })
    expect(update.safeParse({ time: { updated: "42" } }).success).toBe(false)
    expect(update.safeParse({ time: null }).success).toBe(false)
    expect(update.safeParse({ location: { directory: "/tmp" } }).success).toBe(false)
  })

  for (const [name, event] of [["revisioned", Session.Event.Updated], ["legacy", Session.LegacyUpdated]] as const) {
    test(`${name} session updates accept real workspace, time, share and clearing patches`, () => {
      const sessionID = SessionID.descending()
      for (const info of [
        { workspaceID: WorkspaceID.ascending() },
        { workspaceID: null },
        { time: { updated: 42 } },
        { time: { archived: null } },
        { share: { url: "https://example.test/share" } },
        { share: { url: null } },
        { permission: null },
      ]) expect(event.schema.parse({ sessionID, info })).toEqual({ sessionID, info })
      expect(event.schema.safeParse({ sessionID, info: { time: { updated: "bad" } } }).success).toBe(false)
      expect(event.schema.safeParse({ sessionID, info: { workspaceID: 1 } }).success).toBe(false)
    })
  }
})
