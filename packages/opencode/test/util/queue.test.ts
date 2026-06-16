import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "../../src/util/queue"

describe("util.AsyncQueue", () => {
  test("delivers items in FIFO order when buffered", async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.push(3)
    expect(await q.next()).toBe(1)
    expect(await q.next()).toBe(2)
    expect(await q.next()).toBe(3)
  })

  test("resolves a pending waiter as soon as an item is pushed", async () => {
    const q = new AsyncQueue<string>()
    const pending = q.next()
    q.push("hello")
    expect(await pending).toBe("hello")
  })

  test("unbounded by default: buffers without dropping", () => {
    const q = new AsyncQueue<number>()
    for (let i = 0; i < 10_000; i++) q.push(i)
    expect(q.size).toBe(10_000)
  })

  test("bounded queue caps buffered size by dropping oldest items", () => {
    const q = new AsyncQueue<number>({ capacity: 3 })
    q.push(1)
    q.push(2)
    q.push(3)
    q.push(4) // drops 1
    q.push(5) // drops 2
    expect(q.size).toBe(3)
  })

  test("bounded queue keeps the newest items after dropping", async () => {
    const q = new AsyncQueue<number>({ capacity: 2 })
    for (let i = 1; i <= 100; i++) q.push(i)
    expect(q.size).toBe(2)
    expect(await q.next()).toBe(99)
    expect(await q.next()).toBe(100)
  })

  test("bounded queue reports how many items were dropped", () => {
    const q = new AsyncQueue<number>({ capacity: 2 })
    expect(q.dropped).toBe(0)
    q.push(1)
    q.push(2)
    q.push(3)
    q.push(4)
    expect(q.dropped).toBe(2)
  })

  test("pushing to a waiter does not count as buffered or dropped", async () => {
    const q = new AsyncQueue<number>({ capacity: 1 })
    const pending = q.next()
    q.push(42)
    expect(await pending).toBe(42)
    expect(q.size).toBe(0)
    expect(q.dropped).toBe(0)
  })
})
