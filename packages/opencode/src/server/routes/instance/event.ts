import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"
import { SessionRuntime } from "@/session/runtime"

const log = Log.create({ service: "server" })

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events; runtime=1 enables reliable runtime snapshots and sequence envelopes",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(z.union(BusEvent.payloads()).meta({ ref: "Event" })),
            },
          },
        },
      },
    }),
    async (c) => {
      const reliable = c.req.query("runtime") === "1"
      const runtime = reliable ? SessionRuntime.current() : undefined
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const capacity = Math.max(1, Number(process.env["MIMOCODE_EVENT_QUEUE_CAPACITY"]) || 10_000)
        const q = new AsyncQueue<string | null>({ capacity, overflow: reliable ? "reject" : "drop-oldest" })
        let done = false
        let unsubscribeRuntime = () => {}
        let unsub = () => {}
        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          unsubscribeRuntime()
          q.clear()
          q.push(null)
          log.info("event disconnected", { dropped: q.dropped })
        }
        const push = (event: unknown) => {
          if (done) return
          if (q.push(JSON.stringify(event))) return
          log.warn("runtime event overflow; disconnecting for snapshot recovery")
          stop()
          stream.abort()
        }
        const heartbeat = setInterval(() => push({ type: "server.heartbeat", properties: {} }), 10_000)
        unsub = Bus.subscribeAll((event) => {
          push(event)
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
            stream.abort()
          }
        })
        if (runtime) {
          unsubscribeRuntime = runtime.subscribe(push)
          push({ type: "runtime.ready", properties: { protocolVersion: 1, epoch: runtime.epoch } })
        }
        push({ type: "server.connected", properties: {} })
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
