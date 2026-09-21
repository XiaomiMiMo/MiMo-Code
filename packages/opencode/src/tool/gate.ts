/**
 * FIFO admission gate for tool execution, keyed by Instance.directory.
 *
 * Concurrent tool-call executes can interleave badly (e.g. edit racing a
 * git commit in the same step). This gate restores a predictable admission
 * order:
 *
 * - read/grep/glob may run concurrently with each other
 * - edit/write may run concurrently when their realpath keys differ
 * - apply_patch, bash, task, MCP, and other tools are barrier-class
 * - actor/exec/workflow bypass the queue (they nest more tool calls)
 */

import { AppFileSystem } from "@mimo-ai/shared/filesystem"

export const PARALLEL_READONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob"])
export const PATH_WRITE_TOOLS: ReadonlySet<string> = new Set(["edit", "write"])

/**
 * Orchestrators that nest further tool execution (actor.run/wait, exec scripts,
 * workflow). Holding the gate across a nested wait deadlocks children that
 * share the same Instance.directory — these tools must not queue.
 */
export const GATE_BYPASS_TOOLS: ReadonlySet<string> = new Set(["actor", "exec", "workflow"])

export type GateRequest = {
  readonly id: string
  readonly tool: string
  readonly resource: string | undefined
}

export type EnterOptions = {
  readonly signal?: AbortSignal
  readonly resource?: string
}

type Waiter = {
  readonly request: GateRequest
  readonly resolve: () => void
}

/** realpath key for path-local writes; undefined when not applicable. */
export function toolResource(tool: string, args: { file_path?: unknown } | undefined): string | undefined {
  if (!PATH_WRITE_TOOLS.has(tool)) return undefined
  const filePath = args?.file_path
  if (typeof filePath !== "string" || filePath.length === 0) return undefined
  return AppFileSystem.resolve(filePath)
}

function compatible(a: GateRequest, b: GateRequest): boolean {
  const aRead = PARALLEL_READONLY_TOOLS.has(a.tool)
  const bRead = PARALLEL_READONLY_TOOLS.has(b.tool)
  if (aRead && bRead) return true
  const aWrite = PATH_WRITE_TOOLS.has(a.tool)
  const bWrite = PATH_WRITE_TOOLS.has(b.tool)
  if (aWrite && bWrite && a.resource !== undefined && b.resource !== undefined) {
    return a.resource !== b.resource
  }
  return false
}

class WorktreeGate {
  private readonly queue: Waiter[] = []
  private readonly running = new Map<string, GateRequest>()
  private seq = 0

  /**
   * Queue for admission. Resolves with a unique token (call ids may collide
   * or be absent). When `signal` aborts before admission the waiter is
   * dequeued and the promise rejects; abort after admission still releases
   * the running slot so the gate cannot wedge.
   */
  enter(tool: string, callID: string, options?: EnterOptions): Promise<string> {
    this.seq += 1
    const token = `${callID}#${this.seq}`
    if (GATE_BYPASS_TOOLS.has(tool)) return Promise.resolve(token)
    return new Promise<string>((resolve, reject) => {
      const signal = options?.signal
      let settled = false

      const onAbort = () => {
        if (settled) {
          this.leave(token)
          return
        }
        settled = true
        this.removeQueued(token)
        reject(new DOMException("Aborted", "AbortError"))
      }

      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"))
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      this.queue.push({
        request: { id: token, tool, resource: options?.resource },
        resolve: () => {
          if (settled) {
            // Abort raced admission: drop the slot tryAdmit just added.
            this.running.delete(token)
            this.tryAdmit()
            return
          }
          settled = true
          resolve(token)
        },
      })
      this.tryAdmit()
    })
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
    this.queue.splice(index, 1)
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
    if (directory === undefined) {
      gates.clear()
      return
    }
    gates.delete(directory)
  },
}

export type { WorktreeGate }
