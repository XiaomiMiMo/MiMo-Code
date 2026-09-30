import z from "zod"
import { childProcessEnv } from "@/util/child-process-env"
import crypto from "crypto"
import os from "os"
import { createWriteStream, existsSync, realpathSync } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import GPT_DESCRIPTION from "./bash.gpt.txt"
import { Log } from "../util"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"

import { SessionCwd } from "./session-cwd"
import * as MergeConflict from "./merge-conflict-notice"
import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { Git } from "../git"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { inboxServiceRef } from "../inbox/inbox-ref"
import * as BashJob from "./bash-job"
import * as BashPredict from "./bash-predict"
import { Deferred, Effect, Option, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import * as BashInteractive from "./bash-interactive"
import * as BashTokenEfficient from "./bash_token_efficient_pipeline"
import * as BashTokenEfficientHeuristic from "./bash_token_efficient_heuristic"

const MAX_METADATA_LENGTH = 30_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 30_000
const DEFAULT_TIMEOUT = Flag.MIMOCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const PS = new Set(["powershell", "pwsh"])
// Delete targets under the OS temp dir are exempt from the forced-ask
// confirmation: scratch space is where an agent legitimately churns files, and
// nothing there is the user's durable work. The exemption is deliberately
// narrow — see `tmpOnlyDelete`, which grants it ONLY when every path argument
// of every delete command resolves, unambiguously, inside a temp root.
//
// macOS reports /tmp and /var as symlinks into /private, so containment must be
// checked on REALPATHS: a lexical check would reject the literal "/tmp/x" even
// though it lives inside the canonical os.tmpdir() jail. "/tmp" is listed
// alongside os.tmpdir() because on macOS they are DIFFERENT directories
// (/private/tmp vs /private/var/folders/...). Mirrors tool-script.ts's jail.
function tmpRoots() {
  return [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
}

function realpathBestEffort(p: string) {
  let cur = p
  let suffix = ""
  while (true) {
    try {
      return path.join(realpathSync.native(cur), suffix)
    } catch {
      suffix = suffix ? path.join(path.basename(cur), suffix) : path.basename(cur)
      const parent = path.dirname(cur)
      if (parent === cur) return p
      cur = parent
    }
  }
}

function insideTmp(resolved: string) {
  const abs = realpathBestEffort(resolved)
  return tmpRoots()
    .map(realpathBestEffort)
    .some((root) => abs !== root && abs.startsWith(root + path.sep))
}

const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

export function bashDescription(gpt = false) {
  const name = Shell.name(Shell.acceptable())
  const chaining =
    name === "powershell"
      ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
      : "If the commands depend on each other and must run sequentially, use a single `bash` call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, or git add before git commit), run these operations sequentially in one command instead of assuming they will interleave correctly across calls."
  return (gpt ? GPT_DESCRIPTION : DESCRIPTION)
    .replaceAll("${directory}", Instance.directory)
    .replaceAll("${os}", process.platform)
    .replaceAll("${shell}", name)
    .replaceAll("${chaining}", chaining)
    .replaceAll("${maxTokens}", String(DEFAULT_MAX_OUTPUT_TOKENS))
}

// Irreversible file/directory removal commands. Names are matched
// case-insensitively for PowerShell; bash is case-sensitive.
const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  // Windows / PowerShell removal verbs and their common aliases. `remove-item`
  // is the canonical verb; `ri`, `rd`, `del`, `erase` are aliases.
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
])

// git subcommands that destroy history, working tree state, or remote branches.
// Value is the set of tokens (flag or subcommand keyword) that must appear
// anywhere in the argv for the invocation to count as destructive. An empty
// set means the subcommand is destructive on its own.
const GIT_DESTRUCTIVE = new Map<string, Set<string>>([
  ["reset", new Set(["--hard"])],
  ["clean", new Set(["-f", "-ff", "-fd", "-fdx", "-df", "-dfx", "-fx", "--force"])],
  ["branch", new Set(["-D", "--delete"])],
  ["tag", new Set(["-d", "--delete"])],
  ["worktree", new Set(["remove"])],
  ["push", new Set(["--force", "-f"])],
  ["stash", new Set(["drop", "clear"])],
])

