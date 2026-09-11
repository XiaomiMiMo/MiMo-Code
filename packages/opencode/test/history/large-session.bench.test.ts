import { expect } from "bun:test"
import { randomBytes } from "node:crypto"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Database } from "../../src/storage"
import { History } from "../../src/history"
import { backfillAll } from "../../src/history/backfill"
import { DEFAULT_KINDS, type Kind } from "../../src/history/extract"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Opt-in, synthetic/in-memory only. Run from packages/opencode:
// HISTORY_BENCH=1 bun test test/history/large-session.bench.test.ts --timeout 120000
// Optional: HISTORY_BENCH_CASE, HISTORY_BENCH_MESSAGES, HISTORY_BENCH_IMAGES,
// HISTORY_BENCH_IMAGE_MIB (encoded base64 bytes, not decoded image bytes).
// First timings are first-use after seeding, NOT OS/disk-cache-cold measurements.
const it = testEffect(Layer.mergeAll(History.defaultLayer, CrossSpawnSpawner.defaultLayer))
const run = process.env.HISTORY_BENCH === "1" ? it.live : it.live.skip
const cases = ["none", "file", "attachment", "input", "output-default", "output-enabled"]

for (const variant of cases.filter((x) => !process.env.HISTORY_BENCH_CASE || x === process.env.HISTORY_BENCH_CASE)) {
  run(`synthetic history benchmark: ${variant}`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Fail closed even if someone changes the standard test preload later.
        expect(process.env.MIMOCODE_DB).toBe(":memory:")
        const client = Database.Client().$client
        const count = Number(process.env.HISTORY_BENCH_MESSAGES ?? 1000)
        const images = Number(process.env.HISTORY_BENCH_IMAGES ?? 6)
        const bytes = Math.floor((Number(process.env.HISTORY_BENCH_IMAGE_MIB ?? 8) * 1024 * 1024) / 4) * 4
        expect(Number.isInteger(count) && count > images + 20).toBe(true)
        expect(Number.isInteger(images) && images > 0 && images <= 11).toBe(true)
        expect(bytes > 0).toBe(true)
        const anchor = Math.floor(count / 2)
        const id = (i: number) => `msg_${String(i).padStart(8, "0")}`
        const kinds = new Set<Kind>(variant === "output-enabled" ? [...DEFAULT_KINDS, "tool_output"] : DEFAULT_KINDS)
        const timings: Record<string, number> = {}
        const measure = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const start = performance.now()
            const value = yield* effect
            timings[label] = Number((performance.now() - start).toFixed(2))
            return value
          })
        yield* measure(
          "seed_ms",
          Effect.sync(() => {
            client.exec("DELETE FROM history_fts; DELETE FROM part; DELETE FROM message; DELETE FROM session;")
            client
              .prepare(
                "INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,?,?,?)",
              )
              .run("bench", "/synthetic", "[]", 1, 1)
            client
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run("ses_bench", "bench", "bench", "/synthetic", "synthetic only", "1", 1, 1)
            const message = client.prepare(
              "INSERT INTO message(id,session_id,agent_id,data,time_created,time_updated) VALUES(?,?,?,?,?,?)",
            )
            const part = client.prepare(
              "INSERT INTO part(id,message_id,session_id,data,time_created,time_updated) VALUES(?,?,?,?,?,?)",
            )
            client.exec("BEGIN")
            for (let i = 0; i < count; i++) {
              message.run(id(i), "ses_bench", "main", JSON.stringify({ role: "assistant" }), i + 1, i + 1)
              part.run(
                `prt_${String(i).padStart(8, "0")}_text`,
                id(i),
                "ses_bench",
                JSON.stringify({ type: "text", text: `needle benchmark message ${i}` }),
                i + 1,
                i + 1,
              )
              if (i < anchor - 3 || i >= anchor - 3 + images) continue
              // Random bytes model high-entropy image base64; no actual image decoding is exercised.
              const url =
                variant === "none" ? "" : `data:image/png;base64,${randomBytes((bytes / 4) * 3).toString("base64")}`
              const file = {
                type: "file",
                mime: "image/png",
                filename: "synthetic.png",
                url,
                id: `attachment_${i}`,
                sessionID: "ses_bench",
                messageID: id(i),
              }
              const data =
                variant === "file"
                  ? file
                  : {
                      type: "tool",
                      tool: "synthetic_image",
                      callID: `call_${i}`,
                      state: {
                        status: "completed",
                        input: { prompt: "needle", ...(variant === "input" ? { image: url } : {}) },
                        output: variant.startsWith("output") ? `needle ${url}` : "needle image ready",
                        title: "synthetic",
                        metadata: {},
                        time: { start: i, end: i + 1 },
                        ...(variant === "attachment" ? { attachments: [file] } : {}),
                      },
                    }
              part.run(
                `prt_${String(i).padStart(8, "0")}_media`,
                id(i),
                "ses_bench",
                JSON.stringify(data),
                i + 1,
                i + 1,
              )
            }
            client.exec("COMMIT")
          }),
        )
        const history = yield* History.Service
        yield* measure("backfill_first_ms", backfillAll(kinds))
        yield* measure("backfill_repeat_ms", backfillAll(kinds))
        const search = () => history.search({ query: "needle", scope: "global", limit: 10 })
        expect((yield* measure("search_first_ms", search())).length).toBe(10)
        for (let n = 0; n < 3; n++) yield* measure(`search_warm_${n}_ms`, search())
        // Force hits on the large tool bodies instead of only short text rows.
        const mediaSearch = () =>
          history.search({ query: "needle", scope: "global", tool_name: "synthetic_image", limit: 10 })
        const mediaHits = yield* measure("search_media_first_ms", mediaSearch())
        expect(mediaHits.length).toBe(variant === "file" ? 0 : images)
        for (let n = 0; n < 3; n++) yield* measure(`search_media_warm_${n}_ms`, mediaSearch())
        yield* measure("around_without_media_ms", history.around({ message_id: id(10), before: 5, after: 5 }))
        const around = () => history.around({ message_id: id(anchor), before: 5, after: 5 })
        const result = yield* measure("around_first_ms", around())
        expect(result.messages.length).toBe(11)
        for (let n = 0; n < 3; n++) yield* measure(`around_warm_${n}_ms`, around())
        const outputBytes = result.messages.reduce(
          (sum, m) => sum + m.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0),
          0,
        )
        const load = client
          .prepare("SELECT count(*) AS parts, sum(length(CAST(data AS BLOB))) AS part_bytes FROM part")
          .get()
        const index = client
          .prepare("SELECT count(*) AS rows, sum(length(CAST(body AS BLOB))) AS body_bytes FROM history_fts")
          .get() as { rows: number; body_bytes: number }
        // backfill logs and swallows session errors: explicitly reject partial indexing.
        expect(index.rows).toBe(count + (variant === "file" ? 0 : images))
        expect(index.body_bytes).toBeLessThan(bytes * images)
        expect(outputBytes).toBeLessThan(20 * 1024)
        expect(mediaHits.every((h) => Buffer.byteLength(h.snippet) < 3200)).toBe(true)
        console.log(
          "HISTORY_BENCH",
          JSON.stringify({
            variant,
            messages: count,
            images: variant === "none" ? 0 : images,
            base64_bytes_per_image: variant === "none" ? 0 : bytes,
            load,
            index,
            around_text_bytes: outputBytes,
            timings,
            rss_bytes: process.memoryUsage().rss,
            bun: Bun.version,
          }),
        )
        client.exec("DELETE FROM history_fts; DELETE FROM part; DELETE FROM message; DELETE FROM session;")
      }),
    ),
  )
}
