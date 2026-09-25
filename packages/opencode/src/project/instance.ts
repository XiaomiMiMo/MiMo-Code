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

export class InstanceBusyError extends Error {
  constructor(directory: string) {
    super(`Instance busy: ${directory}`)
    this.name = "InstanceBusyError"
  }
}

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()
const gates = new Map<string, { requests: number; executions: number; pending: boolean; closing?: Promise<void>; failed?: boolean; requested: number; applied: number }>()
let revision = 0
const project = makeRuntime(Project.Service, Project.defaultLayer)
const DIRECTORY_DISPOSE_TIMEOUT = 2_000

function gate(directory: string) {
  let value = gates.get(directory)
  if (!value) {
    value = { requests: 0, executions: 0, pending: false, requested: revision, applied: revision }
    gates.set(directory, value)
  }
  return value
}

function schedule(directory: string) {
  const state = gate(directory)
  if (!state.pending || state.closing || state.requests || state.executions) return state.closing
  state.pending = false
  const current = cache.get(directory)
  if (!current) {
    state.applied = state.requested
    return
  }
  const generation = state.requested
  const closing = disposeCached(directory, current)
  state.closing = closing
  void closing.then(
    () => {
      state.applied = generation
      state.closing = undefined
      schedule(directory)
    },
    (error) => {
      Log.Default.warn("instance dispose failed", { directory, error })
      state.pending = true
      state.failed = true
    },
  )
  return closing
}

function requestDispose(directory: string, generation = ++revision) {
  const state = gate(directory)
  if (state.failed) {
    state.closing = undefined
    state.failed = false
  }
  state.requested = generation
  state.pending = true
  return schedule(directory)
}

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

function enter(directory: string) {
  gate(directory).requests++
}

function leave(directory: string) {
  gate(directory).requests--
  schedule(directory)
}

async function disposeCached(directory: string, current: Promise<InstanceContext>) {
  const ctx = await current.catch(() => undefined)
  if (!ctx || cache.get(directory) !== current) return

  Log.Default.info("disposing instance", { directory })
  const uh = await import("@/session/prompt/uncommitted-hint").catch(() => undefined)
  const finishHintDispose = uh?.beginHintStateDisposeForDirectory(directory)
  try {
    await context.provide(ctx, () => disposeInstance(directory))
  } finally {
    finishHintDispose?.()
  }
  if (cache.get(directory) === current) cache.delete(directory)

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
    for (;;) {
      if (gate(directory).failed) throw new InstanceBusyError(directory)
      const closing = gate(directory).closing
      if (closing) {
        await closing
        continue
      }
      enter(directory)
      break
    }
    try {
      let existing = cache.get(directory)
      if (!existing) {
        Log.Default.info("creating instance", { directory })
        existing = track(directory, boot({ directory, init: input.init }))
      }
      const ctx = await existing
      return await context.provide(ctx, async () => input.fn())
    } finally {
      leave(directory)
    }
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
  claim(input: string) {
    const directory = AppFileSystem.resolve(input)
    const state = gate(directory)
    if (state.closing) throw new InstanceBusyError(directory)
    state.executions++
    let released = false
    return () => {
      if (released) return
      released = true
      state.executions--
      schedule(directory)
    }
  },
  refreshStatus(input?: string) {
    if (!input) {
      const states = [...gates.values()]
      const pending = states.some((state) => state.pending || state.closing || state.applied < state.requested)
      return {
        state: pending ? "pending" as const : "applied" as const,
        requested: revision,
        applied: pending ? Math.min(...states.map((state) => state.applied)) : revision,
      }
    }
    const state = gate(AppFileSystem.resolve(input))
    return {
      state: state.pending || state.closing || state.applied < state.requested ? "pending" as const : "applied" as const,
      requested: state.requested,
      applied: state.applied,
    }
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
    assertSafeDirectory(directory)
    const state = gate(directory)
    const ownRequest = (() => {
      try {
        return Instance.directory === directory ? 1 : 0
      } catch (error) {
        if (!(error instanceof LocalContext.NotFound)) throw error
        return 0
      }
    })()
    if (state.executions || state.closing || state.pending || state.requests > ownRequest) throw new InstanceBusyError(directory)
    const generation = state.requested
    const current = cache.get(directory)
    const closing = current ? disposeCached(directory, current) : Promise.resolve()
    state.closing = closing
    try {
      await closing
      const next = track(directory, boot({ ...input, directory }))
      const ctx = await next
      state.applied = generation
      return ctx
    } catch (error) {
      state.pending = true
      state.failed = true
      throw error
    } finally {
      if (!state.failed) state.closing = undefined
      schedule(directory)
    }
  },
  async disposeDirectory(input: string) {
    const directory = AppFileSystem.resolve(input)
    assertSafeDirectory(directory)
    const closing = requestDispose(directory)
    if (!closing) return
    await withTimeout(closing, DIRECTORY_DISPOSE_TIMEOUT).catch((error) => {
      Log.Default.warn("instance dispose still running", { directory, error })
    })
  },
  async dispose() {
    await Instance.disposeDirectory(Instance.directory)
  },
  async disposeAll() {
    const generation = ++revision
    const directories = new Set([...cache.keys(), ...gates.keys()])
    const closings = [...directories].map((directory) => requestDispose(directory, generation)).filter((value): value is Promise<void> => !!value)
    await Promise.all(closings.map((closing) =>
      withTimeout(closing, DIRECTORY_DISPOSE_TIMEOUT).catch((error) => {
        Log.Default.warn("instance dispose still running", { error })
      }),
    ))
  },
}
