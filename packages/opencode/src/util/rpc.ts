type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      const result = await rpc[parsed.method](parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  let closed = false

  const rejectAll = (reason: string) => {
    closed = true
    for (const [requestId, { reject }] of pending) {
      reject(new Error(reason))
      pending.delete(requestId)
    }
  }

  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const entry = pending.get(parsed.id)
      if (entry) {
        entry.resolve(parsed.result)
        pending.delete(parsed.id)
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

  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0], timeoutMs = 300_000): Promise<ReturnType<T[Method]>> {
      if (closed) return Promise.reject(new Error("RPC client closed"))
      const requestId = id++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`RPC call "${String(method)}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(requestId, {
          resolve: (result: any) => {
            clearTimeout(timer)
            resolve(result)
          },
          reject: (err: Error) => {
            clearTimeout(timer)
            reject(err)
          },
        })
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
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
    close() {
      rejectAll("RPC client closed")
    },
  }
}
