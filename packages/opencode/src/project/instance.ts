import { GlobalBus } from "@/bus/global"
import { disposeInstance } from "@/effect/instance-registry"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@/util"
import { withTimeout } from "@/util/timeout"
import { LocalContext } from "../util"
import * as Project from "./project"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { parse as pathParse } from "path"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()
const directoryDisposals = new Map<string, Promise<void>>()
const project = makeRuntime(Project.Service, Project.defaultLayer)
const DIRECTORY_DISPOSE_TIMEOUT = 2_000

const FORBIDDEN_PREFIXES = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/private/etc",
] as const

function assertSafeDirectory(directory: string): void {
  const resolved = AppFileSystem.resolve(directory)
  if (resolved === pathParse(resolved).root) {
    throw new Error("Access denied: filesystem root is not a valid project directory")
  }
  if (process.platform !== "win32") {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(`${prefix}/`)) {
        throw new Error("Access denied: target is a protected system directory")
      }
    }
  }
}

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function boot(input: { directory: string; init?: () => Promise<any>; worktree?: string; project?: Project.Info }) {
  return iife(async () => {
    const ctx =
      input.project && input.worktree
        ? {
            directory: input.directory,
            worktree: input.worktree,
            project: input.project,
          }
        : await project
            .runPromise((svc) => svc.fromDirectory(input.directory))
            .then(({ project, sandbox }) => ({
              directory: input.directory,
              worktree: sandbox,
              project,
            }))
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(directory: string, next: Promise<InstanceContext>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

async function disposeCached(directory: string, current: Promise<InstanceContext>) {
  const ctx = await current.catch(() => undefined)
  if (!ctx || cache.get(directory) !== current) return

  cache.delete(directory)
  Log.Default.info("disposing instance", { directory })
  await context.provide(ctx, () => disposeInstance(directory))

  GlobalBus.emit("event", {
    directory,
    project: ctx.project.id,
    workspace: WorkspaceContext.workspaceID,
    payload: {
      type: "server.instance.disposed",
      properties: {
        directory,
      },
    },
  })
}

export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    const directory = AppFileSystem.resolve(input.directory)
    assertSafeDirectory(directory)
    await directoryDisposals.get(directory)
    let existing = cache.get(directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
        }),
      )
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },

  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string, ctx?: InstanceContext) {
    const instance = ctx ?? Instance
    if (AppFileSystem.contains(instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (instance.worktree === "/") return false
    return AppFileSystem.contains(instance.worktree, filepath)
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  /**
   * Run a synchronous function within the given instance context ALS.
   * Use this to bridge from Effect (where InstanceRef carries context)
   * back to sync code that reads Instance.directory from ALS.
   */
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = AppFileSystem.resolve(input.directory)
    await directoryDisposals.get(directory)
    Log.Default.info("reloading instance", { directory })
    await disposeInstance(directory)
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory }))

    GlobalBus.emit("event", {
      directory,
      project: input.project?.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })

    return await next
  },
  async disposeDirectory(input: string) {
    const directory = AppFileSystem.resolve(input)
    assertSafeDirectory(directory)
    const pending = directoryDisposals.get(directory)
    if (pending) return pending
    const current = cache.get(directory)
    if (!current) return

    // NOTE: withTimeout only bounds the *wait*, not the underlying promise —
    // a slow disposer may still complete after the timeout fires.  The
    // directoryDisposals guard above is a soft happens-before (bounded by
    // DIRECTORY_DISPOSE_TIMEOUT), not a true barrier.  If a disposer times
    // out and the same directory is re-provided immediately, the background
    // disposer can still race with the new instance and tear down
    // per-directory state (e.g. session-cwd entries) once it finally finishes.
    const cleanup = withTimeout(disposeCached(directory, current), DIRECTORY_DISPOSE_TIMEOUT).catch((error) => {
      Log.Default.warn("instance dispose did not complete", { directory, error })
    })
    directoryDisposals.set(directory, cleanup)
    try {
      await cleanup
    } finally {
      if (directoryDisposals.get(directory) === cleanup) directoryDisposals.delete(directory)
    }
  },
  async dispose() {
    const directory = Instance.directory
    const project = Instance.project
    Log.Default.info("disposing instance", { directory })
    await disposeInstance(directory)
    cache.delete(directory)

    GlobalBus.emit("event", {
      directory,
      project: project.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
