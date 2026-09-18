import { Cause, Effect, Layer, Context } from "effect"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir } from "fs/promises"
import path from "path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { WatcherSubscriptions } from "./watcher-subscriptions"
import { Instance } from "@/project/instance"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { lazy } from "@/util/lazy"
import { Config } from "../config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "../util"

declare const OPENCODE_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    z.object({
      file: z.string(),
      event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service
    const subscriptions = new WatcherSubscriptions((...args) => watcher()!.subscribe(...args))

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* (ctx) {
          if (yield* Flag.MIMOCODE_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          log.info("init", { directory: ctx.directory })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })

          const workspaceID = yield* InstanceState.workspaceID
          const cb: ParcelWatcher.SubscribeCallback = (err, evts) => {
            if (err) return undefined
            return WorkspaceContext.provide({
              workspaceID,
              fn: () =>
                Instance.restore(ctx, () => {
                  for (const evt of evts) {
                    if (evt.type === "create") void Bus.publish(Event.Updated, { file: evt.path, event: "add" })
                    if (evt.type === "update") void Bus.publish(Event.Updated, { file: evt.path, event: "change" })
                    if (evt.type === "delete") void Bus.publish(Event.Updated, { file: evt.path, event: "unlink" })
                  }
                }),
            })
          }

          const subscribe = (dir: string, ignore: string[]) => subscriptions.watch(dir, ignore, backend, cb)

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []

          if (yield* Flag.MIMOCODE_EXPERIMENTAL_FILEWATCHER) {
            yield* subscribe(ctx.directory, [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(ctx.directory)])
          }

          if (ctx.project.vcs === "git") {
            const result = yield* git.run(["rev-parse", "--git-dir"], {
              cwd: ctx.worktree,
            })
            const vcsDir = result.exitCode === 0 ? path.resolve(ctx.worktree, result.text().trim()) : undefined
            if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
              const ignore = (yield* Effect.promise(() => readdir(vcsDir).catch(() => []))).filter(
                (entry) => entry !== "HEAD",
              )
              yield* subscribe(vcsDir, ignore)
            }
          }
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))

export * as FileWatcher from "./watcher"
