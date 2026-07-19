import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { Log } from "@/util"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util"
import type { GlobalEvent } from "@mimo-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import { MIMOCODE_PROCESS_ROLE, MIMOCODE_RUN_ID, ensureRunID, sanitizedProcessEnv } from "@/util/mimo-process"
import { checkTrust, markTrusted } from "@/project/workspace-trust"
import { t } from "@/cli/i18n"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

async function promptWorkspaceTrust(directory: string, level: "untrusted" | "dangerous"): Promise<boolean> {
  const prompts = await import("@clack/prompts")
  const { EOL } = await import("os")

  if (level === "dangerous") {
    const isRoot = path.parse(directory).root === directory
    const title = t(isRoot ? "trust.dangerous.title_root" : "trust.dangerous.title_home")
    const body = t(isRoot ? "trust.dangerous.body_root" : "trust.dangerous.body_home")
    const advice = t(isRoot ? "trust.dangerous.advice_root" : "trust.dangerous.advice_home")
    prompts.log.warning(
      [
        UI.Style.TEXT_WARNING_BOLD + title + UI.Style.TEXT_NORMAL,
        "",
        directory,
        "",
        body,
        "",
        UI.Style.TEXT_DANGER + t("trust.plugin_warn") + UI.Style.TEXT_NORMAL,
        "",
        advice,
      ].join(EOL),
    )
    const result = await prompts.select({
      message: "",
      options: [
        { label: t("trust.dangerous.option.no"), value: false },
        { label: t("trust.dangerous.option.yes"), value: true },
      ],
    })
    if (prompts.isCancel(result)) return false
    return result
  }

  prompts.log.info(
    [
      UI.Style.TEXT_HIGHLIGHT_BOLD + t("trust.title") + UI.Style.TEXT_NORMAL,
      "",
      directory,
      "",
      t("trust.safety_check"),
      "",
      t("trust.capabilities"),
      "",
      UI.Style.TEXT_DANGER + t("trust.plugin_warn") + UI.Style.TEXT_NORMAL,
    ].join(EOL),
  )
  const result = await prompts.select({
    message: "",
    options: [
      { label: t("trust.option.yes"), value: true },
      { label: t("trust.option.no"), value: false },
    ],
  })
  if (prompts.isCancel(result)) return false
  return result
}

// Startup gate for --dangerously-skip-permissions. Mirrors Claude Code's
// bypass-permissions warning: an explicit, red-highlighted accept is required
// before every permission check is auto-approved. Returns false to abort.
async function promptDangerousPermissions(): Promise<boolean> {
  const prompts = await import("@clack/prompts")
  const { EOL } = await import("os")

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0

  prompts.log.warning(
    [
      UI.Style.TEXT_DANGER + t("skip_permissions.title") + UI.Style.TEXT_NORMAL,
      "",
      t("skip_permissions.body"),
      "",
      UI.Style.TEXT_DANGER + t("skip_permissions.plugin_warn") + UI.Style.TEXT_NORMAL,
      ...(asRoot ? ["", UI.Style.TEXT_DANGER + t("skip_permissions.root_warn") + UI.Style.TEXT_NORMAL] : []),
    ].join(EOL),
  )
  const result = await prompts.select({
    message: "",
    options: [
      { label: t("skip_permissions.option.no"), value: false },
      { label: t("skip_permissions.option.yes"), value: true },
    ],
  })
  if (prompts.isCancel(result)) return false
  return result
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start mimocode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start mimocode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("never-ask", {
        type: "boolean",
        describe:
          "start in never-ask mode — auto-decide without asking (permissions excluded), toggle at runtime with /never-ask",
        default: false,
      })
      .option("trust", {
        type: "boolean",
        describe: "skip workspace trust prompt and trust the directory",
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const next = args.project
        ? Filesystem.resolve(path.isAbsolute(args.project) ? args.project : path.join(root, args.project))
        : Filesystem.resolve(process.cwd())
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      if (!args.trust) {
        const trustLevel = await checkTrust(cwd)
        if (trustLevel !== "trusted") {
          const accepted = await promptWorkspaceTrust(cwd, trustLevel)
          if (!accepted) {
            process.exit(0)
            return
          }
          if (trustLevel === "untrusted") await markTrusted(cwd)
        }
      }

      if (args["dangerously-skip-permissions"]) {
        // Require an explicit accept when interactive; skip the gate with no TTY
        // (CI / piped stdin) so automation still works.
        if (process.stdin.isTTY) {
          const accepted = await promptDangerousPermissions()
          if (!accepted) {
            process.exit(0)
            return
          }
        }
        // Propagate to the worker (which loads config) via the env it inherits
        // from sanitizedProcessEnv. Config injects an allow-all base under the
        // user's permission rules so denies still win.
        process.env.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS = "1"
      }

      const env = sanitizedProcessEnv({
        [MIMOCODE_PROCESS_ROLE]: "worker",
        [MIMOCODE_RUN_ID]: ensureRunID(),
      })

      const worker = new Worker(file, {
        env,
      })
      worker.onerror = (e) => {
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      const client = Rpc.client<typeof rpc>(worker)
      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      const network = resolveNetworkOptionsNoConfig(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      const transport = external
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
          }
        : {
            url: "http://opencode.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      try {
        await tui({
          url: transport.url,
          async onSnapshot() {
            const tui = writeHeapSnapshot("tui.heapsnapshot")
            const server = await client.call("snapshot", undefined)
            return [tui, server]
          },
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            fork: args.fork,
            neverAsk: args["never-ask"],
          },
        })
      } finally {
        await stop()
      }
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})
// scratch
