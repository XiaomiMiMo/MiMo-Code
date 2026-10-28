// An embedding host that renders a conversation before the engine has created its
// session brings its own `ses_` id, so the row is never rewritten after the fact.
// Spec: docs/compose/spec/client-supplied-session-id.md
import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

const run = AppRuntime.runPromise

/** The id shape documented for hosts: `ses_` + 16 hex + 10 base62, no v2 sort marker. */
const SESSION_ID_SHAPE = /^ses_[0-9a-f]{16}[0-9A-Za-z]{10}$/

describe("client-supplied session id", () => {
  test("persists the session under the supplied id and leaves the generated path alone", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const supplied = SessionID.descending()
        const owned = await run(Session.Service.use((svc) => svc.create({ id: supplied })))

        expect(owned.id).toBe(supplied)
        // Read back through a fresh lookup: the projection must have written this id,
        // not a regenerated one.
        expect((await run(Session.Service.use((svc) => svc.get(supplied)))).id).toBe(supplied)

        const generated = await run(Session.Service.use((svc) => svc.create()))
        expect(generated.id).not.toBe(supplied)
        expect(generated.id).toMatch(SESSION_ID_SHAPE)
      },
    })
  })

  test("rejects an id that already exists instead of merging into it", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const supplied = SessionID.descending()
        await run(Session.Service.use((svc) => svc.create({ id: supplied })))

        // The create is rejected as a defect (a plain thrown Error), so surface its message.
        const failure = await run(
          Session.Service.use((svc) => svc.create({ id: supplied })).pipe(
            Effect.catchCause((cause) => Effect.succeed(String(Cause.squash(cause)))),
          ),
        )
        expect(failure).toContain(supplied)
        expect(failure).toContain("already exists")

        // The first session is untouched and still the only one under that id.
        expect((await run(Session.Service.use((svc) => svc.get(supplied)))).id).toBe(supplied)
      },
    })
  })

  test("engine-generated ids match the shape hosts must reproduce", () => {
    for (let i = 0; i < 20; i++) expect(Identifier.descending("session")).toMatch(SESSION_ID_SHAPE)
  })

  test("rejects a supplied id outside the documented shape", () => {
    // The body schema is what the HTTP route validates against, and the id later
    // becomes a session directory — so this is the boundary that keeps a host from
    // walking out of it.
    const generated = SessionID.descending()
    expect(Session.CreateInput.parse({ id: generated })).toEqual({ id: generated })
    // v1 ids (12 hex + 14 base62) are also 26 base62 characters — they stay accepted.
    const v1 = SessionID.zod.parse("ses_" + "0123456789ab" + "A".repeat(14))
    expect(Session.CreateInput.parse({ id: v1 })).toEqual({ id: v1 })

    // Wrong prefix.
    expect(() => Session.CreateInput.parse({ id: "msg_" + "a".repeat(26) })).toThrow()
    // Path separators and dot segments: `ses_../../../tmp/pwn` must never reach metaDir.
    expect(() => Session.CreateInput.parse({ id: "ses_../../../../tmp/pwn" })).toThrow()
    expect(() => Session.CreateInput.parse({ id: "ses_" + "a".repeat(25) + "/" })).toThrow()
    // The payload is exactly 26 characters.
    expect(() => Session.CreateInput.parse({ id: "ses_" + "a".repeat(24) })).toThrow()
    expect(() => Session.CreateInput.parse({ id: "ses_" + "a".repeat(27) })).toThrow()
  })
})
