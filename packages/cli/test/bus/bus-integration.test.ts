import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { EventRoutes } from "../../src/server/routes/instance/event"

const TestEvent = BusEvent.define("test.integration", z.object({ value: z.number() }))

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

describe("Bus integration: acquireRelease subscriber pattern", () => {
  afterEach(() => Instance.disposeAll())

  test("subscriber via callback facade receives events and cleans up on unsub", async () => {
    await using tmp = await tmpdir()
    const received: number[] = []

    await withInstance(tmp.path, async () => {
      const unsub = Bus.subscribe(TestEvent, (evt) => {
        received.push(evt.properties.value)
      })
      await Bun.sleep(10)
      await Bus.publish(TestEvent, { value: 1 })
      await Bus.publish(TestEvent, { value: 2 })
      await Bun.sleep(10)

      expect(received).toEqual([1, 2])

      unsub()
      await Bun.sleep(10)
      await Bus.publish(TestEvent, { value: 3 })
      await Bun.sleep(10)

      expect(received).toEqual([1, 2])
    })
  })

  test("subscribeAll receives events from multiple types", async () => {
    await using tmp = await tmpdir()
    const received: Array<{ type: string; value?: number }> = []

    const OtherEvent = BusEvent.define("test.other", z.object({ value: z.number() }))

    await withInstance(tmp.path, async () => {
      Bus.subscribeAll((evt) => {
        received.push({ type: evt.type, value: evt.properties.value })
      })
      await Bun.sleep(10)
      await Bus.publish(TestEvent, { value: 10 })
      await Bus.publish(OtherEvent, { value: 20 })
      await Bun.sleep(10)
    })

    expect(received).toEqual([
      { type: "test.integration", value: 10 },
      { type: "test.other", value: 20 },
    ])
  })

  test("subscriber cleanup on instance disposal interrupts the stream", async () => {
    await using tmp = await tmpdir()
    const received: number[] = []
    let disposed = false

    await withInstance(tmp.path, async () => {
      Bus.subscribeAll((evt) => {
        if (evt.type === Bus.InstanceDisposed.type) {
          disposed = true
          return
        }
        received.push(evt.properties.value)
      })
      await Bun.sleep(10)
      await Bus.publish(TestEvent, { value: 1 })
      await Bun.sleep(10)
    })

    await Instance.disposeAll()
    await Bun.sleep(50)

    expect(received).toEqual([1])
    expect(disposed).toBe(true)
  })

  // A paused reader must not have to drain its queued events before disposal ends the stream.
  test("disposal interrupts an SSE whose client stopped reading", async () => {
    await using tmp = await tmpdir()
    const route = EventRoutes()
    const response = await Instance.provide({ directory: tmp.path, fn: () => route.request("/event") })
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("server.connected")
      await Instance.provide({ directory: tmp.path, fn: () => Promise.all(Array.from({ length: 1000 }, (_, value) => Bus.publish(TestEvent, { value }))) })
      await Instance.disposeDirectory(tmp.path)
      let ended = false
      for (let i = 0; i < 10; i++) {
        const next = await Promise.race([reader.read(), Bun.sleep(1000).then(() => null)])
        expect(next).not.toBeNull()
        if (next!.done) { ended = true; break }
      }
      expect(ended).toBe(true)
    } finally {
      await reader.cancel()
    }
  })

  // Instance disposal must close the old HTTP stream even when its Bus notice is lost.
  test("disposed directory closes a busy SSE while new and unrelated subscriptions remain live", async () => {
    await using first = await tmpdir()
    await using unrelated = await tmpdir()
    const route = EventRoutes()
    const firstResponse = await Instance.provide({ directory: first.path, fn: () => route.request("/event") })
    const firstReader = firstResponse.body!.getReader()
    const otherResponse = await Instance.provide({ directory: unrelated.path, fn: () => route.request("/event") })
    const otherReader = otherResponse.body!.getReader()
    const decode = new TextDecoder()
    try {
      expect(decode.decode((await firstReader.read()).value)).toContain("server.connected")
      expect(decode.decode((await otherReader.read()).value)).toContain("server.connected")
      await Instance.provide({ directory: first.path, fn: () => Promise.all(Array.from({ length: 100 }, (_, value) => Bus.publish(TestEvent, { value }))) })
      await Instance.disposeDirectory(first.path)

      let closed = false
      for (let i = 0; i <= 101; i++) {
        const chunk = await Promise.race([firstReader.read(), Bun.sleep(1000).then(() => null)])
        expect(chunk).not.toBeNull()
        if (chunk!.done) { closed = true; break }
      }
      expect(closed).toBe(true)

      const replacement = await Instance.provide({ directory: first.path, fn: () => route.request("/event") })
      const newReader = replacement.body!.getReader()
      try {
        expect(decode.decode((await newReader.read()).value)).toContain("server.connected")
        await Instance.provide({ directory: first.path, fn: () => Bus.publish(TestEvent, { value: 999 }) })
        const next = await Promise.race([newReader.read(), Bun.sleep(2000).then(() => null)])
        expect(next).not.toBeNull()
        expect(decode.decode(next!.value)).toContain('"value":999')
      } finally {
        await newReader.cancel()
      }
      await Instance.provide({ directory: unrelated.path, fn: () => Bus.publish(TestEvent, { value: 777 }) })
      const other = await Promise.race([otherReader.read(), Bun.sleep(2000).then(() => null)])
      expect(other).not.toBeNull()
      expect(decode.decode(other!.value)).toContain('"value":777')
    } finally {
      await firstReader.cancel()
      await otherReader.cancel()
    }
  })
})
