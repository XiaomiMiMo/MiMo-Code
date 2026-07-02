// Fixture: imports Global and prints resolved paths to stdout as JSON.
// Env vars must be set by the spawning process before invocation.

import fs from "fs/promises"
import { Global } from "../../../src/global"

// Resolve (and create) the orchestrator dir so the parent test can assert on it.
const orchestrator = await Global.orchestratorDir()
const orchestratorExists = await fs
  .stat(orchestrator)
  .then((s) => s.isDirectory())
  .catch(() => false)

// Emit a single JSON line so the parent test can parse it
process.stdout.write(
  JSON.stringify({
    data: Global.Path.data,
    config: Global.Path.config,
    state: Global.Path.state,
    cache: Global.Path.cache,
    bin: Global.Path.bin,
    log: Global.Path.log,
    home: Global.Path.home,
    orchestrator,
    orchestratorExists,
  }) + "\n",
)
