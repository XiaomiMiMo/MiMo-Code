import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PromptInput, SessionPrompt, hasSubstantiveContent } from "../../src/session/prompt"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

// ---------------------------------------------------------------------------
// Schema: PromptInput.parts must have at least one element
// ---------------------------------------------------------------------------
describe("PromptInput.parts schema", () => {
  const base = { sessionID: "sess_test" }

  test("rejects empty parts array", () => {
    const result = PromptInput.safeParse({ ...base, parts: [] })
    expect(result.success).toBe(false)
  })

  test("accepts a single text part", () => {
    const result = PromptInput.safeParse({
      ...base,
      parts: [{ type: "text", text: "hello" }],
    })
    expect(result.success).toBe(true)
  })

  test("accepts a single file part", () => {
    const result = PromptInput.safeParse({
      ...base,
      parts: [{ type: "file", url: "file:///tmp/x.png", mime: "image/png" }],
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// hasSubstantiveContent — production-side guard
// ---------------------------------------------------------------------------
describe("hasSubstantiveContent", () => {
  const makePart = (overrides: Partial<MessageV2.Part> = {}): MessageV2.Part =>
    ({
      id: "p1",
      messageID: "m1",
      sessionID: "s1",
      type: "text",
      text: "",
      synthetic: false,
      time: { start: 0, end: 0 },
      ...overrides,
    }) as MessageV2.Part

  // --- cases that should be rejected (no substantive content) ---

  test("empty parts array → false", () => {
    expect(hasSubstantiveContent([])).toBe(false)
  })

  test("text with empty string → false", () => {
    expect(hasSubstantiveContent([makePart({ type: "text", text: "" })])).toBe(false)
  })

  test("text with whitespace only → false", () => {
    expect(hasSubstantiveContent([makePart({ type: "text", text: "   \n\t  " })])).toBe(false)
  })

  test("ignored text with non-empty content → false", () => {
    expect(
      hasSubstantiveContent([makePart({ type: "text", text: "some text", ignored: true })]),
    ).toBe(false)
  })

  test("text/plain file → false (droppable by send-side filter)", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "file", url: "file:///tmp/x.txt", mime: "text/plain" } as any),
      ]),
    ).toBe(false)
  })

  test("application/x-directory file → false (droppable)", () => {
    expect(
      hasSubstantiveContent([
        makePart({
          type: "file",
          url: "file:///tmp/dir",
          mime: "application/x-directory",
        } as any),
      ]),
    ).toBe(false)
  })

  test("only ignored text + text/plain file → false", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "text", text: "real content", ignored: true }),
        makePart({ type: "file", url: "file:///tmp/x.txt", mime: "text/plain" } as any),
      ]),
    ).toBe(false)
  })

  // --- cases that should be accepted (substantive content) ---

  test("non-empty non-ignored text → true", () => {
    expect(
      hasSubstantiveContent([makePart({ type: "text", text: "hello world" })]),
    ).toBe(true)
  })

  test("image file → true", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "file", url: "data:image/png;base64,abc", mime: "image/png" } as any),
      ]),
    ).toBe(true)
  })

  test("application/pdf file → true", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "file", url: "file:///tmp/doc.pdf", mime: "application/pdf" } as any),
      ]),
    ).toBe(true)
  })

  test("checkpoint part → true", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "checkpoint" } as any),
      ]),
    ).toBe(true)
  })

  test("compaction part → true", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "compaction" } as any),
      ]),
    ).toBe(true)
  })

  test("subtask part → true", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "subtask" } as any),
      ]),
    ).toBe(true)
  })

  test("ignored text alongside real text → true (real text wins)", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "text", text: "ignored", ignored: true }),
        makePart({ type: "text", text: "real content" }),
      ]),
    ).toBe(true)
  })

  test("empty text alongside image → true (image wins)", () => {
    expect(
      hasSubstantiveContent([
        makePart({ type: "text", text: "" }),
        makePart({ type: "file", url: "data:image/png;base64,abc", mime: "image/png" } as any),
      ]),
    ).toBe(true)
  })

  test("oversized image that becomes text placeholder is still substantive", () => {
    // When an oversized/undecodable image is processed, it becomes a text part
    // with content like "ERROR: Image file is empty or corrupted..." — this is
    // non-empty text and should be substantive.
    expect(
      hasSubstantiveContent([
        makePart({
          type: "text",
          text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
        }),
      ]),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: dropped empty message must NOT run a model turn
// ---------------------------------------------------------------------------
describe("prompt short-circuits on empty-content message", () => {
  test("whitespace-only text skips loop and returns empty parts", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "   \n\t  " }],
            })

            // The returned message should have empty parts (dropped)
            expect(msg.parts).toHaveLength(0)

            // No assistant message should exist — loop() was never called
            const msgs = yield* sessions.messages({ sessionID: session.id })
            const assistants = msgs.filter((m) => m.info.role === "assistant")
            expect(assistants).toHaveLength(0)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })

  test("ignored-only text skips loop and returns empty parts", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "real content", ignored: true }],
            })

            expect(msg.parts).toHaveLength(0)

            const msgs = yield* sessions.messages({ sessionID: session.id })
            const assistants = msgs.filter((m) => m.info.role === "assistant")
            expect(assistants).toHaveLength(0)

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })

  test("non-empty text still runs loop (normal path)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const prompt = yield* SessionPrompt.Service
            const sessions = yield* Session.Service
            const session = yield* sessions.create({})

            // noReply: true so loop() is skipped, but parts should be non-empty
            const msg = yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              noReply: true,
              parts: [{ type: "text", text: "hello" }],
            })

            expect(msg.parts.length).toBeGreaterThan(0)
            expect(msg.info.role).toBe("user")

            yield* sessions.remove(session.id)
          }),
        ),
    })
  })
})
