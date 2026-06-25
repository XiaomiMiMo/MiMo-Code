import type { MiddlewareHandler } from "hono"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@/flag/flag"
import { Filesystem } from "@/util"

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
