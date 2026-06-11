import path from "path"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"

const APP = "mimocode"

export type ResolvedPaths = {
  mode: "mimocode_home" | "xdg"
  root?: string
  data: string
  cache: string
  config: string
  state: string
}

/**
 * Resolve mimocode's four base directories (config/data/state/cache)
 * from environment variables.
 *
 * If MIMOCODE_HOME is set and non-empty, the four paths are subdirectories
 * of it. Otherwise, falls through to XDG Base Directory defaults.
 *
 * @throws if MIMOCODE_HOME is set but not an absolute path
 */
export function resolveMimocodeHome(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const home = env.MIMOCODE_HOME
  if (home) {
    if (!path.isAbsolute(home)) {
      throw new Error(
        `MIMOCODE_HOME must be an absolute path, got: ${JSON.stringify(home)}`,
      )
    }
    return {
      mode: "mimocode_home",
      root: home,
      data: path.join(home, "data"),
      cache: path.join(home, "cache"),
      config: path.join(home, "config"),
      state: path.join(home, "state"),
    }
  }
  return {
    mode: "xdg",
    data: path.join(xdgData!, APP),
    cache: path.join(xdgCache!, APP),
    config: path.join(xdgConfig!, APP),
    state: path.join(xdgState!, APP),
  }
}

export namespace Global {
  export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

  export interface Interface {
    readonly home: string
    readonly data: string
    readonly cache: string
    readonly config: string
    readonly state: string
    readonly bin: string
    readonly log: string
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
      const { data, cache, config, state } = yield* Effect.sync(() => resolveMimocodeHome())
      const bin = path.join(cache, "bin")
      const log = path.join(data, "log")

      return Service.of({
        home,
        data,
        cache,
        config,
        state,
        bin,
        log,
      })
    }),
  )
}
