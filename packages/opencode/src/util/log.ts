import path from "path"
import fs from "fs/promises"
import { createWriteStream, type WriteStream, statSync } from "fs"
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

// TEMPORARY FIX for #530: size-based log rotation
const MAX_FILE_SIZE = 50 * 1024 * 1024    // single file cap: 50MB
const MAX_TOTAL_SIZE = 500 * 1024 * 1024  // total log dir cap: 500MB
const CLEANUP_INTERVAL = 200              // check cleanup every N writes

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
let logdir = ""
let stream: WriteStream | null = null
let currentSize = 0
let writeCount = 0
let rotating = false
const writeQueue: { msg: string; resolve: (n: number) => void; reject: (e: any) => void }[] = []
let draining = false

export function file() {
  return logpath
}
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

function generateLogFilename(): string {
  return new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log"
}

async function openStream(filepath: string): Promise<WriteStream> {
  const s = createWriteStream(filepath, { flags: "a" })
  try {
    const stat = await fs.stat(filepath).catch(() => null)
    currentSize = stat?.size ?? 0
  } catch {
    currentSize = 0
  }
  return s
}

async function rotateStream() {
  if (rotating || !stream) return
  rotating = true
  try {
    await new Promise<void>((resolve) => stream!.end(() => resolve()))
    stream = null
    logpath = path.join(logdir, generateLogFilename())
    stream = await openStream(logpath)
  } finally {
    rotating = false
  }
}

function drainQueue() {
  if (draining || writeQueue.length === 0) return
  draining = true
  const item = writeQueue.shift()!
  if (!stream) {
    item.reject(new Error("Log stream not initialized"))
    draining = false
    return
  }
  const msgSize = Buffer.byteLength(item.msg, "utf8")
  if (currentSize + msgSize > MAX_FILE_SIZE && !rotating) {
    rotateStream().then(() => {
      if (!stream) return
      stream.write(item.msg, (err) => {
        if (err) item.reject(err)
        else {
          currentSize += msgSize
          item.resolve(msgSize)
          checkCleanup()
        }
        draining = false
        drainQueue()
      })
    }).catch((e) => {
      item.reject(e)
      draining = false
      drainQueue()
    })
    return
  }
  stream.write(item.msg, (err) => {
    if (err) item.reject(err)
    else {
      currentSize += msgSize
      item.resolve(msgSize)
      checkCleanup()
    }
    draining = false
    drainQueue()
  })
}

export async function init(options: Options) {
  if (options.level) level = options.level
  logdir = Global.Path.log
  await cleanupByTotalSize(logdir)
  if (options.print) return
  logpath = path.join(
    logdir,
    options.dev ? "dev.log" : generateLogFilename(),
  )
  if (options.dev) {
    try {
      const stat = await fs.stat(logpath).catch(() => null)
      if (stat && stat.size > 0) {
        const stamp = new Date().toISOString().split(".")[0].replace(/:/g, "")
        await fs.rename(logpath, `${logpath}.${stamp}`).catch(() => {})
      }
    } catch {}
  } else {
    await fs.truncate(logpath).catch(() => {})
  }
  stream = await openStream(logpath)
  write = async (msg: any) => {
    return new Promise<number>((resolve, reject) => {
      writeQueue.push({ msg, resolve, reject })
      drainQueue()
    })
  }
}

let cleanupPending = false

function checkCleanup() {
  writeCount++
  if (writeCount % CLEANUP_INTERVAL === 0 && !cleanupPending) {
    cleanupPending = true
    cleanupByTotalSize(logdir).finally(() => {
      cleanupPending = false
    })
  }
}

async function cleanupByTotalSize(dir: string) {
  const files = (
    await Glob.scan("*.log*", {
      cwd: dir,
      absolute: true,
      include: "file",
    }).catch(() => [])
  )
    .filter((f) => {
      const base = path.basename(f)
      return /^\d{4}-\d{2}-\d{2}T\d{6}(\.\d+)?\.log/.test(base) || base === "dev.log"
    })
    .sort()

  if (files.length === 0) return

  let totalSize = 0
  const fileStats: { path: string; size: number }[] = []
  for (const f of files) {
    try {
      const stat = statSync(f)
      fileStats.push({ path: f, size: stat.size })
      totalSize += stat.size
    } catch {}
  }

  while (totalSize > MAX_TOTAL_SIZE && fileStats.length > 1) {
    const oldest = fileStats.shift()!
    if (oldest.path === logpath) {
      fileStats.push(oldest)
      continue
    }
    try {
      await fs.unlink(oldest.path)
      totalSize -= oldest.size
    } catch {}
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
