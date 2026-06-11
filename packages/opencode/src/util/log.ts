import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { Global } from "../global"
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
const defaultMaxSize = 10 * 1024 * 1024
const maxEntrySize = 256 * 1024
const minMaxSize = 1024
const managedLogName = /^(\d{4}-\d{2}-\d{2}T\d{6}\.log|dev\.log\.\d{4}-\d{2}-\d{2}T\d{6})$/

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
}

let logpath = ""
export function file() {
  return logpath
}
let close = async () => {}
let queue = Promise.resolve()
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

export async function init(options: Options) {
  if (options.level) level = options.level
  await queue
  await close()
  close = async () => {}
  queue = Promise.resolve()
  write = (msg: any) => {
    process.stderr.write(msg)
    return msg.length
  }
  await cleanup(Global.Path.log)
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  if (options.dev) {
    // Preserve previous dev.log as dev.log.<timestamp> for hang/incident
    // forensics. cleanup() below prunes old managed logs.
    const stat = await fs.stat(logpath).catch(() => null)
    if (stat && stat.size > 0) {
      const stamp = new Date().toISOString().split(".")[0].replace(/:/g, "")
      await fs.rename(logpath, `${logpath}.${stamp}`).catch(() => {})
    }
  } else {
    await fs.truncate(logpath).catch(() => {})
  }
  await cleanup(Global.Path.log)
  let size = (await fs.stat(logpath).catch(() => ({ size: 0 }))).size
  let stream = createWriteStream(logpath, { flags: "a" })
  const closeStream = () =>
    new Promise<void>((resolve) => {
      stream.end(resolve)
    })
  const resetStream = async () => {
    await closeStream()
    const truncated = await fs.truncate(logpath, 0).then(
      () => true,
      () => false,
    )
    stream = createWriteStream(logpath, { flags: "a" })
    close = closeStream
    size = truncated ? 0 : (await fs.stat(logpath).catch(() => ({ size: 0 }))).size
    return truncated
  }
  const append = (output: string) =>
    new Promise<number>((resolve, reject) => {
      stream.write(output, (err) => {
        if (err) reject(err)
        else resolve(Buffer.byteLength(output))
      })
    })
  close = closeStream
  write = (input: any) => {
    const next = queue.then(async () => {
      const limit = maxLogSize()
      const msg = truncateEntry(String(input), Math.min(limit, maxEntrySize))
      const bytes = Buffer.byteLength(msg)
      size = (await fs.stat(logpath).catch(() => ({ size }))).size
      const reset = size + bytes > limit
      if (reset && !(await resetStream())) return 0
      const output = truncateEntry((reset ? "[log truncated]\n" : "") + msg, limit - size)
      if (!output) return 0
      size += await append(output)
      size = (await fs.stat(logpath).catch(() => ({ size }))).size
      if (size > limit) {
        if (await resetStream()) size += await append(truncateEntry("[log truncated]\n", limit))
      }
      return Buffer.byteLength(output)
    })
    queue = next.then(
      () => {},
      () => {},
    )
    return next
  }
}

function maxLogSize() {
  const value = Number(process.env.MIMOCODE_LOG_MAX_BYTES)
  if (Number.isFinite(value) && value >= minMaxSize) return value
  return defaultMaxSize
}

function truncateEntry(input: string, limit: number) {
  if (Buffer.byteLength(input) <= limit) return input
  const suffix = "\n[truncated]\n"
  if (limit <= Buffer.byteLength(suffix)) return suffix.slice(0, limit)
  let prefix = Buffer.from(input)
    .subarray(0, limit - Buffer.byteLength(suffix))
    .toString()
  while (Buffer.byteLength(prefix + suffix) > limit) prefix = prefix.slice(0, -1)
  return prefix + suffix
}

function logTimestamp(name: string) {
  if (name.startsWith("dev.log.")) return name.slice("dev.log.".length)
  return name.slice(0, -".log".length)
}

async function cleanup(dir: string) {
  const candidates = await Promise.all(
    (
      await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    )
      .filter((entry) => entry.isFile() && managedLogName.test(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        size: (await fs.stat(path.join(dir, entry.name)).catch(() => null))?.size,
      })),
  )

  await Promise.all(
    candidates
      .filter((entry) => entry.size !== undefined && entry.size > maxLogSize())
      .map((entry) => fs.unlink(path.join(dir, entry.name)).catch(() => {})),
  )

  const files = candidates
    .filter((entry) => entry.size !== undefined && entry.size <= maxLogSize())
    .map((entry) => entry.name)
    .sort((a, b) => logTimestamp(a).localeCompare(logTimestamp(b)))
  if (files.length <= keep) return

  await Promise.all(files.slice(0, -keep).map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
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
