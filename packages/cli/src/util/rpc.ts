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
  // Tell the client the handler is installed. A request posted before this point can be
  // dropped by the runtime (observed on Bun 1.4.x: the worker boots ~300ms after
  // `new Worker`, and an early "server" request never arrived), so the client holds
  // requests until it sees this.
  postMessage(JSON.stringify({ type: "rpc.ready" }))
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.ready") markReady()
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve(parsed.result)
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
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        void ready.then(() => target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId })))
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
