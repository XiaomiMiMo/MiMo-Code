export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private readonly capacity: number
  /** Count of items dropped because the buffer was full (drop-oldest). */
  dropped = 0

  /**
   * @param options.capacity Max buffered items when nobody is awaiting. When
   * the buffer is full, the OLDEST item is dropped to make room for the new
   * one (`dropped` is incremented). Defaults to Infinity (unbounded).
   *
   * Bounding matters for fan-out streams (e.g. SSE event endpoints) where a
   * slow/stalled consumer would otherwise let the buffer grow without limit
   * and exhaust process memory, since `push` never blocks the producer.
   */
  constructor(options?: { capacity?: number }) {
    this.capacity = options?.capacity ?? Infinity
  }

  push(item: T) {
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
      return
    }
    if (this.queue.length >= this.capacity) {
      this.queue.shift()
      this.dropped++
    }
    this.queue.push(item)
  }

  /** Number of items currently buffered (not yet consumed). */
  get size() {
    return this.queue.length
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
