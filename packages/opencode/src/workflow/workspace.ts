import path from "path"
import { Filesystem } from "@/util"
import { Glob } from "@mimo-ai/shared/util/glob"

// Resolve a guest-supplied relative path against the workspace root, refusing
// any path that escapes the root by LEXICAL means (parent traversal `..`, or an
// escaping-absolute path). The jail is the sandbox boundary for the orchestrator
// script's own file IO — distinct from the file-tool boundary of the agents it
// spawns (which have the same lexical posture, so this grants no new reach).
//
// LIMITATION (by design, experimental): the check is NAME-based, not realpath —
// `Filesystem.contains` is purely lexical and does NOT resolve symlinks. A
// pre-existing symlink INSIDE the workspace that points OUTSIDE it (e.g. a pnpm
// store link under node_modules) is therefore NOT caught: a path through it
// resolves to an in-root lexical string, passes this check, and the underlying
// fs op follows the link out of the jail. Hardening to a true boundary means
// realpath-ing the resolved path (and, for writeFile, the leaf's parent) before
// the contains check — deferred until the feature graduates off the flag.
export function resolveInWorkspace(root: string, rel: string): string {
  const abs = path.resolve(root, rel)
  if (abs !== root && !Filesystem.contains(root, abs)) {
    throw new Error(`workspace path escapes the workspace root: ${JSON.stringify(rel)}`)
  }
  return abs
}

// Build the workspace-jailed file host fns for a given root. readFile returns
// null for a missing file (a branchable condition) but throws on a jail escape
// (a bug). writeFile auto-creates parent dirs (Filesystem.write mkdir-on-ENOENT).
export function makeFileHooks(root: string) {
  return {
    async readFile(rel: unknown): Promise<string | null> {
      const abs = resolveInWorkspace(root, String(rel))
      if (!(await Filesystem.exists(abs))) return null
      return Filesystem.readText(abs)
    },
    async writeFile(rel: unknown, content: unknown): Promise<void> {
      const abs = resolveInWorkspace(root, String(rel))
      await Filesystem.write(abs, String(content))
    },
    async exists(rel: unknown): Promise<boolean> {
      const abs = resolveInWorkspace(root, String(rel))
      return Filesystem.exists(abs)
    },
    async glob(pattern: unknown): Promise<string[]> {
      // Determinism: fan-out order derives from this list and the journal's
      // occurrence index keys on call order, so the result MUST be stable —
      // sort lexicographically. Returns paths relative to the workspace root
      // (the guest never sees absolute host paths). include "all" → files + dirs
      // (sub-project units like crates are dirs). dot:true matches existing callers.
      const abs = await Glob.scan(String(pattern), {
        cwd: root,
        absolute: true,
        include: "all",
        dot: true,
      })
      // Jail: Glob.scan's `cwd` does NOT confine matches — a guest pattern with `..`
      // or an absolute path escapes the workspace. The other file fns re-jail via
      // resolveInWorkspace; glob must filter its RESULTS. A match outside root maps to
      // a relative path starting with `..` (or an absolute path on some inputs), so
      // drop those. Empty-string (the root itself) is also dropped. Then sort for
      // deterministic fan-out order.
      return abs
        .map((p) => path.relative(root, p))
        .filter((rel) => rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
        .sort()
    },
  }
}
