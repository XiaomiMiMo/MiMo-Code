import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { StateFile } from "../src/state"
import { Submissions } from "../src/submissions"
import { FakeBackend, MemorySecrets } from "./doubles"

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "connector-"))
  const secrets = new MemorySecrets()
  const file = path.join(dir, "state")
  const backend = new FakeBackend()
  const state = new StateFile(file, secrets)
  return {
    dir,
    file,
    secrets,
    backend,
    state,
    submissions: new Submissions(backend, state),
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const send = { bindingId: "b1", sessionId: "ses_1", requestId: "r1", text: "hello", canSend: true }

describe("state file", () => {
  test("is encrypted at rest and survives a fresh reader with the same key", async () => {
    await using s = await setup()
    await s.state.update((state) => {
      state.submissions["k"] = { messageId: "msg_secret_marker", textSha256: "00", createdAt: Date.now() }
    })
    expect((await readFile(s.file, "utf8")).includes("msg_secret_marker")).toBe(false)
    const again = new StateFile(s.file, s.secrets)
    expect((await again.read()).submissions["k"].messageId).toBe("msg_secret_marker")
  })

  test("a state whose key is gone is reported, not replaced by an empty one", async () => {
    await using s = await setup()
    await s.state.update((state) => {
      state.consents["b"] = {} as never
    })
    s.secrets.values.clear()
    await expect(new StateFile(s.file, s.secrets).read()).rejects.toThrow("key is missing")
  })
})

describe("phone submissions", () => {
  test("accepted with the durable message ID, and a repeat never runs twice", async () => {
    await using s = await setup()
    const first = await s.submissions.send(send)
    expect(first).toEqual({ status: "accepted", messageId: s.backend.submits[0].messageId })
    const again = await s.submissions.send(send)
    expect(again).toEqual(first)
    expect(s.backend.submits).toHaveLength(1)
  })

  test("concurrent repeats share one submission", async () => {
    await using s = await setup()
    s.backend.submitDelayMs = 30
    const results = await Promise.all([s.submissions.send(send), s.submissions.send(send), s.submissions.send(send)])
    expect(s.backend.submits).toHaveLength(1)
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
  })

  test("the same request ID with other text is rejected and never submitted", async () => {
    await using s = await setup()
    await s.submissions.send(send)
    expect(await s.submissions.send({ ...send, text: "other" })).toEqual({ status: "rejected", reason: "invalid" })
    expect(s.backend.submits).toHaveLength(1)
  })

  test("the message ID is durable before the agent sees the text", async () => {
    await using s = await setup()
    s.backend.submit = async (sessionId, messageId) => {
      const stored = Object.values((await new StateFile(s.file, s.secrets).read()).submissions)
      expect(stored.map((x) => x.messageId)).toContain(messageId)
      s.backend.admitted.set(messageId, sessionId)
      return { kind: "accepted" }
    }
    expect((await s.submissions.send(send)).status).toBe("accepted")
  })

  test("an unknown outcome is resolved by a read-only lookup, never by sending again", async () => {
    await using s = await setup()
    s.backend.nextOutcome = { kind: "unknown" }
    expect(await s.submissions.send(send)).toEqual({ status: "unknown" })
    const messageId = s.backend.submits[0].messageId
    // The agent did admit it after all; status finds it without a second submit.
    s.backend.admitted.set(messageId, "ses_1")
    expect(await s.submissions.status(send)).toEqual({ status: "accepted", messageId })
    expect(s.backend.submits).toHaveLength(1)
  })

  test("status without a record is unknown; read-only grants and missing sessions are rejected", async () => {
    await using s = await setup()
    expect(await s.submissions.status({ bindingId: "b1", sessionId: "ses_1", requestId: "nope" })).toEqual({ status: "unknown" })
    expect(await s.submissions.send({ ...send, canSend: false })).toEqual({ status: "rejected", reason: "read-only" })
    expect(await s.submissions.send({ ...send, requestId: "r2", sessionId: "ses_gone" })).toEqual({
      status: "rejected",
      reason: "invalid",
    })
    expect(s.backend.submits).toHaveLength(0)
  })

  test("a proven rejection from the agent is passed through", async () => {
    await using s = await setup()
    s.backend.nextOutcome = { kind: "rejected", reason: "busy" }
    expect(await s.submissions.send(send)).toEqual({ status: "rejected", reason: "busy" })
  })
})
