import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdaptor as PluginWorkspaceAdaptor,
  ActorPreStopInput,
  ActorPostStopInput,
  ActorStopOutput,
  ActorMatcher,
} from "@mimo-ai/plugin"
import { z } from "zod"
import { matchesActor } from "./matcher"
import { Config } from "../config"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { Log } from "../util"
import { createOpencodeClient } from "@mimo-ai/sdk"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { MimoAuthPlugin, AnthropicProxyPlugin } from "./mimo"
import { Session } from "../session"
import type { SessionID } from "../session/schema"
import { NamedError } from "@mimo-ai/shared/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { CheckpointSplitoverPlugin } from "./checkpoint-splitover"
import { SubagentProgressCheckerPlugin } from "./subagent-progress-checker"
import { Effect, Layer, Context, Stream } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdaptor } from "@/control-plane/adaptors"
import type { WorkspaceAdaptor } from "@/control-plane/types"
import { Glob } from "@mimo-ai/shared/util/glob"
import fs from "fs"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"

const log = Log.create({ service: "plugin" })

export const HookEvent = {
  Executed: BusEvent.define(
    "hook.executed",
    z.object({
      event: z.enum(["actor.preStop", "actor.postStop"]),
      hookID: z.string(),
      pluginName: z.string(),
      actorID: z.string(),
      agentType: z.string(),
      durationMs: z.number(),
      outcome: z.enum(["success", "error", "skipped"]),
      continueRequested: z.boolean(),
      reasonLength: z.number(),
    }),
  ),
  ReActReentered: BusEvent.define(
    "hook.react.reentered",
    z.object({
      phase: z.enum(["pre", "post"]),
      actorID: z.string(),
      agentType: z.string(),
      iteration: z.number(),
      triggeredByPlugins: z.array(z.string()),
      reasonPreview: z.string(),
    }),
  ),
  ReActMaxReached: BusEvent.define(
    "hook.react.max_reached",
    z.object({
      phase: z.enum(["pre", "post"]),
      actorID: z.string(),
      agentType: z.string(),
    }),
  ),
} as const

type HookEntry = {
  hook: Hooks
  pluginName: string
  /** Stable per-event hook ID: `${pluginName}#${eventName}` */
  hookIDFor: (eventName: string) => string
}

type State = {
  hooks: Hooks[]
  hooksWithMeta: HookEntry[]
}

