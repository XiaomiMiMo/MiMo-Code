import { mkdtempSync } from "fs"
import path from "path"
import os from "os"

// Imported FIRST by TUI context tests so every module that resolves global
// paths at import time (Global.Path, Flock, KV storage) lands in a throwaway
// home instead of the developer's real one. No-op when the runner already
// provided one.
if (!process.env.MIMOCODE_HOME) {
  process.env.MIMOCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "mimocode-tui-test-home-"))
}
