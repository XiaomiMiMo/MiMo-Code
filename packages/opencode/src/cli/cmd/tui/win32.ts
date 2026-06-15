import { dlopen, ptr } from "bun:ffi"
import type { ReadStream } from "node:tty"

const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const ENABLE_PROCESSED_INPUT = 0x0001
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200

const kernel = () =>
  dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
    FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
  })

let k32: ReturnType<typeof kernel> | undefined

function load() {
  if (process.platform !== "win32") return false
  try {
    k32 ??= kernel()
    return true
  } catch {
    return false
  }
}

/**
 * Enable VT (Virtual Terminal) processing on both stdin and stdout.
 *
 * Without ENABLE_VIRTUAL_TERMINAL_INPUT on stdin, the terminal echoes mouse
 * tracking reports as raw text (e.g. "[55;65;1M") instead of delivering them
 * as input events. Without ENABLE_VIRTUAL_TERMINAL_PROCESSING on stdout,
 * ANSI escape sequences may not be processed correctly.
 */
export function win32EnableVTProcessing() {
  if (process.platform !== "win32") return
  if (!load()) return

  // Enable VT input on stdin so mouse/key events arrive as VT sequences
  if (process.stdin.isTTY) {
    const stdinHandle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
    const buf = new Uint32Array(1)
    if (k32!.symbols.GetConsoleMode(stdinHandle, ptr(buf)) !== 0) {
      k32!.symbols.SetConsoleMode(stdinHandle, buf[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT)
    }
  }

  // Enable VT output on stdout so ANSI escape sequences render correctly
  if (process.stdout.isTTY) {
    const stdoutHandle = k32!.symbols.GetStdHandle(STD_OUTPUT_HANDLE)
    const buf = new Uint32Array(1)
    if (k32!.symbols.GetConsoleMode(stdoutHandle, ptr(buf)) !== 0) {
      k32!.symbols.SetConsoleMode(stdoutHandle, buf[0]! | ENABLE_VIRTUAL_TERMINAL_PROCESSING)
    }
  }
}

/**
 * Clear ENABLE_PROCESSED_INPUT on the console stdin handle.
 */
export function win32DisableProcessedInput() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)
  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return

  const mode = buf[0]!
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
  k32!.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)
}

/**
 * Discard any queued console input (mouse events, key presses, etc.).
 */
export function win32FlushInputBuffer() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  k32!.symbols.FlushConsoleInputBuffer(handle)
}

let unhook: (() => void) | undefined

/**
 * Keep ENABLE_PROCESSED_INPUT disabled.
 *
 * On Windows, Ctrl+C becomes a CTRL_C_EVENT (instead of stdin input) when
 * ENABLE_PROCESSED_INPUT is set. Various runtimes can re-apply console modes
 * (sometimes on a later tick), and the flag is console-global, not per-process.
 *
 * We combine:
 * - A `setRawMode(...)` hook to re-clear after known raw-mode toggles.
 * - A low-frequency poll as a backstop for native/external mode changes.
 */
export function win32InstallCtrlCGuard() {
  if (process.platform !== "win32") return
  if (!process.stdin.isTTY) return
  if (!load()) return
  if (unhook) return unhook

  const stdin = process.stdin as ReadStream
  const original = stdin.setRawMode

  const handle = k32!.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
  const initial = buf[0]!

  const enforce = () => {
    if (k32!.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
    const mode = buf[0]!
    const desired = (mode & ~ENABLE_PROCESSED_INPUT) | ENABLE_VIRTUAL_TERMINAL_INPUT
    if (desired !== mode) k32!.symbols.SetConsoleMode(handle, desired)
  }

  // Some runtimes can re-apply console modes on the next tick; enforce twice.
  const later = () => {
    enforce()
    setImmediate(enforce)
  }

  let wrapped: ReadStream["setRawMode"] | undefined

  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode)
      later()
      return result
    }

    stdin.setRawMode = wrapped
  }

  // Ensure it's cleared immediately too (covers any earlier mode changes).
  later()

  const interval = setInterval(enforce, 100)
  interval.unref()

  let done = false
  unhook = () => {
    if (done) return
    done = true

    clearInterval(interval)
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original
    }

    k32!.symbols.SetConsoleMode(handle, initial)
    unhook = undefined
  }

  return unhook
}
