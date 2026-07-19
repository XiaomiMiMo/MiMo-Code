import path from "path"
import { Effect } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { Global } from "@/global"
import type * as Tool from "./tool"
import { Instance } from "../project/instance"
import { ProjectID } from "../project/schema"
import { assertMemoryWriteAllowed } from "./memory-path-guard"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  if (options?.bypass) return

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (Instance.containsPath(full, ins)) return

  // Memory tree has its own finer authority (memory-path-guard), which the write
  // tools invoke right after this call. Defer to it: asking external_directory here
  // is redundant and, in headless run mode (no permission replier), deadlocks on a
  // never-resolved Deferred. memory-path-guard allows a task-bound subagent its own
  // tasks/<taskId>/*.md and rejects cross-task / wrong-agent writes.
  if (AppFileSystem.contains(path.join(Global.Path.data, "memory"), full)) return

  // Orchestrator-created worktrees live under <data>/worktree/<projectID>/<name>.
  // They are TRUSTED, app-managed workspaces — a child session isolated into one is
  // meant to work there freely. But a child's Instance boundary (directory/worktree)
  // does not always contain the worktree path: an isolated peer whose worktree boot
  // fails falls back to the shared/parent context, and a subagent inherits the
  // spawner's (main-checkout) context. In those cases every in-worktree write hits
  // external_directory:ask, and a background/isolated child has no interactive
  // replier — so the ask hangs on a never-resolved Deferred and the child deadlocks.
  // Since this base is created and owned by the app itself (not a foreign user path),
  // trust it here, exactly as the memory subtree above. Genuinely external user paths
  // are unaffected and still prompt.
  if (AppFileSystem.contains(path.join(Global.Path.data, "worktree"), full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}

/**
 * The single write-permission gate for file-mutating tools (edit, write,
 * apply_patch). Runs the two checks every write must pass, in order:
 *   1. external_directory — asks before touching paths outside the worktree
 *      (defers the memory subtree to the memory guard; see the early return above).
 *   2. memory-path-guard — finer authority over the memory tree: a task-bound
 *      subagent may write its own tasks/<taskId>/*.md, the checkpoint-writer its
 *      canonical paths, and everything else is rejected.
 *
 * Collapsing both into one call removes the per-tool duplication and, more
 * importantly, makes "call external_directory but forget the memory guard"
 * unrepresentable — a new write tool that calls this one gate cannot drift into
 * leaving the memory tree unguarded. Read-only tools (read/grep/glob/lsp) keep
 * calling assertExternalDirectoryEffect directly; the memory guard is write-only.
 */
export const assertWriteAllowed = Effect.fn("Tool.assertWriteAllowed")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  yield* assertExternalDirectoryEffect(ctx, target, options)
  if (!target) return

  // Instance.current is a getter that THROWS when no instance is ALS-bound
  // (detached fibers, tests without a project fixture). The optional chain runs
  // only after the getter returns, so it cannot save us — the try/catch is
  // load-bearing, not defensive dead code. Fall back to ProjectID.global so the
  // guard can still resolve a canonical memory path. Mirrors session/checkpoint.ts.
  const projectID = (() => {
    try {
      return (Instance.current?.project?.id as ProjectID | undefined) ?? ProjectID.global
    } catch {
      return ProjectID.global
    }
  })()

  assertMemoryWriteAllowed({
    target,
    agentName: ctx.agent,
    memoryRoot: path.join(Global.Path.data, "memory"),
    projectID,
    sessionID: ctx.sessionID,
    taskId: ctx.taskId,
  })
})

/**
 * Perform the per-write `edit` permission ask, EXCEPT for targets under
 * <data>/memory/. The memory tree's authority is memory-path-guard (invoked by
 * assertWriteAllowed, which every write tool calls first): it already allows the
 * checkpoint-writer / task-bound subagent their canonical paths and rejects
 * everything else. Asking `edit` there is redundant and — for a background fork
 * inheriting a parent's `edit:ask`/`deny` — would deny/skip the checkpoint write.
 * Outside the memory tree, ask exactly as the write tools did inline before.
 *
 * Mirrors the external_directory memory-region deferral added in the 2026-06-04
 * poststop-progress-permission-deadlock fix (see assertExternalDirectoryEffect).
 */
export const askEditUnlessMemory = Effect.fn("Tool.askEditUnlessMemory")(function* (
  ctx: Tool.Context,
  filepath: string,
  input: { patterns: string[]; diff: string; files?: unknown },
) {
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(filepath) : filepath
  if (AppFileSystem.contains(path.join(Global.Path.data, "memory"), full)) return
  yield* ctx.ask({
    permission: "edit",
    patterns: input.patterns,
    always: ["*"],
    metadata: { filepath, diff: input.diff, ...(input.files !== undefined ? { files: input.files } : {}) },
  })
})