const Parameters = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  max_output_tokens: z
    .number()
    .int()
    .positive()
    .describe(
      `Maximum approximate tokens returned inline. Defaults to ${DEFAULT_MAX_OUTPUT_TOKENS}. Full output is saved to tool storage when this limit is exceeded.`,
    )
    .optional(),
  workdir: z
    .string()
    .describe(
      `Working directory for the command.`,
    )
    .optional(),
  interactive: z
    .boolean()
    .describe(
      "Set to true when the command requires user interaction (password input, y/N confirmation, SSH key passphrase, etc). The terminal will be handed to the user for direct interaction.",
    )
    .optional(),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    ),
})

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  deletes: Set<string>
}

type Chunk = {
  text: string
  size: number
}

// The per-invocation inputs shared by the synchronous path (run) and the
// background monitor (runBackground).
type Input = {
  shell: string
  name: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxOutputTokens: number
  description: string
  // Slow-prediction identity for the timing store (project dir + normalized
  // command). Captured in execute, where instance ALS is available, so
  // finalize and the background monitor never read ALS themselves.
  timingKey: string
}

// Output accumulator for one invocation: the drain callback appends into it
// while the command runs and `finalize` turns its final state into the tool
// result, so both execution paths produce identical output for identical
// bytes. `activity` is the monitor's own liveness clock — it cannot come from
// ctx.metadata, because a completed part's update is a no-op.
type Accum = {
  bytes: number
  keep: number
  full: string
  first: string
  last: string
  list: Chunk[]
  used: number
  total: number
  file: string
  sink: ReturnType<typeof createWriteStream> | undefined
  cut: boolean
  expired: boolean
  aborted: boolean
  activity: number
  // Invocation start, for the slow-prediction timing sample that finalize
  // records (wall clock from spawn-side setup to the terminal outcome).
  start: number
}

function accum(maxOutputTokens: number): Accum {
  const bytes = maxOutputTokens * 4
  return {
    bytes,
    keep: bytes * 2,
    full: "",
    first: "",
    last: "",
    list: [],
    used: 0,
    total: 0,
    file: "",
    sink: undefined,
    cut: false,
    expired: false,
    aborted: false,
    activity: Date.now(),
    start: Date.now(),
  }
}

// The three outcomes the background monitor can hand back to the still-awaited
// tool call: the process ended (exit), the user aborted (abort), or the grace
// period expired (grace). In the first two the tool finalizes locally exactly
// like the classic path; grace means the tool returns a handoff result and
// the monitor owns everything after.
type Handoff = { kind: "exit" | "abort" | "grace"; code: number | null }

// The monitor's terminal state after handoff, parked for finalize/delivery.
type Monitor = { kind: "exit" | "signaled" | "stall"; code: number | null }

