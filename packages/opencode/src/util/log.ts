import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import z from "zod"

export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
export type Level = z.infer<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
// Cap a single log file so one long-running or runaway session can't write an
// unbounded file, and cap the total of archived logs so the directory can't
// fill the disk. The active file is excluded from the total and kept separate.
const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_TOTAL_SIZE = 200 * 1024 * 1024

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
  // Defaults to enabled. When false, the active log file grows in place and is
  // never archived to <name>.log.<stamp> on reaching MAX_FILE_SIZE.
  rotate?: boolean
}

let logpath = ""
export function file() {
  return logpath
}
let stream: ReturnType<typeof createWriteStream> | undefined
let written = 0
let rotation = true
let sequence = 0
let pending = Promise.resolve()
let printing = false

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "")
}

export async function init(options: Options) {
  await enqueue(async () => {
    await closeCurrent()
    if (options.level) level = options.level
    rotation = options.rotate ?? !Flag.MIMOCODE_DISABLE_LOG_ROTATION
    printing = options.print
    const role = (process.env.MIMOCODE_PROCESS_ROLE ?? "main").replace(/[^a-zA-Z0-9._-]/g, "-")
    await cleanup(Global.Path.log, { pid: process.pid, role })
    if (options.print) {
      logpath = ""
      return
    }
    logpath = path.join(
      Global.Path.log,
      `${options.dev ? "dev" : stamp()}-${role}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.active.log`,
    )
    await open(logpath)
    written = 0
    sequence = 0
  })
}

// Log failures are swallowed: a file failure happens while logging to a file,
// which is exactly when stderr belongs to the rendered TUI screen, and print
// mode can only fail on the very stderr a report would need. The listener stays
// because an unhandled stream "error" event would crash the process.
function swallow() {}

function write(msg: string) {
  void enqueue(() => append(msg))
}

function enqueue(operation: () => void | Promise<void>) {
  pending = pending.then(operation).catch(swallow)
  return pending
}

async function append(msg: string) {
  const size = Buffer.byteLength(msg)
  if (rotation && written > 0 && written + size > MAX_FILE_SIZE) await rotate()
  const target = stream
  if (!target) {
    // Only --print-logs may reach the terminal. Without a file sink (before
    // init, after shutdown, or when the sink failed) records are dropped: the
    // TUI shares stderr with the rendered screen, so leaking log lines there
    // corrupts the display.
    if (printing) process.stderr.write(msg)
    return
  }
  await new Promise<void>((resolve, reject) => {
    target.write(msg, (error) => (error ? reject(error) : resolve()))
  })
  written += size
}

async function rotate() {
  const previous = stream
  if (!previous) return
  await close(previous)
  stream = undefined
  const archived = logpath.replace(/\.active\.log$/, `.log.${stamp()}-${sequence++}`)
  if (!(await move(logpath, archived))) {
    written = 0
    return
  }
  await open(logpath)
  written = 0
  await cleanup(Global.Path.log)
}

async function open(targetPath: string) {
  const target = createWriteStream(targetPath, { flags: "a" })
  stream = target
  target.on("error", swallow)
  const opened = await new Promise<boolean>((resolve) => {
    target.once("open", () => resolve(true))
    target.once("error", () => resolve(false))
  })
  if (!opened && stream === target) stream = undefined
}

async function move(source: string, target: string) {
  const renamed = await fs.rename(source, target).then(
    () => true,
    () => false,
  )
  if (renamed) return true
  const copied = await fs.copyFile(source, target).then<"copied", "missing" | "failed">(
    () => "copied",
    (error) => (error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "failed"),
  )
  if (copied === "missing") return true
  if (copied === "failed") return false
  const removed = await fs.unlink(source).then(
    () => true,
    () => false,
  )
  if (removed) return true
  return fs.truncate(source, 0).then(
    () => true,
    () => false,
  )
}

function close(target: ReturnType<typeof createWriteStream>) {
  return new Promise<void>((resolve) => {
    if (target.closed) return resolve()
    target.once("close", resolve)
    target.end()
  })
}

export async function flush() {
  await pending
}

export async function shutdown() {
  await enqueue(closeCurrent)
}

async function closeCurrent() {
  const target = stream
  if (!target) return
  await close(target)
  stream = undefined
  written = 0
  const completed = logpath.replace(/\.active\.log$/, ".log")
  if (await move(logpath, completed)) logpath = completed
  await cleanup(Global.Path.log)
}

export async function exit(code?: number): Promise<never> {
  await shutdown()
  process.exit(code)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function cleanup(dir: string, takeover?: { pid: number; role: string }) {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const stats = await Promise.all(
    entries.map(async (name) => {
      if (!name.includes(".log")) return null
      if (name.endsWith(".active.log")) {
        const owner = name.match(/-(\d+)-[0-9a-f]{8}\.active\.log$/)?.[1]
        if (!owner) return null
        const pid = Number(owner)
        const sameContext = takeover && pid === takeover.pid && name.includes(`-${takeover.role}-${takeover.pid}-`)
        if (!sameContext && alive(pid)) return null
        const completed = name.replace(/\.active\.log$/, ".log")
        const renamed = await fs.rename(path.join(dir, name), path.join(dir, completed)).then(
          () => completed,
          () => null,
        )
        if (!renamed) return null
        name = renamed
      }
      const stat = await fs.stat(path.join(dir, name)).catch(() => null)
      return stat?.isFile() ? { name, size: stat.size, modified: stat.mtimeMs } : null
    }),
  )
  const files = stats
    .flatMap((item) => (item ? [item] : []))
    .sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name))

  let total = files.reduce((sum, f) => sum + f.size, 0)
  let remaining = files.length
  const doomed = files.filter((f) => {
    if (remaining <= keep && total <= MAX_TOTAL_SIZE) return false
    total -= f.size
    remaining -= 1
    return true
  })
  await Promise.all(doomed.map((f) => fs.unlink(path.join(dir, f.name)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
