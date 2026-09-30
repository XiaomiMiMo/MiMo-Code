import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import z from "zod"
import path from "path"
import os from "os"
import { renameSync, copyFileSync, rmSync, unlinkSync, existsSync } from "fs"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "../flag/flag"
import { Log } from "../util"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "./version"

const log = Log.create({ service: "installation" })

const PACKAGE_NAME = "@mimo-ai/cli"

export type Method = "curl" | "npm" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    z.object({
      version: z.string(),
      method: z.string().optional(),
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    z.object({
      version: z.string(),
      method: z.string().optional(),
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `mimocode/${InstallationChannel}/${InstallationVersion}/${Flag.MIMOCODE_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

// TODO(mimocode): uncomment when corresponding channels are supported
// const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
// const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
// const BrewInfoV2 = Schema.Struct({
//   formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
// })
// const ChocoPackage = Schema.Struct({
//   d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
// })
// const ScoopManifest = NpmPackage

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@mimocode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          return out
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: ChildProcessSpawner.ExitCode(1), stdout: "", stderr: "" })),
      )

      // TODO(mimocode): uncomment when mimocode is published to homebrew
      // const getBrewFormula = Effect.fnUntraced(function* () {
      //   const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
      //   if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
      //   const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
      //   if (coreFormula.includes("opencode")) return "opencode"
      //   return "opencode"
      // })

      const upgradeCurl = Effect.fnUntraced(
        function* (target: string) {
          if (process.platform === "win32") {
            return yield* upgradeCurlWindows(target)
          }
          const response = yield* httpOk.execute(HttpClientRequest.get(process.env.MIMOCODE_INSTALL_SCRIPT_URL ?? "https://mimo.xiaomi.com/install"))
          const body = yield* response.text
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make("bash", [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.orDie,
      )

      const upgradeCurlWindows = Effect.fnUntraced(function* (target: string) {
        const pid = process.pid
        const targetExe = process.execPath
        const stageDir = path.join(os.tmpdir(), `mimocode_upgrade_${pid}`)

        // Download new version to staging dir (reuses install.ps1 logic)
        const installScriptUrl = process.env.MIMOCODE_INSTALL_SCRIPT_URL ?? "https://mimo.xiaomi.com/install.ps1"
        const downloadResult = yield* run(
          ["powershell.exe", "-NoProfile", "-NonInteractive", "-ep", "Bypass", "-c", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; irm $env:INSTALL_SCRIPT_URL | iex"],
          { env: { MIMOCODE_INSTALL_DIR: stageDir, VERSION: target, INSTALL_SCRIPT_URL: installScriptUrl } },
        )
        if (downloadResult.code !== 0) return downloadResult

        // Replace in-place: Windows allows renaming a running exe
        const stagedExe = path.join(stageDir, "mimo.exe")
        if (!existsSync(stagedExe))
          return { code: 1 as ChildProcessSpawner.ExitCode, stdout: "", stderr: "staged binary not found at " + stagedExe }
        const oldExe = targetExe + `.old_${pid}`
        renameSync(targetExe, oldExe)
        try {
          copyFileSync(stagedExe, targetExe)
        } catch (e) {
          renameSync(oldExe, targetExe)
          return { code: 1 as ChildProcessSpawner.ExitCode, stdout: "", stderr: "failed to copy staged binary: " + (e instanceof Error ? e.message : String(e)) }
        }
        rmSync(stageDir, { recursive: true, force: true })
        try { unlinkSync(oldExe) } catch {}

        log.info("upgraded Windows binary in-place", { target, pid, oldExe })
        return { code: 0 as ChildProcessSpawner.ExitCode, stdout: "", stderr: "" }
      })

      const methodImpl = Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".mimocode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          // TODO(mimocode): uncomment when mimocode is published to these channels
          // { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
          // { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
          // { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const output = yield* check.command()
          if (output.includes(PACKAGE_NAME)) {
            return check.name
          }
        }

        return "unknown" as Method
      })

      const latestImpl = Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* methodImpl())

        // TODO(mimocode): uncomment when mimocode is published to homebrew
        // if (detectedMethod === "brew") {
        //   const formula = yield* getBrewFormula()
        //   if (formula.includes("/")) {
        //     const infoJson = yield* text(["brew", "info", "--json=v2", formula])
        //     const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
        //     return info.formulae[0].versions.stable
        //   }
        //   const response = yield* httpOk.execute(
        //     HttpClientRequest.get("https://formulae.brew.sh/api/formula/opencode.json").pipe(
        //       HttpClientRequest.acceptJson,
        //     ),
        //   )
        //   const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
        //   return data.versions.stable
        // }

        if (detectedMethod === "curl") {
          // Resolve the latest version from FDS, matching the source the install
          // script downloads from (fast in mainland China). Override base via
          // MIMO_FDS_BASE to mirror the install script.
          const base = (process.env.MIMO_FDS_BASE || "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode").replace(
            /\/+$/,
            "",
          )
          const version = (yield* text(["curl", "-fsSL", `${base}/releases/latest`])).trim().replace(/^v/, "")
          if (/^\d+\.\d+\.\d+/.test(version)) return version
          return yield* Effect.die(new Error("failed to resolve latest version from FDS"))
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const r = (yield* text(["npm", "config", "get", "registry"])).trim()
          const reg = r || "https://registry.npmjs.org"
          const registry = reg.endsWith("/") ? reg.slice(0, -1) : reg
          const response = yield* httpOk.execute(
            HttpClientRequest.get(`${registry}/${encodeURIComponent(PACKAGE_NAME)}/${InstallationChannel}`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        // TODO(mimocode): uncomment when mimocode is published to chocolatey
        // if (detectedMethod === "choco") {
        //   const response = yield* httpOk.execute(
        //     HttpClientRequest.get(
        //       "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
        //     ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
        //   )
        //   const data = yield* HttpClientResponse.schemaBodyJson(ChocoPackage)(response)
        //   return data.d.results[0].Version
        // }

        // TODO(mimocode): uncomment when mimocode is published to scoop
        // if (detectedMethod === "scoop") {
        //   const response = yield* httpOk.execute(
        //     HttpClientRequest.get(
        //       "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json",
        //     ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json" })),
        //   )
        //   const data = yield* HttpClientResponse.schemaBodyJson(ScoopManifest)(response)
        //   return data.version
        // }

        // TODO(mimocode): uncomment when mimocode has github releases
        // const response = yield* httpOk.execute(
        //   HttpClientRequest.get("https://api.github.com/repos/anomalyco/opencode/releases/latest").pipe(
        //     HttpClientRequest.acceptJson,
        //   ),
        // )
        // const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        // return data.tag_name.replace(/^v/, "")

        log.warn("unsupported update channel, skipping", { method: detectedMethod })
        return yield* Effect.die(new Error(`unsupported update channel: ${detectedMethod}`))
      }, Effect.orDie)

      const upgradeImpl = Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let result: { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            result = yield* upgradeCurl(target)
            break
          case "npm":
            result = yield* run(["npm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "pnpm":
            result = yield* run(["pnpm", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          case "bun":
            result = yield* run(["bun", "install", "-g", `${PACKAGE_NAME}@${target}`])
            break
          // TODO(mimocode): uncomment when mimocode is published to homebrew
          // case "brew": {
          //   const formula = yield* getBrewFormula()
          //   const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
          //   if (formula.includes("/")) {
          //     const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
          //     if (tap.code !== 0) {
          //       result = tap
          //       break
          //     }
          //     const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
          //     const dir = repo.trim()
          //     if (dir) {
          //       const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
          //       if (pull.code !== 0) {
          //         result = pull
          //         break
          //       }
          //     }
          //   }
          //   result = yield* run(["brew", "upgrade", formula], { env })
          //   break
          // }
          // TODO(mimocode): uncomment when mimocode is published to chocolatey
          // case "choco":
          //   result = yield* run(["choco", "upgrade", "opencode", `--version=${target}`, "-y"])
          //   break
          // TODO(mimocode): uncomment when mimocode is published to scoop
          // case "scoop":
          //   result = yield* run(["scoop", "install", `opencode@${target}`])
          //   break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
        }
        if (!result || result.code !== 0) {
          // TODO(mimocode): restore choco-specific error when choco channel is supported
          // const stderr = m === "choco" ? "not running from an elevated command shell" : result?.stderr || ""
          const stderr = result?.stderr || ""
          return yield* new UpgradeFailedError({ stderr })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: result.stdout,
          stderr: result.stderr,
        })
        yield* text([process.execPath, "--version"])
      })

      return Service.of({
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* latestImpl(),
          }
        }),
        method: methodImpl,
        latest: latestImpl,
        upgrade: upgradeImpl,
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

export * as Installation from "."
