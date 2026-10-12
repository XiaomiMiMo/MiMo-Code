/**
 * Root test isolation env (defense in depth).
 *
 * Sets process env BEFORE any test/src import so xdg-basedir / Flag.MIMOCODE_DB
 * cannot bind to the developer's real home or production mimocode.db.
 * packages/cli/test/preload.ts remains the full fixture preload when tests
 * run from packages/cli; this file only makes a mistaken root-level run safe.
 *
 * Does not override values already set by the caller or by packages/cli preload.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const setIfEmpty = (key: string, value: string) => {
  if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-root-test-"))
setIfEmpty("MIMOCODE_DB", ":memory:")
setIfEmpty("XDG_DATA_HOME", path.join(root, "share"))
setIfEmpty("XDG_CACHE_HOME", path.join(root, "cache"))
setIfEmpty("XDG_CONFIG_HOME", path.join(root, "config"))
setIfEmpty("XDG_STATE_HOME", path.join(root, "state"))
// Keep a disposable HOME so engine config discovery never reads ~/.config/mimocode.
setIfEmpty("HOME", path.join(root, "home"))
setIfEmpty("USERPROFILE", path.join(root, "home"))
