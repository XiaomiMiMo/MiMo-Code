import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Rpc } from "../../src/util"
import type { rpc } from "../fixture/rpc-worker"

const fixture = path.join(import.meta.dir, "../fixture/rpc-worker.ts")
const workers: Worker[] = []

function spawn() {
  const worker = new Worker(fixture)
  workers.push(worker)
  return worker
}

afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate()
})

describe("util.rpc", () => {
  test("a call made right after spawning reaches a worker that awaits before listening", async () => {
    const client = Rpc.client<typeof rpc>(spawn())
    expect(await client.call("echo", "hello")).toBe("hello")
    expect(await client.call("echo", "again")).toBe("again")
  })

  test("events emitted before the worker is ready are delivered", async () => {
    const client = Rpc.client<typeof rpc>(spawn())
    const booted = new Promise((resolve) => client.on("booted", resolve))
    expect(await booted).toBe("early")
  })

  // A plain port rather than a Worker: on Bun 1.3 an early message is queued, so only
  // the posted messages themselves show whether the client waited for rpc.ready.
  test("requests are held until the worker announces it is ready", () => {
    const posted: string[] = []
    const port: Parameters<typeof Rpc.client>[0] = {
      postMessage: (data: string) => void posted.push(data),
      onmessage: null,
    }
    const client = Rpc.client<typeof rpc>(port)
    void client.call("echo", "first")
    void client.call("echo", "second")
    expect(posted).toEqual([])

    port.onmessage?.call(port as never, new MessageEvent("message", { data: JSON.stringify({ type: "rpc.ready" }) }))
    expect(posted.map((data) => JSON.parse(data).input)).toEqual(["first", "second"])

    void client.call("echo", "third")
    expect(posted.map((data) => JSON.parse(data).input)).toEqual(["first", "second", "third"])
  })

  test("a method that throws rejects the call with its message", async () => {
    const client = Rpc.client<typeof rpc>(spawn())
    await expect(client.call("fail", "boom")).rejects.toThrow("boom")
    expect(await client.call("echo", "still alive")).toBe("still alive")
  })

  test("an unknown method rejects the call", async () => {
    const client = Rpc.client<Record<string, (input: unknown) => unknown>>(spawn())
    await expect(client.call("missing", undefined)).rejects.toThrow("missing")
  })

  test("a worker that exits rejects pending and later calls", async () => {
    const client = Rpc.client<typeof rpc>(spawn())
    expect(await client.call("echo", "ready")).toBe("ready")
    const pending = client.call("hang", undefined)
    void client.call("exit", undefined).catch(() => {})
    await expect(pending).rejects.toThrow("worker stopped")
    await expect(client.call("echo", "late")).rejects.toThrow("worker stopped")
  })

  test("a worker that dies from an uncaught error rejects pending calls", async () => {
    const client = Rpc.client<typeof rpc>(spawn())
    await expect(client.call("crash", "uncaught")).rejects.toThrow("worker stopped")
    await expect(client.call("echo", "late")).rejects.toThrow("worker stopped")
  })

  test("dispose drops in-flight calls without rejecting them and refuses new ones", async () => {
    const worker = spawn()
    const client = Rpc.client<typeof rpc>(worker)
    expect(await client.call("echo", "ready")).toBe("ready")
    let settled = false
    void client.call("hang", undefined).finally(() => (settled = true))
    client.dispose()
    const closed = new Promise((resolve) => worker.addEventListener("close", resolve))
    worker.terminate()
    await closed
    await Bun.sleep(10)
    expect(settled).toBe(false)
    await expect(client.call("echo", "late")).rejects.toThrow("disposed")
  })
})
