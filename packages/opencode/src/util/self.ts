/**
 * How to invoke THIS CLI again, without assuming anything is on PATH.
 *
 * `mimo` is frequently not a command. It may have been launched through `npx`, from
 * a `node_modules/.bin` shim, from a source checkout with `bun run dev`, or from
 * inside a host application's bundle. Printing "run `mimo ...`" in that situation
 * is advice the caller cannot follow.
 *
 * The reliable signal is the running process itself. Every SHIPPED path ends up
 * executing the compiled single-file binary — `bin/mimo` is only a Node shim that
 * `spawnSync`s it — so `process.execPath` is already a complete, absolute,
 * PATH-independent invocation. Verified empirically: a `bun build --compile` binary
 * reports `execPath` as its own real path from any working directory, while
 * `Bun.main` points inside the embedded filesystem.
 *
 * Only a from-source run needs more, because there `execPath` is the bun binary and
 * the entry script has to come along with it.
 */

// The prefixes `script/build.ts` uses for the embedded filesystem, per target OS.
const BUNFS_ROOTS = ["/$bunfs/", "B:/~BUN/", "b:/~bun/"]

/**
 * Is this process a compiled binary rather than a script being interpreted?
 *
 * Asked of `Bun.main`, not of `execPath`: the entry module living in the embedded
 * filesystem is the thing that actually distinguishes the two cases.
 */
export function compiled() {
  const main = typeof Bun === "undefined" ? undefined : Bun.main
  if (!main) return false
  const normalized = main.replaceAll("\\", "/")
  return BUNFS_ROOTS.some((root) => normalized.startsWith(root))
}

/**
 * argv for re-invoking this CLI. Programmatic callers should prefer this over
 * `commandLine`, since it needs no unquoting.
 */
export function argv(...args: string[]): string[] {
  // Honours the same override `bin/mimo` reads, so a host that pins a specific
  // binary keeps control of which one a re-invocation reaches.
  const pinned = process.env["MIMOCODE_BIN_PATH"]
  if (pinned) return [pinned, ...args]
  if (compiled()) return [process.execPath, ...args]
  return [process.execPath, Bun.main, ...args]
}

/**
 * Shell-safe single string, for embedding in an error message a human or an agent
 * will copy. Quoting is not optional: real install paths contain spaces, notably
 * inside macOS application bundles.
 */
export function commandLine(...args: string[]) {
  return argv(...args).map(quote).join(" ")
}

function quote(part: string) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part)) return part
  return `'${part.replaceAll("'", `'\\''`)}'`
}

export * as Self from "./self"
