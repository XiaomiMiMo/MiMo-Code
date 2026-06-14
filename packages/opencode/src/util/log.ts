import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import { Global } from "../global"
import z from "zod"
import { Glob } from "@mimo-ai/shared/util/glob"

export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
export type Level = z.infer<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const MAX_LOG_SIZE = 100 * 1024 * 1024 // 100MB auto-rotate threshold
const KEEP = 10 // max log files to retain

let level: Level = "INFO"

function logTimestamp(): string {
  // YYYY-MM-DDTHHmmss — sortable, consistent for all rotated file suffixes
  return new Date().toISOString().split(".")[0].replace(/:/g, "")
}

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
let errorLogpath = ""
let writeCount = 0
export function file() {
  return logpath
}
export function errorFile() {
  return errorLogpath
}
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
let writeError = write

function createWriter(filepath: string) {
  const stream = createWriteStream(filepath, { flags: "a" })
  return (msg: any) =>
    new Promise<number>((resolve, reject) => {
      stream.write(msg, (err) => {
        if (err) reject(err)
        else resolve(msg.length)
      })
    })
}

async function maybeRotate(filepath: string, streamCheck: boolean) {
  try {
    const stat = await fs.stat(filepath).catch(() => null)
    if (stat && stat.size > MAX_LOG_SIZE) {
      await fs.rename(filepath, `${filepath}.${logTimestamp()}`).catch(() => {})
      return createWriter(filepath)
    }
  } catch {}
  return streamCheck ? undefined : createWriter(filepath)
}

function makeWrite(filepath: string, checkInterval: number = 100) {
  let writer = createWriter(filepath)
  return async (msg: any) => {
    writeCount++
    if (writeCount % checkInterval === 0) {
      const newWriter = await maybeRotate(filepath, true)
      if (newWriter) writer = newWriter
    }
    return writer(msg)
  }
}

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  if (options.print) return

  if (options.dev) {
    // Dev mode: rotate existing dev.log → dev.log.<ts>, write to new dev.log
    const devLog = path.join(Global.Path.log, "dev.log")
    try {
      const stat = await fs.stat(devLog).catch(() => null)
      if (stat && stat.size > 0) {
        await fs.rename(devLog, `${devLog}.${logTimestamp()}`).catch(() => {})
      }
    } catch {}
    logpath = devLog
  } else {
    logpath = path.join(Global.Path.log, `${logTimestamp()}.log`)
  }
  errorLogpath = path.join(Global.Path.log, `error.log`)

  write = makeWrite(logpath)
  writeError = makeWrite(errorLogpath)
}

async function cleanup(dir: string) {
  // Cleanup timestamped production logs (keep newest KEEP)
  const tsLogs = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .map((f) => path.basename(f))
    .sort()
  if (tsLogs.length > KEEP) {
    const doomed = tsLogs.slice(0, -KEEP)
    await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
  }

  // Cleanup rotated dev logs (dev.log.<ts> — keep newest KEEP)
  const devLogs = (
    await Glob.scan("dev.log.*", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .map((f) => path.basename(f))
    .sort()
  if (devLogs.length > KEEP) {
    const doomed = devLogs.slice(0, -KEEP)
    await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
  }

  // Cleanup rotated error logs (error.log.<ts> — keep newest KEEP)
  const errLogs = (
    await Glob.scan("error.log.*", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .map((f) => path.basename(f))
    .sort()
  if (errLogs.length > KEEP) {
    const doomed = errLogs.slice(0, -KEEP)
    await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
  }
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
        const line = "ERROR " + build(message, extra)
        write(line)
        writeError(line)
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
