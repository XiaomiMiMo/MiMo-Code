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
import { DIRECTORY_DENIED_CODE } from "./access"

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

    // Keyed on who SUPPLIED the credential, not on whether one exists. An implicit
    // loopback listener generates a password of its own, and if that flipped this
    // check off it would trade one wall for another: `/v1` bypasses basic auth by
    // design, so a token holder could then aim `?directory=` at any project on the
    // machine. An operator who sets the password themselves keeps the old freedom.
    if (!Flag.MIMOCODE_SERVER_PASSWORD_SUPPLIED) {
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
        // Keep the 403 and the prose message; add a stable `code` so a client can
        // tell this policy rejection apart from a transport failure and surface it
        // instead of dying (see ./access.ts).
        return c.json(
          {
            code: DIRECTORY_DENIED_CODE,
            error: "Access denied: directory must be within the server's working directory",
            directory,
          },
          403,
        )
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
