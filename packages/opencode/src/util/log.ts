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
}

let logpath = ""
export function file() {
  return logpath
}
let stream: ReturnType<typeof createWriteStream> | undefined
let written = 0
let write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}

function stamp() {
  return new Date().toISOString().split(".")[0].replace(/:/g, "")
}

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  if (options.print) return
  logpath = path.join(Global.Path.log, options.dev ? "dev.log" : stamp() + ".log")
  if (options.dev) {
    // Preserve previous dev.log as dev.log.<timestamp> for hang/incident
    // forensics. cleanup() above already prunes old archived logs.
    const stat = await fs.stat(logpath).catch(() => null)
    if (stat && stat.size > 0) await fs.rename(logpath, `${logpath}.${stamp()}`).catch(() => {})
  } else {
    await fs.truncate(logpath).catch(() => {})
  }
  stream = createWriteStream(logpath, { flags: "a" })
  written = 0
  write = async (msg: any) => {
    written += Buffer.byteLength(msg)
    if (written >= MAX_FILE_SIZE) {
      written = 0
      await rotate()
    }
    return new Promise((resolve, reject) => {
      stream!.write(msg, (err) => {
        if (err) reject(err)
        else resolve(msg.length)
      })
    })
  }
}

// Archive the active file as <logpath>.<timestamp> and start a fresh one at the
// same path, so file() stays stable. The renamed file is then subject to
// cleanup's total-size budget.
async function rotate() {
  const previous = stream
  await fs.rename(logpath, `${logpath}.${stamp()}`).catch(() => {})
  stream = createWriteStream(logpath, { flags: "a" })
  if (previous) previous.end()
  void cleanup(Global.Path.log)
}

async function cleanup(dir: string) {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const stats = await Promise.all(
    entries
      // Match session logs (<iso>.log), dev rotations (dev.log.<stamp>) and
      // size rotations (<name>.log.<stamp>). Skip the active file so it is
      // never deleted out from under the open write stream.
      .filter((name) => name.includes(".log") && path.join(dir, name) !== logpath)
      .map(async (name) => {
        const stat = await fs.stat(path.join(dir, name)).catch(() => null)
        return stat?.isFile() ? { name, size: stat.size } : null
      }),
  )
  // Sort oldest first by name; filenames are timestamp-encoded so lexical order
  // is chronological within each family.
  const files = stats.flatMap((f) => (f ? [f] : [])).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

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
