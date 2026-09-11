import { spawn, type ChildProcess } from "node:child_process"
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js"
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { childProcessEnv } from "@/util/child-process-env"

/** Last known child-process identity for a local MCP stdio transport. */
export interface StdioExitSnapshot {
  pid: number | null
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  /** True when the exit was caused by host-initiated close(), not the child's own death. */
  hostShutdown: boolean
}

export interface ObservingStdioTransportParams {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

const STDERR_TAIL_LIMIT = 4096

/**
 * Local stdio transport that owns the child process through the public
 * `child_process` API.
 *
 * SDK `StdioClientTransport` clears its private `_process` in `close()` before
 * callers can read exitCode, and `onclose` does not receive the exit code.
 * Owning spawn/exit directly keeps the failure snapshot stable without reaching
 * into SDK private fields.
 */
export class ObservingStdioTransport implements Transport {
  private child?: ChildProcess
  private readBuffer = new ReadBuffer()
  private stderrTail = ""
  private lastExit?: StdioExitSnapshot
  private observingNaturalExit = true
  private started = false
  private closed = false
  private oncloseFired = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport["onmessage"]
  /** Live stderr lines (same bounded tail used for the failure snapshot). */
  onStderr?: (text: string) => void

  constructor(private readonly params: ObservingStdioTransportParams) {}

  private notifyClosed(): void {
    if (this.oncloseFired) return
    this.oncloseFired = true
    this.onclose?.()
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** Child exit observed so far; host-initiated teardown is flagged, not hidden. */
  exitSnapshot(): StdioExitSnapshot | undefined {
    return this.lastExit
  }

  stderrSnapshot(): string {
    return this.stderrTail
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("ObservingStdioTransport already started")
    }
    this.started = true
    const child = spawn(this.params.command, this.params.args ?? [], {
      // childProcessEnv() is required at every native spawn site (see
      // test/util/child-process-env.test.ts). params.env may already include it;
      // repeating the merge is intentional so the AST contract stays true here.
      env: {
        ...getDefaultEnvironment(),
        ...childProcessEnv(),
        ...this.params.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
      cwd: this.params.cwd,
    })
    this.child = child
    this.lastExit = {
      pid: child.pid ?? null,
      exitCode: null,
      signalCode: null,
      hostShutdown: false,
    }

    child.on("error", (error) => {
      this.onerror?.(error)
    })
    child.once("exit", (code, signal) => {
      this.lastExit = {
        pid: child.pid ?? null,
        exitCode: code,
        signalCode: signal,
        hostShutdown: !this.observingNaturalExit,
      }
    })
    // Match SDK StdioClientTransport: onclose fires on stdio 'close', not 'exit'.
    // Firing on 'exit' (process death, stdio still draining) tears the Client down
    // earlier than the SDK does and races unrelated instance cleanup under load.
    child.once("close", () => {
      if (this.observingNaturalExit) this.notifyClosed()
    })
    child.stdout?.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk)
      this.processReadBuffer()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT)
      this.onStderr?.(text)
    })

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const child = this.child
    if (!child?.stdin) throw new Error("Not connected")
    const json = serializeMessage(message)
    await new Promise<void>((resolve, reject) => {
      child.stdin!.write(json, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.observingNaturalExit = false
    // Mark host shutdown synchronously: after SIGKILL the exit event may land
    // only on a later macrotask, and callers can observe the snapshot before then.
    if (this.lastExit && this.lastExit.exitCode == null && this.lastExit.signalCode == null) {
      this.lastExit = { ...this.lastExit, hostShutdown: true }
    }
    const child = this.child
    this.child = undefined
    if (!child) {
      this.notifyClosed()
      return
    }
    const waitExit = new Promise<void>((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve()
        return
      }
      child.once("exit", () => resolve())
    })
    child.stdin?.end()
    await Promise.race([waitExit, delay(2000)])
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM")
      await Promise.race([waitExit, delay(2000)])
    }
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL")
      // SIGKILL is async at the kernel boundary; wait so exitSnapshot() is not
      // observed as an empty natural exit on the next microtask.
      await Promise.race([waitExit, delay(2000)])
    }
    this.readBuffer.clear()
    this.notifyClosed()
  }

  private processReadBuffer(): void {
    while (true) {
      let message: JSONRPCMessage
      try {
        const next = this.readBuffer.readMessage()
        if (next === null) break
        message = next
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        continue
      }
      this.onmessage?.(message)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
