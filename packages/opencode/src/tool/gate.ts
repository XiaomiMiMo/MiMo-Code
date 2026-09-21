/**
 * FIFO admission gate for tool execution, keyed by Instance.directory.
 *
 * Concurrent tool-call executes can interleave badly (e.g. edit racing a
 * git commit in the same step). This gate restores a predictable admission
 * order:
 *
 * - read/grep/glob may run concurrently with each other
 * - every other ordinary tool is barrier-class, including edit/write
 * - actor/exec/workflow/session bypass the queue (they nest or control other calls)
 */

import { Effect } from "effect"

export const PARALLEL_READONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"])

/**
 * Top-level model tool-calls for these tools must not queue: they nest more
 * tool execution (actor.run/wait, exec scripts, workflow, session ask/join).
 * Session approval/cancellation must also remain available while a child runs.
 * Holding the gate across that wait deadlocks children that share the directory.
 * Nested model-facing leaf tools enter the gate; exec guest calls remain ungated.
 */
export const GATE_BYPASS_TOOLS: ReadonlySet<string> = new Set(["actor", "exec", "workflow", "session"])

export type GateRequest = {
  readonly id: string
  readonly tool: string
}

export type EnterOptions = {
  readonly signal?: AbortSignal
}

type Waiter = {
  readonly request: GateRequest
  readonly resolve: () => void
  readonly cancel: () => void
}

function compatible(a: GateRequest, b: GateRequest): boolean {
  return PARALLEL_READONLY_TOOLS.has(a.tool) && PARALLEL_READONLY_TOOLS.has(b.tool)
}

class WorktreeGate {
  private readonly queue: Waiter[] = []
  private readonly running = new Map<string, GateRequest>()
  private seq = 0

  /**
   * Queue for admission. Resolves with a unique token (call ids may collide
   * or be absent). When `signal` aborts before admission the waiter is
   * dequeued and the promise rejects. Once admitted, only leave releases the
   * slot, after tool execution and its cleanup have finished.
   */
  enter(tool: string, callID: string, options?: EnterOptions): Promise<string> {
    return this.enqueue(tool, callID, options).ready
  }

  run<A, E, R>(tool: string, callID: string, body: Effect.Effect<A, E, R>, options?: EnterOptions) {
    if (GATE_BYPASS_TOOLS.has(tool)) return body
    return Effect.acquireUseRelease(
      // Acquire the token synchronously, so release is installed BEFORE the
      // interruptible wait. Interrupting immediately after admission cannot
      // strand a running slot between resolving the promise and using it.
      Effect.sync(() => this.enqueue(tool, callID, options)),
      (request) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => request.ready,
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })
          // Abort can race the promise continuation after admission.
          if (options?.signal?.aborted) return yield* Effect.fail(new DOMException("Aborted", "AbortError"))
          return yield* body
        }),
      (request) => Effect.sync(() => this.leave(request.token)),
    )
  }

  private enqueue(tool: string, callID: string, options?: EnterOptions) {
    this.seq += 1
    const token = `${callID}#${this.seq}`
    if (GATE_BYPASS_TOOLS.has(tool)) return { token, ready: Promise.resolve(token) }
    const ready = new Promise<string>((resolve, reject) => {
      const signal = options?.signal
      const onAbort = () => this.leave(token)

      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"))
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      this.queue.push({
        request: { id: token, tool },
        resolve: () => {
          signal?.removeEventListener("abort", onAbort)
          resolve(token)
        },
        cancel: () => {
          signal?.removeEventListener("abort", onAbort)
          reject(new DOMException("Aborted", "AbortError"))
        },
      })
      this.tryAdmit()
    })
    // A fiber may be interrupted after registration but before it awaits ready.
    // The finalizer still cancels that waiter; keep its rejection observed.
    void ready.catch(() => {})
    return { token, ready }
  }

  leave(token: string): void {
    if (this.removeQueued(token)) {
      this.tryAdmit()
      return
    }
    this.running.delete(token)
    this.tryAdmit()
  }

  get runningCount(): number {
    return this.running.size
  }

  get queuedCount(): number {
    return this.queue.length
  }

  private removeQueued(token: string): boolean {
    const index = this.queue.findIndex((waiter) => waiter.request.id === token)
    if (index < 0) return false
    this.queue.splice(index, 1)[0].cancel()
    return true
  }

  private tryAdmit(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]
      if (!head) return
      const blocked = [...this.running.values()].some((active) => !compatible(head.request, active))
      if (blocked) return
      this.queue.shift()
      // Bookkeeping before resolve so a sibling enter cannot double-admit.
      this.running.set(head.request.id, head.request)
      head.resolve()
    }
  }
}

const gates = new Map<string, WorktreeGate>()

export const ToolGate = {
  for(directory: string): WorktreeGate {
    const hit = gates.get(directory)
    if (hit) return hit
    const next = new WorktreeGate()
    gates.set(directory, next)
    return next
  },
  reset(directory?: string): void {
    if (directory == null) {
      gates.clear()
      return
    }
    gates.delete(directory)
  },
}

export type { WorktreeGate }
