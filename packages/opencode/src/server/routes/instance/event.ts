import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "@/project/instance"
import { registerDisposer } from "@/effect/instance-registry"

const log = Log.create({ service: "server" })

// Cap on buffered SSE events per connection. Bounds worst-case memory for a
// stalled consumer while tolerating normal streaming bursts (the heaviest
// producer is per-token PartDelta during streaming). At ~1KB/event the default
// is ≈10MB worst-case per stalled connection. Tune via env if needed.
//
// Note: the heartbeat and the disconnect sentinel also travel through this
// queue. Under sustained saturation (drop-oldest active) both lag behind up to
// EVENT_QUEUE_CAPACITY buffered items, so heartbeats no longer arrive on a
// strict 10s cadence for that connection. This is acceptable: a saturated
// stream is not the idle-stream case the heartbeat exists to keep alive, and a
// proxy that drops the stalled connection just triggers the durable /sync
// catch-up path on reconnect.
const EVENT_QUEUE_CAPACITY = Number(process.env["MIMOCODE_EVENT_QUEUE_CAPACITY"]) || 10_000

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      const directory = Instance.directory
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        // Bounded buffer: the bus delta firehose (per-token PartDelta) is pushed
        // here synchronously and never blocks the producer. A slow/stalled SSE
        // consumer would otherwise let this grow without limit and exhaust the
        // server's memory. Events are best-effort telemetry (DB is authoritative
        // + heartbeat), so drop-oldest is safe under sustained backpressure.
        const q = new AsyncQueue<string | null>({ capacity: EVENT_QUEUE_CAPACITY })
        let done = false

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        let unregister = () => {}
        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unregister()
          unsub()
          q.push(null)
          if (q.dropped > 0) log.warn("event dropped under backpressure", { dropped: q.dropped })
          log.info("event disconnected", { buffered: q.size })
        }

        const unsub = Bus.subscribeAll((event) => {
          q.push(JSON.stringify(event))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        // Bus shutdown can discard a queued disposal event; abort also interrupts a backpressured write.
        unregister = registerDisposer(async (disposed) => {
          if (disposed === directory) stream.abort()
        })
        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
