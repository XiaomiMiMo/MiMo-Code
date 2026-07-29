/**
 * Regression: the overflow gate's compaction FALLBACK used to re-fire forever.
 *
 * prune's max-threshold signal (maxCrossed, read via prune.maxThresholdCrossed)
 * is a one-shot request meaning "reduce this context". Its only reader is the
 * overflow gate in runLoop, and that gate always acts on it: it rebuilds when a
 * checkpoint boundary can be produced, and compacts when the writer it just
 * waited on produced nothing. Only the rebuild branch discharged the request
 * (rebuildFromCheckpoint -> prune.resetThresholds); the "writer-failed"
 * compaction fallback did not.
 *
 * That fallback runs precisely when the watermark is unset — no writer has ever
 * succeeded — so in that state nothing else was going to clear the signal
 * either: the in-place retry only clears while under the writer-failure cap, and
 * once the cap is reached every later crossing re-adds maxCrossed. The gate then
 * re-fired on the standing request on essentially every iteration, each time
 * inserting a fresh compaction boundary AND starting another doomed writer.
 *
 * These tests drive the REAL runLoop against a scripted HTTP LLM stub (the
 * established pattern — see main-runloop-history-invariant.test.ts) because what
 * is under test is loop control flow, not a pure function: whether the gate
 * re-fires depends on skipOverflowCheck, on lastFinished, and on the
 * `lastFinished.summary !== true` guard. Only a real loop settles whether those
 * self-limit, and they do not — the fallback inserts a USER boundary, and the
 * summary assistant that compaction.process then produces blocks the gate for
 * exactly one iteration before the cycle resumes.
 *
 * Measured on this file before the fix, with max_writer_failures = 1: 24
 * fallback compactions across 24 scripted tool steps and 12 across 12 — one per
 * iteration, i.e. LINEAR IN TURN LENGTH. After the fix: 1 in both, so the count
 * is bounded by the writer-failure budget instead of by how long the turn runs.
 * That length-independence, not the literal 1, is the invariant.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(
  fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service | SessionCheckpoint.Service>,
) {
  return Effect.runPromise(
    fx.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, SessionCheckpoint.defaultLayer),
      ),
    ),
  )
}

const chunk = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}\n\n`

// The provider sends stream_options.include_usage, so a trailing usage-only
// chunk is what puts a chosen token total on the assistant message — and that
// total is the whole input to the checkpoint ladder.
const usageChunk = (promptTokens: number) =>
  chunk({
    id: "c",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: 100, total_tokens: promptTokens + 100 },
  })

function toolCallLines(id: string, name: string, args: string, promptTokens: number): string[] {
  return [
    chunk({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] }),
    chunk({
      id: "c",
      object: "chat.completion.chunk",
      choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }],
    }),
    chunk({
      id: "c",
      object: "chat.completion.chunk",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }],
    }),
    chunk({ id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    usageChunk(promptTokens),
    "data: [DONE]\n\n",
  ]
}

function textStopLines(text: string, promptTokens: number): string[] {
  return [
    chunk({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] }),
    chunk({ id: "c", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] }),
    chunk({ id: "c", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] }),
    usageChunk(promptTokens),
    "data: [DONE]\n\n",
  ]
}

/** compaction.ts's summarizer template. A request carrying it is the compaction
 * summarization, which MUST be answered with plain text: answering it with a
 * tool call trips processor.ts's "Tool call not allowed while generating
 * summary" guard, ending the turn for a harness reason and hiding the loop under
 * test. Asserted to have been seen, so a reworded template shows up as a failed
 * expectation rather than as a silently different run. */
const SUMMARIZE_MARKER = "When constructing the summary"

/** checkpoint.ts composeWriterPrompt's preamble. Requests carrying it are the
 * checkpoint WRITER's own LLM calls, failed here with a NON-retryable 400 so the
 * writer can never succeed — the precondition of the whole scenario. A retryable
 * status would be wrong: the session retry ladder would keep retrying it and the
 * turn would never progress. */
const WRITER_MARKER = "operating in checkpoint-writer mode"

