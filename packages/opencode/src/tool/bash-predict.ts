import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "@/util"
import { Flag } from "@/flag/flag"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { normalizeCommand } from "../session/try-best-detector"

// Slow-command prediction for bash: decides whether a command is "possibly
// slow" so it can enter background-job mode (see bash.ts runBackground) and how
// long the synchronous grace window should be before the handoff.
//
// Two signals, both cheap:
//   1. Static families — build/test/install-style commands whose runtime is
//      conventionally long (pytest, cargo build, npm install, bun run build…).
//      Pure string work; deliberately excludes long-running verbs (dev/serve/
//      watch) so those keep the classic kill-at-timeout path.
//   2. History — recorded durations of past completions, grouped per project
//      and per normalized command, median over the last samples. A command the
//      project has already measured as slow (or that died at the default
//      timeout, which records ~the timeout) qualifies without any static rule.
//
// Misclassification is cheap: eligibility only changes what happens AFTER the
// grace window, and a predicted-slow command that exits within its grace
// returns synchronously like any other.

const log = Log.create({ service: "bash-predict" })

const MAX_SAMPLES = 20
const MAX_KEYS = 500

// Heads that are slow regardless of arguments.
const SLOW_HEAD = new Set([
  "pytest",
  "py.test",
  "make",
  "cmake",
  "tsc",
  "rake",
  "gradle",
  "mvn",
  "gradlew",
  "mvnw",
])

// Heads slow only for certain subcommands/verbs.
const SLOW_VERB: Record<string, Set<string>> = {
  cargo: new Set(["build", "test", "bench", "install"]),
  go: new Set(["build", "test"]),
  dotnet: new Set(["build", "test", "publish"]),
  docker: new Set(["build"]),
  pip: new Set(["install"]),
  pip3: new Set(["install"]),
  npm: new Set(["install", "i", "add", "ci", "test", "build", "lint", "package"]),
  pnpm: new Set(["install", "i", "add", "ci", "test", "build", "lint", "package"]),
  yarn: new Set(["install", "i", "add", "ci", "test", "build", "lint", "package"]),
  bun: new Set(["install", "i", "add", "ci", "test", "build", "lint", "package"]),
}

// `<pm> run <script>`: only compile/test-family scripts count as slow — dev /
// serve / start / preview are intentionally absent (they never exit, so the
// classic timeout path stays their story).
const SLOW_SCRIPT = new Set(["build", "test", "lint", "typecheck", "compile", "package", "bench"])

// python: `-m pytest` / `-m unittest`, or a manage-style `migrate` / `test`.
function pythonSlow(args: string[]) {
  if (args[0] === "-m") return args[1] === "pytest" || args[1] === "unittest"
  return args.slice(0, 2).some((arg) => arg === "migrate" || arg === "test")
}

function segmentSlow(segment: string) {
  const tokens = segment.trim().split(/\s+/)
  if (!tokens[0]) return false
  // Skip leading VAR=value assignments (`NODE_ENV=production npm run build`).
  while (tokens.length > 1 && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift()
  let head = tokens[0]
  if ((head.startsWith('"') && head.endsWith('"')) || (head.startsWith("'") && head.endsWith("'"))) {
    head = head.slice(1, -1)
  }
  // Strip any directory component: ./gradlew, target\debug\foo, C:\tools\make.
  head = head.split(/[\\/]/).pop() ?? head
  head = head.toLowerCase()
  const args = tokens.slice(1)
  if (SLOW_HEAD.has(head)) return true
  if (head === "python" || head === "python3") return pythonSlow(args)
  const verbs = SLOW_VERB[head]
  if (!verbs) return false
  if (args[0] === "run") return SLOW_SCRIPT.has((args[1] ?? "").toLowerCase())
  return verbs.has((args[0] ?? "").toLowerCase())
}

// Split on any run of | ; & (covers &&, ||, ;, |, single &). Pieces produced
// inside redirects (`2>&1`) or quotes are harmless: only the first word of
// each segment is classified, and a wrong head just means "not slow".
export function slowCommand(command: string) {
  return command.split(/[|;&]+/).some(segmentSlow)
}

type Entry = { at: number; samples: number[] }
type Store = Record<string, Entry>

function file() {
  return process.env.MIMOCODE_BASH_TIMING_PATH ?? path.join(Global.Path.data, "bash-timing.json")
}

export function key(projectDir: string, command: string) {
  return `${AppFileSystem.normalizePath(path.resolve(projectDir))}::${normalizeCommand(command)}`
}

async function read(): Promise<Store> {
  try {
    const parsed = JSON.parse(await fs.readFile(file(), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

let counter = 0
async function write(store: Store) {
  const target = file()
  const tmp = `${target}.${process.pid}.${counter++}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(store))
  await fs.rename(tmp, target)
}

// Serialised read-modify-write so concurrent completions in this process never
// drop each other's samples. Cross-process races are last-write-wins — this is
// statistics, not state. Failures only lose a sample: warn and move on.
let queue = Promise.resolve()
export function record(key: string, durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return queue
  queue = queue
    .then(async () => {
      const store = await read()
      const entry: Entry = store[key] ?? { at: 0, samples: [] }
      entry.at = Date.now()
      entry.samples.push(Math.round(durationMs))
      if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES)
      store[key] = entry
      const keys = Object.keys(store)
      if (keys.length > MAX_KEYS) {
        keys.sort((a, b) => store[a].at - store[b].at)
        for (const stale of keys.slice(0, keys.length - MAX_KEYS)) delete store[stale]
      }
      await write(store)
    })
    .catch((error) => log.warn("could not persist bash timing sample", { error }))
  return queue
}

function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export async function estimate(projectDir: string, command: string) {
  const samples = (await read())[key(projectDir, command)]?.samples
  if (!samples?.length) return undefined
  return median(samples)
}

// How long to block synchronously before handing a backgroundable command to
// the monitor. No history → the full grace (today's behavior). History at or
// above the grace → skip almost everything, keeping a short warmup to catch
// instant failures (command not found). In between → wait out the prediction:
// finishing on time returns synchronously, overrunning it hands off.
export function graceFor(estimate?: number) {
  const grace = Flag.MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS
  if (estimate === undefined) return grace
  const warmup = Flag.MIMOCODE_EXPERIMENTAL_BASH_PREDICT_WARMUP_MS
  if (estimate >= grace) return warmup
  return Math.max(estimate, warmup)
}
