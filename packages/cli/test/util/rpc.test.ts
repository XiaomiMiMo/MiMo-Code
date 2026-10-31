import { describe, expect, test } from "bun:test"
import path from "path"
import * as Rpc from "../../src/util/rpc"

describe("util.rpc", () => {
  test("a call made before the worker listens is answered", async () => {
    const worker = new Worker(path.join(import.meta.dir, "../fixture/rpc-worker.ts"))
    try {
      const client = Rpc.client<{ echo: (input: string) => string }>(worker)
      const result = await Promise.race([
        client.call("echo", "hello"),
        new Promise((resolve) => setTimeout(() => resolve("no answer in 5 s"), 5_000)),
      ])
      expect(result).toBe("hello")
    } finally {
      worker.terminate()
    }
  })
})