function startStub(opts: { toolSteps: number; promptTokens: number; readPath: string }) {
  const calls: ("summarize" | "tool" | "stop" | "writer-denied")[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 })
      const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }> }
      const raw = JSON.stringify(body.messages)
      if (raw.includes(WRITER_MARKER)) {
        calls.push("writer-denied")
        return new Response(
          JSON.stringify({ error: { message: "checkpoint writer denied by test", type: "invalid_request_error" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        )
      }
      let lines: string[]
      if (raw.includes(SUMMARIZE_MARKER)) {
        calls.push("summarize")
        lines = textStopLines("## Goal\nPrior work, summarized.\n", 400)
      } else if (calls.filter((c) => c === "tool").length < opts.toolSteps) {
        calls.push("tool")
        lines = toolCallLines(
          `call_${calls.length}`,
          "read",
          JSON.stringify({ filePath: opts.readPath }),
          opts.promptTokens,
        )
      } else {
        calls.push("stop")
        lines = textStopLines("done.", opts.promptTokens)
      }
      const enc = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            for (const l of lines) ctrl.enqueue(enc.encode(l))
            ctrl.close()
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  return {
    get origin() {
      return server.url.origin
    },
    calls,
    stop: () => server.stop(true),
  }
}

/**
 * One turn against the stub.
 *
 * `watermark` is returned so callers assert the precondition rather than assume
 * it: with a watermark set, rebuildEnsuringCheckpoint would report "rebuilt" and
 * the fallback under test would never be reached at all.
 */
async function driveTurn(opts: {
  title: string
  thresholds: string[]
  toolSteps: number
  promptTokens: number
  maxWriterFailures: number
}) {
  await using tmp = await tmpdir({ git: true })
  const readPath = path.join(tmp.path, "README.md")
  const stub = startStub({ toolSteps: opts.toolSteps, promptTokens: opts.promptTokens, readPath })
  try {
    await Bun.write(readPath, "# Hello\n")
    await Bun.write(
      path.join(tmp.path, "mimocode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
        agent: { build: { model: "alibaba/qwen-plus" } },
        checkpoint: { thresholds: opts.thresholds, max_writer_failures: opts.maxWriterFailures },
      }),
    )
    return await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const checkpoint = yield* SessionCheckpoint.Service
            const session = yield* sessions.create({ title: opts.title })
            yield* prompt.prompt({
              sessionID: session.id,
              agent: "build",
              parts: [{ type: "text", text: "Please keep reading the README." }],
            })
            const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const watermark = yield* checkpoint
              .lastBoundary(session.id)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            return {
              watermark,
              calls: [...stub.calls],
              toolSteps: stub.calls.filter((c) => c === "tool").length,
              compactions: msgs.filter((m) => m.parts.some((p) => p.type === "compaction")).length,
            }
          }),
        ),
    })
  } finally {
    await stub.stop()
  }
}

// qwen-plus reports limit.context 1_000_000, so usable is 960_000: a
// 35_100-token step is far below hard overflow (isOverflow === false at that
// count), which is what makes the max-threshold signal the ONLY thing that can
// open the gate in the crossed case.
const PROMPT_TOKENS = 35_000
// One allowed writer attempt, so the failure cap is reached on the first failure
// and the in-place retry stops clearing the signal immediately. Explicit rather
// than relying on the default, so the expected count below is arithmetic and not
// a snapshot.
const MAX_WRITER_FAILURES = 1

describe("overflow gate: the compaction fallback is discharged, not re-fired", () => {
  test(
    "with a writer that can never succeed, fallback compactions do not grow with turn length",
    async () => {
      const short = await driveTurn({
        title: "fallback-loop short",
        thresholds: ["20K", "30K"],
        toolSteps: 12,
        promptTokens: PROMPT_TOKENS,
        maxWriterFailures: MAX_WRITER_FAILURES,
      })
      const long = await driveTurn({
        title: "fallback-loop long",
        thresholds: ["20K", "30K"],
        toolSteps: 24,
        promptTokens: PROMPT_TOKENS,
        maxWriterFailures: MAX_WRITER_FAILURES,
      })

      // Non-vacuity: the writer never succeeded in either run, so no boundary
      // exists and the gate's rebuild branch could never insert. This is THE
      // precondition — without it the test could pass simply because rebuilds were
      // working. It holds whether the writer was spawned and denied or could not
      // be spawned at all: "never succeeds" is all the gate needs, and a sibling
      // file in this directory swaps spawnRef, so whether a writer process
      // actually starts is not stable across a multi-file run.
      expect(short.watermark == null).toBe(true)
      expect(long.watermark == null).toBe(true)
      // Non-vacuity: the fallback really was reached, and reached the summarizer
      // that follows it — so the stub's summarize discriminator still matches the
      // template it keys on.
      expect(short.compactions).toBeGreaterThan(0)
      expect(short.calls).toContain("summarize")
      // Non-vacuity: both turns really did run to their full scripted length, so
      // "long" is genuinely the longer turn.
      expect(short.toolSteps).toBe(12)
      expect(long.toolSteps).toBe(24)

      // THE REGRESSION. The fallback discharges the signal it served, so the
      // count is bounded by the writer-failure budget and is INDEPENDENT of how
      // long the turn runs. Before the fix the signal stood and the gate re-fired
      // on it every iteration: 12 compactions in the short turn and 24 in the
      // long one — exactly one per iteration, linear in turn length.
      expect(long.compactions).toBe(short.compactions)
      expect(long.compactions).toBeLessThanOrEqual(MAX_WRITER_FAILURES)
      expect(long.compactions).toBe(1)
    },
    900_000,
  )

  test(
    "control: an identical run whose thresholds are never crossed compacts zero times",
    async () => {
      const never = await driveTurn({
        title: "fallback-loop control",
        thresholds: ["500K", "600K"],
        toolSteps: 24,
        promptTokens: PROMPT_TOKENS,
        maxWriterFailures: MAX_WRITER_FAILURES,
      })

      // Same model, same token report, same script — only the ladder moved out of
      // reach. Zero compactions here is what attributes the other case's
      // compactions to the max-threshold signal rather than to hard overflow.
      expect(never.watermark == null).toBe(true)
      expect(never.toolSteps).toBe(24)
      expect(never.compactions).toBe(0)
      expect(never.calls).not.toContain("summarize")
    },
    900_000,
  )
})
