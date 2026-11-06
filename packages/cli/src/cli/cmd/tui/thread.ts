import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import path from "path"
import { UI } from "@/cli/ui"
import * as Daemon from "@/server/daemon"
import { Filesystem } from "@/util"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "./config/tui"
import { checkTrust, markTrusted } from "@/project/workspace-trust"
import { t } from "@/cli/i18n"

declare global {
  const MIMOCODE_WORKER_PATH: string
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
    yargs
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
        alias: ["yolo"],
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
            return
          }
        }
        // Propagate to the worker (which loads config) via the env it inherits
        // from sanitizedProcessEnv. Config injects an allow-all base under the
        // user's permission rules so denies still win.
        process.env.MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS = "1"
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()
      const service = await Daemon.ensure(cwd)
      await tui({
        url: service.url,
        headers: Daemon.headers(service),
        config,
        directory: cwd,
        args: {
          continue: args.continue,
          sessionID: args.session,
          agent: args.agent,
          model: args.model,
          prompt,
          fork: args.fork,
          neverAsk: args["never-ask"],
          taskCenter: !args.session && !args.continue && !args.agent && !args.fork,
        },
      })
    } finally {
      unguard?.()
    }
  },
})
