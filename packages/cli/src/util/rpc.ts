type Definition = {
  [method: string]: (input: any) => any
}

// Wire protocol between the TUI thread and its worker:
//   worker → thread: rpc.ready, rpc.result, rpc.event
//   thread → worker: rpc.request
// The worker announces rpc.ready once its listener is installed, and the client sends
// nothing before that. Runtimes disagree on what happens to a message that reaches a
// worker before it assigns `onmessage`: Bun 1.3 queues it, Bun 1.4 drops it when the
// listener comes after a top-level await. The handshake makes delivery independent of
// that. Messages in the other direction are always safe because the client assigns
// `target.onmessage` synchronously, in the same tick the Worker is constructed.

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type !== "rpc.request") return
    const method = rpc[parsed.method]
    if (typeof method !== "function") {
      postMessage(JSON.stringify({ type: "rpc.result", id: parsed.id, error: `unknown rpc method: ${parsed.method}` }))
      return
    }
    try {
      const result = await method(parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    } catch (error) {
      postMessage(JSON.stringify({ type: "rpc.result", id: parsed.id, error: describe(error) }))
    }
  }
  postMessage(JSON.stringify({ type: "rpc.ready" }))
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  addEventListener?: (type: "close", listener: () => void) => void
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  const queue: string[] = []
  let ready = false
  let stopped: Error | undefined
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.ready") {
      if (ready) return
      ready = true
      for (const message of queue.splice(0)) target.postMessage(message)
      return
    }
    if (parsed.type === "rpc.result") {
      const call = pending.get(parsed.id)
      if (call) {
        pending.delete(parsed.id)
        if (typeof parsed.error === "string") call.reject(new Error(parsed.error))
        else call.resolve(parsed.result)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  // Bun fires `close` when a worker exits for any reason, including an uncaught error
  // (which fires `error` first). Without this, every in-flight call would wait forever.
  target.addEventListener?.("close", () => {
    stopped = new Error("rpc worker stopped")
    queue.length = 0
    for (const call of pending.values()) call.reject(stopped)
    pending.clear()
  })
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      if (stopped) return Promise.reject(stopped)
      const requestId = id++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        const message = JSON.stringify({ type: "rpc.request", method, input, id: requestId })
        if (ready) target.postMessage(message)
        else queue.push(message)
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}
