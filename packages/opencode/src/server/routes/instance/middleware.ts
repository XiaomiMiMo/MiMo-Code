import type { MiddlewareHandler } from "hono"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@/flag/flag"
import { existsSync } from "fs"
import { join } from "path"
import { Filesystem } from "@/util"

const PROJECT_MARKERS = [
  ".git",
  ".mimocode",
  ".mimocode-project-id",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  ".hg",
  ".svn",
]

const SYSTEM_PATHS = ["/etc", "/proc", "/sys", "/var", "/boot", "/root", "/dev", "/usr", "/bin", "/sbin", "/lib", "/tmp"]

export function isValidProjectDirectory(directory: string): boolean {
  const cwd = Filesystem.resolve(process.cwd())

  if (Filesystem.contains(cwd, directory)) return true

  for (const sys of SYSTEM_PATHS) {
    if (directory === sys || Filesystem.contains(sys, directory)) return false
  }

  return PROJECT_MARKERS.some((marker) => existsSync(join(directory, marker)))
}

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.query("directory") || c.req.header("x-mimocode-directory") || process.cwd()
    const directory = AppFileSystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    if (!Flag.MIMOCODE_SERVER_PASSWORD) {
      const cwd = Filesystem.resolve(process.cwd())
      if (!Filesystem.contains(cwd, directory)) {
        return c.json({ error: "Access denied: directory must be within project root on unauthenticated servers" }, 403)
      }
    }

    if (!isValidProjectDirectory(directory)) {
      return c.json({ error: "Access denied: invalid project directory" }, 403)
    }

    return WorkspaceContext.provide({
      workspaceID,
      async fn() {
        return Instance.provide({
          directory,
          init: () => AppRuntime.runPromise(InstanceBootstrap),
          async fn() {
            return next()
          },
        })
      },
    })
  }
}