// Stall detector for the background monitor: fails once the process has been
// alive with no new output for stallMs. Polling instead of a per-chunk timer
// because the chunk loop lives in the drain fiber — the poll only bounds
// detection latency (never early, never more than one poll late: the
// comparison is against the timestamp the drain wrote). Shape copied from
// mcp/sampling.ts's stallWatch.
function stallWatch(acc: Accum, stallMs: number) {
  const poll = Math.max(25, Math.min(250, Math.floor(stallMs / 4)))
  return Effect.forever(
    Effect.sleep(poll).pipe(
      Effect.flatMap(() => (Date.now() - acc.activity >= stallMs ? Effect.fail("stall") : Effect.void)),
    ),
  )
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

// Returns true when `tokens` (the flat argv of a single command node) invokes
// an irreversible deletion — either a direct removal command (rm, remove-item,
// …) or a destructive git subcommand (git reset --hard, git clean -f, …).
// `ps` toggles PowerShell case-insensitive matching.
function isDelete(tokens: string[], ps: boolean) {
  if (tokens.length === 0) return false
  const head = ps ? tokens[0].toLowerCase() : tokens[0]
  if (DELETE_COMMANDS.has(head)) return true
  if (head === "git" && tokens.length >= 2) {
    const sub = tokens[1]
    const flags = GIT_DESTRUCTIVE.get(sub)
    if (!flags) return false
    if (flags.size === 0) return true
    return tokens.slice(2).some((tok) => flags.has(tok))
  }
  return false
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function headBytes(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf-8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf-8")
}

function tail(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const lines = text.split("\n")
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

// Secondary confirmation for irreversible deletion commands. Uses its own
// permission type ("bash_delete"), which the Permission layer flags as
// forced-ask: no `allow` rule (not even a broad `"*": allow`) can silently
// pre-approve it — only an explicit `deny` blocks. `always` is empty because
// a persisted "allow all deletes" rule is exactly what forced-ask exists to
// prevent. The delete UI shows the full command, so this ask FULLY replaces
// the regular bash/external_directory prompts when it fires (see the caller
// below) — deletion is authorized in a single, unambiguous confirmation.
const askDelete = Effect.fn("BashTool.askDelete")(function* (ctx: Tool.Context, scan: Scan, command: string) {
  const patterns = Array.from(scan.deletes)
  yield* ctx.ask({
    permission: "bash_delete",
    patterns,
    always: [],
    metadata: { command, deletes: patterns },
  })
})

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    const prefixed = `${Shell.POWERSHELL_UTF8_PREFIX}${command}`
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefixed], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  const finalCommand =
    process.platform === "win32" && name === "cmd" ? `${Shell.CMD_UTF8_PREFIX}${command}` : command

  return ChildProcess.make(finalCommand, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const gitSvc = yield* Git.Service
    // Optional rather than a required service: fixtures that init this tool
    // without a Session layer must keep working (they get None, and the
    // background monitor simply skips the tool-part rewrite). In production
    // the registry provides Session, so post-handoff outcomes land on the
    // original tool part.
    const session = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))

    // Layer-2 floor for git authorship: an agent may create a worktree/clone or
    // commit in an ad-hoc dir via this bash tool, bypassing Worktree.setup()'s
    // per-worktree local-config fix. Propagate the project repo's own identity so
    // those commits are attributed the same way a commit in the project repo is.
    //
    // Behavioral contract of this floor and its cache:
    //   - It only ever PROPAGATES an identity the repo itself already resolves.
    //     It never invents one: when the repo has no identity — or there is no
    //     repo at all — nothing is injected and git resolves authorship itself
    //     (config, then `EMAIL`, then its own `user@hostname` autodetect, then
    //     its own error). A hardcoded substitute would misattribute the commit
    //     AND pre-empt resolution paths `git config` cannot see.
    //   - It is delivered as GIT_AUTHOR_*/GIT_COMMITTER_* ENV, and git gives env
    //     vars precedence OVER `user.name`/`user.email` config — including the
    //     config of some OTHER repo the command happens to run in. That is
    //     exactly why an unresolved field must inject nothing rather than a
    //     placeholder: a placeholder would outrank that repo's correct config.
    //   - Because the resolved value is memoized per worktree path for the
    //     lifetime of the process, a `git config user.name ...` performed
    //     mid-session is NOT picked up until the process restarts.
    //   - Operator-set GIT_AUTHOR_*/GIT_COMMITTER_* still win: shellEnv only
    //     fills the vars that are absent from the child environment baseline (see below).
    //
    // resolveGitIdentity and gitIdentityCache live in this outer setup block,
    // not inside shellEnv, precisely so the cache persists across every bash
    // invocation instead of being rebuilt (and re-spawning two `git config`
    // subprocesses) on each call.
    const gitIdentityCache = new Map<string, { name?: string; email?: string }>()
    const resolveGitIdentity = Effect.fn("BashTool.resolveGitIdentity")(function* () {
      const worktree = Instance.worktree
      const cached = gitIdentityCache.get(worktree)
      if (cached) return cached
      // Non-git projects set worktree to "/". There is no project repo whose
      // identity we could propagate, and whatever repo a git command does run in
      // has its own config — which injected env would override. Inject nothing.
      if (worktree === "/") {
        const none: { name?: string; email?: string } = {}
        gitIdentityCache.set(worktree, none)
        return none
      }
      const name = (yield* gitSvc.run(["config", "user.name"], { cwd: worktree })).text().trim()
      const email = (yield* gitSvc.run(["config", "user.email"], { cwd: worktree })).text().trim()
      if (!name || !email)
        log.warn("git identity not fully resolved from repo config; leaving authorship to git", {
          worktree,
          name: name ? "resolved" : "unset",
          email: email ? "resolved" : "unset",
        })
      const identity = { ...(name ? { name } : {}), ...(email ? { email } : {}) }
      gitIdentityCache.set(worktree, identity)
      return identity
    })

    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("BashTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    // Whether EVERY delete in this command line is a plain removal confined to a
    // temp root — the one case where the forced-ask confirmation is skipped.
    //
    // Fails closed on purpose, in four ways. Any single miss means "ask":
    //   1. Only DELETE_COMMANDS qualify. Destructive git subcommands
    //      (reset --hard, push --force, stash drop, …) act on repository state,
    //      not on a path in tmp, so they can never earn the exemption.
    //   2. A delete with no path arguments cannot be shown to be tmp-scoped.
    //   3. An argument `argPath` declines to resolve — a glob, a `$VAR`, a `$(…)`
    //      substitution (see `dynamic`) — is UNKNOWN, and unknown is not tmp.
    //      This is the load-bearing case: `rm -rf $BUILD_DIR/*` must still ask.
    //   4. A resolved path outside a temp root, including a root itself
    //      (`insideTmp` requires a strict descendant, so `rm -rf /tmp` asks).
    //   5. A path inside the PROJECT, even when the project itself lives under a
    //      temp root (a real configuration — the test fixtures do exactly this).
    //      Scratch space earns the exemption because it holds no durable work;
    //      a checkout's own files are durable wherever they happen to sit.
    const tmpOnlyDelete = Effect.fn("BashTool.tmpOnlyDelete")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        if (!isDelete(tokens, ps)) continue
        const head = ps ? tokens[0]?.toLowerCase() : tokens[0]
        if (!head || !DELETE_COMMANDS.has(head)) return false
        const args = pathArgs(command, ps)
        if (args.length === 0) return false
        for (const arg of args) {
          const resolved = yield* argPath(arg, cwd, ps, shell)
          if (!resolved || !insideTmp(resolved) || Instance.containsPath(resolved)) return false
        }
      }
      return true
    })

    // Whether some command in this line EXECUTES a project-built program — its
    // head token is a path resolving inside the project directory/worktree
    // (./dist/app, target/debug/foo, .\run.ps1), as opposed to an OS tool like
    // ls/git or a PATH-resolved bare name. Such a program's runtime cannot be
    // predicted, which is what earns the command background-job mode in
    // `execute`. Deliberately narrow, failing closed to the classic path:
    //   - only PATH-SHAPED heads (containing a separator or starting with ~)
    //     are even resolved; a bare name resolves through PATH to anywhere.
    //   - a head `argPath` declines to resolve — a $VAR-composed path, a glob
    //     (see `dynamic`) — cannot be proven to be project code, so it is not.
    //   - a resolved path outside the project is someone else's program.
    const projectCommand = Effect.fn("BashTool.projectCommand")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      for (const node of commands(root)) {
        const command = parts(node)
        const head = command[0]?.text
        if (!head) continue
        if (!/[/\\]/.test(head) && !head.startsWith("~")) continue
        const resolved = yield* argPath(head, cwd, ps, shell)
        if (resolved && Instance.containsPath(resolved)) return true
      }
      return false
    })

    const collect = Effect.fn("BashTool.collect")(function* (root: Node, cwd: string, ps: boolean, shell: string) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
        deletes: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && FILES.has(cmd)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }

        if (isDelete(tokens, ps)) scan.deletes.add(source(node))
      }

      return scan
    })

    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const identity = yield* resolveGitIdentity()
      const inherited = childProcessEnv()
      // Only fill vars the operator hasn't already set, so an explicit
      // GIT_AUTHOR_* in the environment still wins over our floor — and only
      // fields the repo itself resolved, so an unresolved field is left for git.
      const gitFloor: Record<string, string> = {}
      if (identity.name && !inherited["GIT_AUTHOR_NAME"]) gitFloor["GIT_AUTHOR_NAME"] = identity.name
      if (identity.email && !inherited["GIT_AUTHOR_EMAIL"]) gitFloor["GIT_AUTHOR_EMAIL"] = identity.email
      if (identity.name && !inherited["GIT_COMMITTER_NAME"]) gitFloor["GIT_COMMITTER_NAME"] = identity.name
      if (identity.email && !inherited["GIT_COMMITTER_EMAIL"]) gitFloor["GIT_COMMITTER_EMAIL"] = identity.email
      // childProcessEnv: this env goes to agent-authored commands.
      return {
        ...inherited,
        // Python ignores the console code page when stdout is a pipe and falls
        // back to the ANSI code page (GBK on zh-CN), producing mojibake. Force
        // UTF-8 for child Python processes on Windows.
        ...(process.platform === "win32" ? { PYTHONIOENCODING: "utf-8" } : {}),
        // Git authorship floor. Placed after process.env so the spread order
        // reads naturally, but it can never clobber an operator value: gitFloor
        // only ever holds keys that were absent from the child baseline. A plugin's
        // extra.env comes last and so can still override the floor.
        ...gitFloor,
        ...extra.env,
      }
    })

    const drain = Effect.fn("BashTool.drain")(function* (
      handle: ChildProcessHandle,
      acc: Accum,
      input: Input,
      ctx: Tool.Context,
    ) {
      yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
        const size = Buffer.byteLength(chunk, "utf-8")
        acc.total += size
        acc.activity = Date.now()
        if (Buffer.byteLength(acc.first, "utf-8") < Math.floor(acc.bytes / 2)) {
          acc.first = headBytes(acc.first + chunk, Math.floor(acc.bytes / 2))
        }
        acc.list.push({ text: chunk, size })
        acc.used += size
        while (acc.used > acc.keep && acc.list.length > 1) {
          const item = acc.list.shift()
          if (!item) break
          acc.used -= item.size
          acc.cut = true
        }

        acc.last = preview(acc.last + chunk)

        if (acc.file) {
          acc.sink?.write(chunk)
        } else {
          acc.full += chunk
          if (Buffer.byteLength(acc.full, "utf-8") > acc.bytes) {
            return trunc.write(acc.full).pipe(
              Effect.andThen((next) =>
                Effect.sync(() => {
                  acc.file = next
                  acc.cut = true
                  acc.sink = createWriteStream(next, { flags: "a" })
                  acc.full = ""
                }),
              ),
              Effect.andThen(
                ctx.metadata({
                  metadata: {
                    output: acc.last,
                    description: input.description,
                  },
                }),
              ),
            )
          }
        }

        return ctx.metadata({
          metadata: {
            output: acc.last,
            description: input.description,
          },
        })
      })
    })

    const finalize = Effect.fn("BashTool.finalize")(function* (acc: Accum, input: Input, code: number | null) {
      // One timing sample per invocation — phase-1 and monitor finalize are
      // mutually exclusive (the deferred protocol), and a user abort is
      // skipped so its partial lifetime never lands in the history. A
      // timeout/stall kill records its full life, which is exactly what the
      // next run needs to predict (self-healing cold start).
      if (!acc.aborted && Flag.MIMOCODE_EXPERIMENTAL_BASH_PREDICT) {
        yield* Effect.promise(() => BashPredict.record(input.timingKey, Date.now() - acc.start))
      }
      const meta: string[] = []
      if (acc.expired) {
        meta.push(
          `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (acc.aborted) meta.push("User aborted the command")
      const raw = acc.list.map((item) => item.text).join("")
      const end = tail(raw, acc.bytes)
      if (end.cut) acc.cut = true
      if (!acc.file && end.cut) {
        acc.file = yield* trunc.write(raw)
      }

      // Token-efficient post-cleanse: RTK-style ANSI strip / progress fold /
      // secret redact / long-line elide. Only applied when no tool storage is
      // involved — once the output spills to a truncation file, the on-disk
      // archive stays raw and cleaning is skipped to keep the inline preview
      // consistent with the archive.
      const cleaned =
        !acc.file && Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY
          ? BashTokenEfficient.clean(end.text, { command: input.command })
          : null
      if (cleaned && cleaned.bytesOut < cleaned.bytesIn) {
        log.info("bash output cleaned", {
          bytesIn: cleaned.bytesIn,
          bytesOut: cleaned.bytesOut,
          saved: cleaned.bytesIn - cleaned.bytesOut,
        })
      }

      // Heuristic (shape-based) pipeline runs AFTER the common pipeline and
      // only when both flags are on. Same never-worse contract — a shape that
      // doesn't shrink the bytes is discarded.
      const heuristic =
        !acc.file &&
        Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY &&
        Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_HEURISTIC
          ? BashTokenEfficientHeuristic.cleanHeuristic(cleaned?.text ?? end.text, { command: input.command })
          : null
      if (heuristic && heuristic.bytesOut < heuristic.bytesIn) {
        log.info("bash output heuristic cleaned", {
          shape: heuristic.shape,
          bytesIn: heuristic.bytesIn,
          bytesOut: heuristic.bytesOut,
          saved: heuristic.bytesIn - heuristic.bytesOut,
        })
      }

      let output = heuristic?.text ?? cleaned?.text ?? end.text
      if (!output) output = "(no output)"

      if (acc.cut && acc.file) {
        const suffix = tail(raw, acc.bytes - Buffer.byteLength(acc.first, "utf-8")).text
        const shown = Buffer.byteLength(acc.first, "utf-8") + Buffer.byteLength(suffix, "utf-8")
        output = `Warning: truncated output (original token count: ${Math.ceil(acc.total / 4)})\n\n${acc.first}\n…${Math.ceil((acc.total - shown) / 4)} tokens truncated…\n${suffix}`
      }

      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }

      // Conflict-ownership affordance. When this command left git mid-merge with
      // unmerged paths, the result itself carries the rule (the conflict belongs
      // to the branch's owner) and the two literal commands that follow it —
      // because the model reads a tool result before its next tool call, and
      // does not re-read a system prompt assembled requests ago. Appended after command
      // output and never blocking; a tool-storage pointer may follow it so a
      // truncated result always ends with the address of its complete output.
      output += yield* MergeConflict.annotate({
        git: gitSvc,
        cwd: input.cwd,
        command: input.command,
        output,
      })
      if (acc.cut && acc.file) output += `\n\nFull output saved to: ${acc.file}`
      if (acc.sink) {
        const stream = acc.sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      return {
        title: input.description,
        metadata: {
          output: acc.last || preview(output),
          exit: code,
          description: input.description,
          truncated: acc.cut,
          ...(acc.cut && acc.file ? { outputPath: acc.file } : {}),
        },
        output,
      }
    })

    const run = Effect.fn("BashTool.run")(function* (input: Input, ctx: Tool.Context) {
      const acc = accum(input.maxOutputTokens)

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(drain(handle, acc, input, ctx))

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            acc.aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            acc.expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      return yield* finalize(acc, input, code)
    })

    // Background mode for project-built executables and predicted-slow
    // commands (see projectCommand and bash-predict): the command runs
    // synchronously behind the tool call for `grace` — the full GRACE_MS when
    // nothing is known about the runtime, or the predicted duration (down to
    // a warmup floor) when this project's history says the command is slow —
    // with identical streaming and metadata updates to the classic path. If
    // it is still running at grace expiry the tool returns a handoff result
    // (no numeric `exit`, so a caller's non-zero-exit gate never fires on a
    // job that has not finished) while this monitor, forked into the instance
    // scope, owns the process: finalize on exit, kill on a STALL_MS output
    // stall, rewrite the tool part, and deliver the outcome to the session.
    // An explicit `timeout` param never reaches here — it opts into the
    // classic kill-at-timeout (run) instead.
    const runBackground = Effect.fn("BashTool.runBackground")(function* (
      input: Input,
      ctx: Tool.Context,
      grace: number,
      estimate?: number,
    ) {
      const acc = accum(input.maxOutputTokens)
      const stallMs = Flag.MIMOCODE_EXPERIMENTAL_BASH_JOB_STALL_MS
      const jobID = crypto.randomUUID()
      const resume = yield* Deferred.make<Handoff>()

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const monitor = Effect.gen(function* () {
        let handed = false
        let outcome: Monitor | undefined

        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))
            yield* Effect.forkScoped(drain(handle, acc, input, ctx))

            const abort = Effect.callback<void>((resumeRace) => {
              if (ctx.abort.aborted) return resumeRace(Effect.void)
              const handler = () => resumeRace(Effect.void)
              ctx.abort.addEventListener("abort", handler, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
            })

            const first = yield* Effect.raceAll([
              handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
              abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
              Effect.sleep(`${grace} millis`).pipe(Effect.map(() => ({ kind: "grace" as const, code: null }))),
            ])

            if (first.kind !== "grace") {
              if (first.kind === "abort") yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              return first
            }

            handed = true
            yield* Deferred.succeed(resume, first)

            // Post-handoff the abort leg is deliberately dropped: ctx.abort
            // fires on normal turn teardown, which must not kill a job the
            // model was told would keep running. From here only the stall
            // watch — and instance disposal, through the forked scope — stop it.
            outcome = yield* Effect.raceFirst(
              handle.exitCode.pipe(
                Effect.map((code) => ({ kind: "exit" as const, code })),
                Effect.catch(() => Effect.succeed({ kind: "signaled" as const, code: null })),
              ),
              stallWatch(acc, stallMs),
            ).pipe(
              Effect.catch(() => Effect.succeed({ kind: "stall" as const, code: null })),
            )
            if (outcome.kind === "stall") {
              yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
            }
            return first
          }),
        ).pipe(Effect.orDie, Effect.exit)

        // Exactly-one completion for the tool's await: runs after the scope
        // closed (so the drain fiber is interrupted before a phase-1 finalize
        // reads the accumulator — the classic path's ordering), is a no-op
        // when grace already completed the deferred, and must not be skippable
        // by a pending interruption or the tool would hang forever.
        yield* Deferred.done(resume, exit).pipe(Effect.uninterruptible)

        if (!handed) return

        // Handoff is out; the monitor owns delivery: shared finalize → tool
        // part rewrite → inbox.
        if (!outcome) log.warn("bash background monitor ended without an outcome", { jobID })
        const result = yield* finalize(acc, input, outcome?.code ?? null)
        const notes: string[] = []
        if (outcome?.kind === "stall") {
          notes.push(
            `bash job ${jobID}: the process produced no output for ${stallMs} ms while still running and was killed. The output above ends where it stalled — diagnose from there (hang, deadlock, or waiting on input), fix the cause, and rerun. If the command legitimately runs silently for longer than ${stallMs} ms, rerun with an explicit timeout parameter so the classic timer applies instead.`,
          )
        }
        if (outcome?.kind === "signaled") {
          notes.push(`bash job ${jobID}: the process was terminated by an external signal (not a timeout or stall kill).`)
        }
        if (!outcome) {
          notes.push(`bash job ${jobID}: the background monitor ended unexpectedly; the state above may be incomplete.`)
        }
        const output =
          notes.length > 0
            ? result.output + "\n\n<bash_metadata>\n" + notes.join("\n") + "\n</bash_metadata>"
            : result.output

        // Rewrite the original tool part in place (plan.ts precedent): the
        // handoff result the processor stamped says "running in background";
        // the transcript must show the real terminal state once the job ends.
        if (session) {
          const part = MessageV2.parts(ctx.messageID).find((item) => item.type === "tool" && item.callID === ctx.callID)
          if (part?.type === "tool") {
            yield* session.updatePart({
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                output,
                metadata: { ...result.metadata, jobID },
                title: result.title,
                time: {
                  start: "time" in part.state ? part.state.time.start : Date.now(),
                  end: Date.now(),
                },
              },
            })
          }
        }

        // Deliver to this session so the model continues with the real
        // outcome (type "text" → render.ts's <inbox> wrapper; receiver "main"
        // is the session-level default from actor/notification.ts). A missing
        // ref (fixtures) or unknown receiver degrades to a log — the part
        // rewrite above already persists the outcome for the next turn.
        const inbox = inboxServiceRef.current
        if (!inbox) {
          log.warn("bash job outcome not delivered: no inbox service wired", { jobID })
        }
        if (inbox) {
          const status =
            outcome?.kind === "stall"
              ? "killed after output stall"
              : outcome?.kind === "signaled"
                ? "terminated by external signal"
                : `exit code ${String(outcome?.code ?? "unknown")}`
          yield* inbox
            .send({
              receiverSessionID: ctx.sessionID,
              receiverActorID: "main",
              content: `Background command ${outcome?.kind === "stall" ? "was stopped by the monitor" : "finished"} (job ${jobID}).\nCommand: ${input.command}\nResult: ${status}\n\n${output}`,
              type: "text",
            })
            .pipe(
              Effect.catch(() =>
                Effect.sync(() => log.warn("bash job outcome could not be delivered to the inbox", { jobID })),
              ),
            )
        }
      })

      const started = yield* Effect.tryPromise(() => BashJob.start(jobID, monitor)).pipe(Effect.option)
      if (Option.isNone(started)) {
        // The monitor never forked (no instance runtime at this call site):
        // no process exists yet, so the classic path can take over cleanly.
        log.warn("could not fork background bash monitor; running synchronously instead", { jobID })
        return yield* run(input, ctx)
      }

      // The monitor resolves this on every phase-1 outcome: an exit or abort
      // within the grace window means the classic synchronous return (the
      // monitor already killed on abort, and the drain fiber is interrupted
      // before this finalize reads the accumulator — same ordering as run),
      // while grace means the job outlived the window and is now the
      // monitor's to deliver.
      const first = yield* Deferred.await(resume)
      if (first.kind !== "grace") {
        if (first.kind === "abort") acc.aborted = true
        return yield* finalize(acc, input, first.code)
      }

      return {
        title: input.description,
        output: `Command was still running after ${grace} ms${estimate === undefined ? "" : ` (history predicts about ${estimate} ms for this command)`}, so it has been handed off to a background monitor (job ${jobID}). The final output and exit status will arrive in this session as an inbox message when the process ends — do NOT poll with repeated bash calls. The monitor kills the process if it produces no output for ${stallMs} ms and then sends repair instructions. Pass an explicit timeout parameter if you instead want the classic synchronous kill-at-timeout behavior.`,
        metadata: {
          output: `running in background (job ${jobID})`,
          // exit stays null (not a number) while the job runs: the caller's
          // non-zero-exit gate only fires on numeric exits, and the monitor
          // rewrites the part with the real code once the process ends.
          exit: null,
          description: input.description,
          truncated: false,
          running: true,
          jobID,
        },
      }
    })

    return () =>
      Effect.sync(() => {
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        log.info("bash tool using shell", { shell })

        return {
          description: bashDescription(),
          parameters: Parameters,
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const effectiveCwd = SessionCwd.get(ctx.sessionID)
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, effectiveCwd, shell)
                : effectiveCwd
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const ps = PS.has(name)
              const root = yield* parse(params.command, ps)
              const scan = yield* collect(root, cwd, ps, shell)
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
              // Delete-containing commands normally use askDelete alone — the
              // delete UI shows the full command, so another bash prompt would
              // duplicate the confirmation. Auto-approved deletes still pass
              // through askDelete so an explicit `bash_delete: deny` wins, then
              // fall back to the regular ask so `bash: deny` wins too.
              // `tmpOnlyDelete` trusts one whose every target is provably inside
              // a temp root; scratch space holds no durable user work, and that
              // check fails closed on anything it cannot resolve.
              // Instance-scoped, NOT a process-global: one server process serves
              // many directories with independent permission state, so a global
              // carrier would let a permissive directory silently auto-approve
              // deletes in a strict one. Absent accessor ⇒ not exempt (ask).
              const autoApproveDelete =
                scan.deletes.size > 0 && ctx.autoApproveDelete ? yield* ctx.autoApproveDelete() : false
              const skipDeleteAsk = scan.deletes.size === 0 || (yield* tmpOnlyDelete(root, cwd, ps, shell))
              if (!skipDeleteAsk) {
                yield* askDelete(ctx, scan, params.command)
                if (autoApproveDelete) yield* ask(ctx, scan)
              } else {
                yield* ask(ctx, scan)
              }

              // Interactive mode: hand terminal to user for direct interaction
              if (params.interactive) {
                const env = yield* shellEnv(ctx, cwd)
                yield* ctx.metadata({
                  metadata: {
                    output: "(waiting for user interaction...)",
                    description: params.description,
                  },
                })
                const interactiveResult = yield* Effect.tryPromise(() =>
                  BashInteractive.request({
                    sessionID: ctx.sessionID,
                    messageID: ctx.messageID,
                    callID: ctx.callID,
                    command: params.command,
                    cwd,
                    env: env as Record<string, string>,
                    description: params.description,
                  }),
                ).pipe(Effect.orDie)
                return {
                  title: params.description,
                  metadata: {
                    output: interactiveResult.output || "(interactive command completed)",
                    exit: interactiveResult.exitCode,
                    description: params.description,
                    truncated: false,
                  },
                  output:
                    interactiveResult.output ||
                    `(interactive command completed with exit code ${interactiveResult.exitCode})`,
                }
              }

              const projectDir = Instance.directory
              const input: Input = {
                shell,
                name,
                command: params.command,
                cwd,
                env: yield* shellEnv(ctx, cwd),
                timeout,
                maxOutputTokens: params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
                description: params.description,
                timingKey: BashPredict.key(projectDir, params.command),
              }
              // Background-job mode: an explicit timeout opts into the classic
              // kill-at-timeout, and interactive already returned above. Two
              // eligibility signals otherwise — a project-built executable
              // (runtime unpredictable) or slow prediction (static family or
              // this project's history, see bash-predict). Only a prediction
              // shortens the grace window: no history means the full GRACE_MS;
              // a known duration waits out that estimate, so a fast finish
              // still returns synchronously and an overrun hands off.
              const eligible = params.timeout === undefined && Flag.MIMOCODE_EXPERIMENTAL_BASH_JOB
              const predict = eligible && Flag.MIMOCODE_EXPERIMENTAL_BASH_PREDICT
              const estimate = predict
                ? yield* Effect.promise(() => BashPredict.estimate(projectDir, params.command))
                : undefined
              const predicted =
                predict &&
                (BashPredict.slowCommand(params.command) ||
                  (estimate !== undefined && estimate >= Flag.MIMOCODE_EXPERIMENTAL_BASH_PREDICT_SLOW_MS))
              const backgroundable = eligible && (predicted || (yield* projectCommand(root, cwd, ps, shell)))
              if (backgroundable) return yield* runBackground(input, ctx, BashPredict.graceFor(estimate), estimate)
              return yield* run(input, ctx)
            }),
        }
      })
  }),
)
