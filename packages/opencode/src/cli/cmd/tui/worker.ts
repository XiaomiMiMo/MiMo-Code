import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config"
import { GlobalBus } from "@/bus/global"
import { Flag, clearGeneratedServerPassword, generateServerPassword } from "@/flag/flag"
import { LLMServerTokens } from "@/llm-server/tokens"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { SessionCheckpoint } from "@/session/checkpoint"
import { ensureProcessMetadata } from "@/util/mimo-process"

ensureProcessMetadata("worker")

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
let serverPromise: ReturnType<typeof Server.listen> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input?: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    // Idempotent. The previous behaviour was to stop and rebind, which moves the port
    // out from under whoever is already talking to it — and now that a listener is
    // bound unasked, a second caller is the normal case rather than a mistake.
    // Memoized: two calls arriving before the first `await Server.listen` resolves
    // must not both pass the guard and create two listeners.
    if (server) return { url: server.url.toString() }
    if (!serverPromise) {
      // No input means nobody asked for a reachable server: we are binding one anyway so
      // that the `/v1` capability API exists at all (it is only reachable over a socket,
      // and a consumer spawned mid-session cannot ask for one retroactively). That makes
      // every other instance route reachable by any process running as this user, so it
      // gets a credential first — generated before `listen`, never after.
      if (!input) generateServerPassword()
      serverPromise = Server.listen(input ?? { port: 0, hostname: "127.0.0.1" })
    }
    server = await serverPromise

    // Advertised for a human at a shell (`mimo llm-server issue` prints it). A child
    // process is told its endpoint directly and does not read this.
    await LLMServerTokens.publish(process.cwd(), {
      pid: process.pid,
      hostname: server.hostname,
      port: server.port,
      url: server.url.toString(),
      started: Date.now(),
    }).catch((error) => Log.Default.warn("failed to advertise server address", { error: String(error) }))

    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate(true)))
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    // Flush instead of closing: the host may kill the worker during the drain
    // below, so queued records must already be on disk. Closing here would
    // leave the rest of teardown without a file sink.
    await Log.flush()

    // Give in-flight background checkpoint writers a bounded chance to finish
    // before we tear down instances. A checkpoint writer can run for minutes on
    // a large session; when the host recycles the worker (e.g. right after a
    // user abort), a straight disposeAll() interrupts the writer mid-LLM-call,
    // leaving the on-disk checkpoint stale and the session's token count pinned
    // — the exact wedge that makes a large session unable to send. Draining
    // here mirrors cli/bootstrap.ts's headless-run teardown so both entry
    // points shut down gracefully. Writers that don't settle within the drain
    // budget are abandoned (disposeAll would kill them anyway).
    await AppRuntime.runPromise(SessionCheckpoint.Service.use((svc) => svc.drainWriters({ timeoutMs: 30_000 }))).catch(
      (error) => Log.Default.warn("checkpoint drain failed during shutdown", { error: String(error) }),
    )

    await Instance.disposeAll()
    if (server) {
      // Withdraw the advertisement before the socket goes away, so a reader sees
      // "nothing is serving" rather than a port that refuses connections. A crash skips
      // this, which is what the pid liveness check in `addresses` is for.
      await LLMServerTokens.unpublish(process.cwd()).catch(() => {})
      await server.stop(true)
      server = undefined
      serverPromise = undefined
      clearGeneratedServerPassword()
    }
    await Log.shutdown()
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.MIMOCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.MIMOCODE_SERVER_USERNAME ?? "mimocode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
