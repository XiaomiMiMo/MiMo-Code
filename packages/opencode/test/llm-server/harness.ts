import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { AppRuntime } from "../../src/effect/app-runtime"
import { CapabilityRoutes, CAPABILITY_PREFIX } from "../../src/server/routes/instance/capability"

/**
 * The capability routes mounted the way production mounts them.
 *
 * Production registers `CapabilityRoutes` inside `InstanceRoutes`, which sits behind
 * `InstanceMiddleware` — so every handler runs with an instance provided. This reproduces
 * exactly that arrangement rather than faking it: the routes are the real ones, the
 * instance is real, and only the listener is absent because a test does not need a socket.
 *
 * Keeping `fetch(request)` as the surface means a test reads the same as one written against
 * a running server.
 */
export function capabilityApp(directory: string) {
  const app = new Hono().route(CAPABILITY_PREFIX, CapabilityRoutes())
  return {
    fetch: (request: Request) =>
      Instance.provide({
        directory,
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        fn: () => app.fetch(request),
      }),
  }
}

export type CapabilityApp = ReturnType<typeof capabilityApp>
