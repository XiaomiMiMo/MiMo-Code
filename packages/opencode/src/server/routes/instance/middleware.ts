import type { MiddlewareHandler } from "hono"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@/flag/flag"
import { Filesystem } from "@/util"
import { Global } from "@/global"
import path from "node:path"

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
      // The fixed global Orchestrator workspace is app-owned (under Global.Path.data),
      // not user-supplied, so entering Orchestrator mode may switch to it even though
      // it lives outside the server's cwd. Allow it explicitly — but only when the
      // Orchestrator feature is enabled (otherwise no escape hatch exists).
      const orchestrator =
        Flag.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR
          ? Filesystem.resolve(path.join(Global.Path.data, "orchestrator"))
          : undefined
      if (!Filesystem.contains(cwd, directory) && directory !== orchestrator) {
        return c.json({ error: "Access denied: directory must be within the server's working directory" }, 403)
      }
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
