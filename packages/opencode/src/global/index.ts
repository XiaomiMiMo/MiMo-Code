import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "../util"
import { Flock } from "@mimo-ai/shared/util/flock"
import { resolveMimocodeHome } from "@mimo-ai/shared/global"

const { data, cache, config, state } = resolveMimocodeHome()

export const Path = {
  // HOME/USERPROFILE read directly because Bun caches os.homedir() at startup.
  // Tests set these env vars to isolate from the developer's real home.
  get home() {
    return process.env.HOME || process.env.USERPROFILE || os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  cache,
  config,
  state,
}

// Initialize Flock with global state path
Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
])

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch {}
  await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
}

export * as Global from "."