export type ActorStopAggregatedDecision = ActorStopOutput & {
  contributingPluginNames: string[]
  contributingHookIDs: string[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
  readonly reloadFileHooks: () => Effect.Effect<void>
  readonly triggerActorPreStop: (
    input: ActorPreStopInput,
  ) => Effect.Effect<ActorStopAggregatedDecision>
  readonly triggerActorPostStop: (
    input: ActorPostStopInput,
  ) => Effect.Effect<ActorStopAggregatedDecision>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

// Built-in plugins that are directly imported (not installed from npm)
const INTERNAL_PLUGINS: PluginInstance[] = [
  MimoAuthPlugin,
  AnthropicProxyPlugin,
  CodexAuthPlugin,
  CopilotAuthPlugin,
  // gitlab/poe auth are external npm packages typed against the published
  // upstream plugin package, which carries a duplicate (nominal) copy of the
  // SDK client; cast through unknown to the workspace Plugin type.
  GitlabAuthPlugin as unknown as PluginInstance,
  PoeAuthPlugin as unknown as PluginInstance,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  CheckpointSplitoverPlugin,
  SubagentProgressCheckerPlugin,
]

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(
  load: PluginLoader.Loaded,
  input: PluginInput,
  hooks: Hooks[],
  hooksWithMeta: HookEntry[],
) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    const pluginName = readPluginId(plugin.id, load.spec) ?? load.pkg?.pkg ?? load.spec
    const hookObj = await (plugin as PluginModule).server(input, load.options)
    hooks.push(hookObj)
    hooksWithMeta.push({
      hook: hookObj,
      pluginName,
      hookIDFor: (event: string) => `${pluginName}#${event}`,
    })
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    const fnName = (server as { name?: string }).name
    const pluginName = fnName && fnName !== "default" && fnName !== ""
      ? fnName
      : (load.pkg?.pkg ?? load.spec)
    const hookObj = await server(input, load.options)
    hooks.push(hookObj)
    hooksWithMeta.push({
      hook: hookObj,
      pluginName,
      hookIDFor: (event: string) => `${pluginName}#${event}`,
    })
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const hooksWithMeta: HookEntry[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const client = createOpencodeClient({
          baseUrl: "http://localhost:4096",
          directory: ctx.directory,
          headers: Flag.MIMOCODE_SERVER_PASSWORD
            ? {
                Authorization: `Basic ${Buffer.from(`${Flag.MIMOCODE_SERVER_USERNAME ?? "mimocode"}:${Flag.MIMOCODE_SERVER_PASSWORD}`).toString("base64")}`,
              }
            : undefined,
          fetch: async (...args) => (await Server.Default()).app.fetch(...args),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adaptor: PluginWorkspaceAdaptor) {
              registerAdaptor(ctx.project.id, type, adaptor as WorkspaceAdaptor)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of INTERNAL_PLUGINS) {
          log.info("loading internal plugin", { name: plugin.name })
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: (err) => {
              log.error("failed to load internal plugin", { name: plugin.name, error: err })
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            hooks.push(init.value)
            hooksWithMeta.push({
              hook: init.value,
              pluginName: plugin.name,
              hookIDFor: (event: string) => `${plugin.name}#${event}`,
            })
          }
        }

        // Private, internal-only plugins live in src/private/ (e.g. the free
        // "mimo-auto" channel). That directory is NOT part of the open-source
        // tree; it is injected at build time only when the internal repo is
        // present. Auto-detected at runtime: present → loaded; absent
        // (open-source build) → skipped. Never referenced statically, so the
        // open-source build compiles and runs without it.
        const privateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "private")
        const privateFiles = fs.existsSync(privateDir)
          ? fs.readdirSync(privateDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
          : []
        for (const entry of privateFiles) {
          const file = path.join(privateDir, entry)
          const name = entry.replace(/\.ts$/, "")
          const mod = yield* Effect.tryPromise({
            try: () => import(/* @vite-ignore */ pathToFileURL(file).href),
            catch: (err) => log.error("failed to import private plugin", { name, error: err }),
          }).pipe(Effect.option)
          if (mod._tag !== "Some") continue
          // Only treat *Plugin-named function exports as plugins. Other private
          // modules (e.g. free-login.ts exporting a CLI helper) are not plugins
          // and must not be invoked as plugin factories.
          const overlay = Object.entries(mod.value as Record<string, unknown>).find(
            ([exportName, v]) => typeof v === "function" && exportName.endsWith("Plugin"),
          )?.[1] as PluginInstance | undefined
          if (!overlay) continue
          log.info("loading private plugin", { name })
          const init = yield* Effect.tryPromise({
            try: () => overlay(input),
            catch: (err) => log.error("failed to load private plugin", { name, error: err }),
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            hooks.push(init.value)
            hooksWithMeta.push({
              hook: init.value,
              pluginName: name,
              hookIDFor: (event: string) => `${name}#${event}`,
            })
          }
        }

        const plugins = Flag.MIMOCODE_PURE ? [] : (cfg.plugin_origins ?? [])
        if (Flag.MIMOCODE_PURE && cfg.plugin_origins?.length) {
          log.info("skipping external plugins in pure mode", { count: cfg.plugin_origins.length })
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {
                log.info("loading plugin", { path: candidate.plan.spec })
              },
              missing(candidate, _retry, message) {
                log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  log.warn("plugin incompatible", { path: spec, error: message })
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  log.error("failed to resolve plugin server entry", { path: spec, error: message })
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks, hooksWithMeta),
            catch: (err) => {
              const message = errorMessage(err)
              log.error("failed to load plugin", { path: load.spec, error: message })
              return message
            },
          }).pipe(
            Effect.catch(() => {
              // TODO: make proper events for this
              // bus.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: (err) => {
              log.error("plugin config hook failed", { error: err })
            },
          }).pipe(Effect.ignore)
        }

        // Subscribe to bus events, fiber interrupted when scope closes
        yield* bus.subscribeAll().pipe(
          Stream.runForEach((input) =>
            Effect.sync(() => {
              for (const hook of hooks) {
                void hook["event"]?.({ event: input as any })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return { hooks, hooksWithMeta }
      }),
    )

    const fileHookState = yield* InstanceState.make<{ hooks: Hooks[]; meta: HookEntry[] }>(
      Effect.fn("Plugin.fileHooks")(function* () {
        const hooks: Hooks[] = []
        const meta: HookEntry[] = []
        const cfg = yield* config.get()
        const dirs = yield* config.directories()

        for (const dir of dirs) {
          const matches = Glob.scanSync("{hook,hooks}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true })
          for (const match of matches) {
            const mod = yield* Effect.tryPromise({
              try: () => import(`${pathToFileURL(match).href}?v=${Date.now()}`),
              catch: (err) => err,
            }).pipe(Effect.catch((err) => {
              log.error("failed to load file hook", { path: match, error: errorMessage(err) })
              return Effect.succeed(undefined)
            }))
            if (!mod) continue
            const hookObj: Hooks = mod.default ?? mod
            if (hookObj && typeof hookObj === "object") {
              const name = path.basename(match, path.extname(match))
              hooks.push(hookObj)
              meta.push({ hook: hookObj, pluginName: `file:${name}`, hookIDFor: (event: string) => `file:${name}#${event}` })
              log.info("loaded file hook", { path: match, name })
            }
          }
        }

        return { hooks, meta }
      }),
    )

    const aggregateDecision = (
      input: ActorPreStopInput | ActorPostStopInput,
      eventName: "actor.preStop" | "actor.postStop",
    ) =>
      Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const fh = yield* InstanceState.get(fileHookState)
        const reasons: string[] = []
        const pluginNames: string[] = []
        const hookIDs: string[] = []
        let anyContinue = false

        for (const entry of [...s.hooksWithMeta, ...fh.meta]) {
          const reg = entry.hook[eventName]
          if (!reg) continue

          const fn = typeof reg === "function" ? reg : reg.run
          const matcher: ActorMatcher | undefined =
            typeof reg === "function" ? undefined : reg.matcher

          if (!matchesActor(matcher, input)) {
            yield* bus.publish(HookEvent.Executed, {
              event: eventName,
              hookID: entry.hookIDFor(eventName),
              pluginName: entry.pluginName,
              actorID: input.actorID,
              agentType: input.agentType,
              durationMs: 0,
              outcome: "skipped",
              continueRequested: false,
              reasonLength: 0,
            })
            continue
          }

          const startedAt = Date.now()
          const o: ActorStopOutput = { continue: false }
          let hookOutcome: "success" | "error" = "success"
          // TODO: pass an AbortSignal to fn so plugin authors can wire cooperative
          // cancellation into their fetch / DB calls. Effect interrupt only stops
          // the awaiting fiber — the underlying Promise keeps running and may
          // bus.publish events after the actor has been cleaned up. See spec
          // Future work for full discussion. Strict in-process cancellation
          // (子进程隔离) is out of scope; AbortSignal is the in-process ceiling.
          yield* Effect.tryPromise({
            try: () => fn(input as never, o),
            catch: (err) => err,
          }).pipe(
            Effect.tapError((err) =>
              Effect.gen(function* () {
                hookOutcome = "error"
                log.error(`${eventName} hook failed`, { pluginName: entry.pluginName, hookID: entry.hookIDFor(eventName), error: err })
                yield* bus.publish(Session.Event.Error, {
                  sessionID: input.sessionID as SessionID,
                  error: new NamedError.Unknown({
                    message: `${eventName} hook (${entry.pluginName}) failed: ${errorMessage(err)}`,
                  }).toObject(),
                })
              }),
            ),
            Effect.ignore,
          )

          const durationMs = Date.now() - startedAt
          yield* bus.publish(HookEvent.Executed, {
            event: eventName,
            hookID: entry.hookIDFor(eventName),
            pluginName: entry.pluginName,
            actorID: input.actorID,
            agentType: input.agentType,
            durationMs,
            outcome: hookOutcome,
            continueRequested: o.continue === true,
            reasonLength: o.reason?.length ?? 0,
          })

          if (o.continue === true && o.reason && o.reason.length > 0) {
            anyContinue = true
            reasons.push(o.reason)
            pluginNames.push(entry.pluginName)
            hookIDs.push(entry.hookIDFor(eventName))
          } else if (o.continue === true) {
            log.warn(`${eventName} hook returned continue=true without reason; ignored`, {
              pluginName: entry.pluginName,
            })
          }
        }

        const aggregated: ActorStopAggregatedDecision = {
          continue: anyContinue,
          reason: reasons.length > 0 ? reasons.join("\n\n") : undefined,
          contributingPluginNames: pluginNames,
          contributingHookIDs: hookIDs,
        }
        return aggregated
      })

    const triggerActorPreStop = Effect.fn("Plugin.triggerActorPreStop")(function* (
      input: ActorPreStopInput,
    ) {
      return yield* aggregateDecision(input, "actor.preStop")
    })

    const triggerActorPostStop = Effect.fn("Plugin.triggerActorPostStop")(function* (
      input: ActorPostStopInput,
    ) {
      return yield* aggregateDecision(input, "actor.postStop")
    })

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      const fh = yield* InstanceState.get(fileHookState)
      for (const hook of [...s.hooks, ...fh.hooks]) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
      yield* InstanceState.get(fileHookState)
    })

    const reloadFileHooks: Interface["reloadFileHooks"] = Effect.fn("Plugin.reloadFileHooks")(function* () {
      yield* InstanceState.invalidate(fileHookState)
    })

    return Service.of({ trigger, list, init, reloadFileHooks, triggerActorPreStop, triggerActorPostStop })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as Plugin from "."
