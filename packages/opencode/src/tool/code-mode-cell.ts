import { randomUUID } from "node:crypto"
import type { SessionID } from "@/session/schema"
import type * as Tool from "./tool"

const DEFAULT_YIELD_TIME_MS = 10_000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const CELL_RETENTION_MS = 30 * 60 * 1000

export type CodeModeOutputBuffer = ReturnType<typeof createCodeModeOutputBuffer>

export function createCodeModeOutputBuffer() {
  let content = Buffer.alloc(0)
  let yieldVersion = 0
  const listeners = new Set<() => void>()
  return {
    append(value: string) {
      if (!value) return
      content = Buffer.concat([content, Buffer.from(value)])
    },
    slice(from: number) {
      return content.subarray(from).toString()
    },
    get byteLength() {
      return content.byteLength
    },
    get yieldVersion() {
      return yieldVersion
    },
    yield() {
      yieldVersion++
      listeners.forEach((listener) => listener())
      listeners.clear()
    },
    onYield(version: number, listener: () => void) {
      if (yieldVersion > version) {
        queueMicrotask(listener)
        return () => {}
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type Cell = {
  sessionID: SessionID
  promise: Promise<Tool.ExecuteResult>
  controller: AbortController
  cleanup: ReturnType<typeof setTimeout>
  output: CodeModeOutputBuffer
  deliveredOutputBytes: number
  yieldVersion: number
}

const cells = new Map<string, Cell>()

function scheduleCleanup(cellID: string, controller: AbortController) {
  const timer = setTimeout(() => {
    controller.abort()
    cells.delete(cellID)
  }, CELL_RETENTION_MS)
  timer.unref?.()
  return timer
}

function limited(output: string, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
  const maxChars = maxTokens * 4
  if (output.length <= maxChars) return output
  return `${output.slice(0, maxChars)}\n\n... output truncated to ${maxTokens} tokens ...`
}

function response(input: {
  status: "completed" | "failed" | "running" | "terminated"
  output: string
  startedAt: number
  maxTokens?: number
  result?: Tool.ExecuteResult
  cellID?: string
}): Tool.ExecuteResult {
  const label =
    input.status === "running"
      ? `Script running with cell ID ${input.cellID}`
      : input.status === "terminated"
        ? "Script terminated"
        : input.status === "completed"
          ? "Script completed"
          : "Script failed"
  return {
    title: label,
    metadata: {
      ...(input.result?.metadata ?? {}),
      status:
        input.status === "running" || input.status === "terminated"
          ? input.status
          : (input.result?.metadata.status ?? input.status),
    },
    output: `${label}\nWall time ${((Date.now() - input.startedAt) / 1000).toFixed(1)} seconds\nOutput:\n${limited(input.output, input.maxTokens)}`,
    attachments: input.result?.attachments,
  }
}

async function settled(
  promise: Promise<Tool.ExecuteResult>,
  yieldTimeMs: number,
  output?: CodeModeOutputBuffer,
  yieldVersion = 0,
) {
  let cancelYield = () => {}
  const yielded = new Promise<{ done: false }>((resolve) => {
    cancelYield = output?.onYield(yieldVersion, () => resolve({ done: false })) ?? (() => {})
  })
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ done: true as const, value }),
      (error) => ({ done: true as const, error: error instanceof Error ? error : new Error(String(error)) }),
    ),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), yieldTimeMs)),
    yielded,
  ])
  cancelYield()
  return outcome
}

function drain(output: CodeModeOutputBuffer, deliveredOutputBytes: number) {
  return {
    output: output.slice(deliveredOutputBytes),
    deliveredOutputBytes: output.byteLength,
  }
}

function completedOutput(live: string, result: Tool.ExecuteResult) {
  return [live, result.output].filter(Boolean).join("\n")
}

export async function startCell(input: {
  sessionID: SessionID
  promise: Promise<Tool.ExecuteResult>
  controller: AbortController
  output: CodeModeOutputBuffer
  yieldTimeMs?: number
  maxTokens?: number
}) {
  for (const value of [input.yieldTimeMs, input.maxTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("exec timing and token limits must be non-negative safe integers")
    }
  }
  const startedAt = Date.now()
  const outcome = await settled(input.promise, input.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS, input.output)
  const current = drain(input.output, 0)
  if (outcome.done && "value" in outcome) {
    return response({
      status: outcome.value.metadata.status === "completed" ? "completed" : "failed",
      output: completedOutput(current.output, outcome.value),
      startedAt,
      maxTokens: input.maxTokens,
      result: outcome.value,
    })
  }
  if (outcome.done) {
    return response({
      status: "failed",
      output: [current.output, `Script error:\n${outcome.error.message}`].filter(Boolean).join("\n"),
      startedAt,
      maxTokens: input.maxTokens,
    })
  }

  const cellID = randomUUID()
  cells.set(cellID, {
    sessionID: input.sessionID,
    promise: input.promise,
    controller: input.controller,
    cleanup: scheduleCleanup(cellID, input.controller),
    output: input.output,
    deliveredOutputBytes: current.deliveredOutputBytes,
    yieldVersion: input.output.yieldVersion,
  })
  return response({
    status: "running",
    output: current.output,
    startedAt,
    maxTokens: input.maxTokens,
    cellID,
  })
}

export async function waitCell(input: {
  sessionID: SessionID
  cellID: string
  yieldTimeMs?: number
  maxTokens?: number
  terminate?: boolean
}) {
  for (const value of [input.yieldTimeMs, input.maxTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("wait timing and token limits must be non-negative safe integers")
    }
  }
  const startedAt = Date.now()
  const cell = cells.get(input.cellID)
  if (!cell || cell.sessionID !== input.sessionID) throw new Error(`unknown exec cell: ${input.cellID}`)
  if (input.terminate) cell.controller.abort()
  const outcome = await settled(
    cell.promise,
    input.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS,
    cell.output,
    cell.yieldVersion,
  )
  const current = drain(cell.output, cell.deliveredOutputBytes)
  cell.deliveredOutputBytes = current.deliveredOutputBytes
  cell.yieldVersion = cell.output.yieldVersion
  if (input.terminate) {
    clearTimeout(cell.cleanup)
    cells.delete(input.cellID)
    return response({
      status: "terminated",
      output: current.output,
      startedAt,
      maxTokens: input.maxTokens,
      result: outcome.done && "value" in outcome ? outcome.value : undefined,
    })
  }
  if (!outcome.done) {
    clearTimeout(cell.cleanup)
    cell.cleanup = scheduleCleanup(input.cellID, cell.controller)
    return response({
      status: "running",
      output: current.output,
      startedAt,
      maxTokens: input.maxTokens,
      cellID: input.cellID,
    })
  }

  clearTimeout(cell.cleanup)
  cells.delete(input.cellID)
  if ("value" in outcome) {
    return response({
      status: outcome.value.metadata.status === "completed" ? "completed" : "failed",
      output: completedOutput(current.output, outcome.value),
      startedAt,
      maxTokens: input.maxTokens,
      result: outcome.value,
    })
  }
  return response({
    status: "failed",
    output: [current.output, `Script error:\n${outcome.error.message}`].filter(Boolean).join("\n"),
    startedAt,
    maxTokens: input.maxTokens,
  })
}
