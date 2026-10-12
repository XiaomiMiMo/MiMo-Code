#!/usr/bin/env node

// Best-effort FDS prefetch. Failures must not fail `npm install` — bin/mimo
// downloads the binary on first run when vendor/ is still empty.

import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const launcher = require(path.join(__dirname, "launcher.cjs"))

function printMigrationNotice() {
  const install =
    process.platform === "win32"
      ? "irm https://mimo.xiaomi.com/install.ps1 | iex"
      : "curl -fsSL https://mimo.xiaomi.com/install | bash"
  console.log()
  console.log("  Recommended: install MiMoCode natively for a better install and upgrade experience:")
  console.log(`    ${install}`)
  console.log()
}

async function main() {
  printMigrationNotice()

  if (process.env.MIMOCODE_BIN_PATH) {
    return
  }

  try {
    const root = launcher.packageRoot(__dirname)
    const target = launcher.detectTarget()
    const dest = launcher.vendorBinaryPath(root, target)
    if (!require("fs").existsSync(dest)) {
      await launcher.ensureBinary({ root, target })
    }
  } catch (error) {
    console.warn(`postinstall: skipped binary prefetch: ${error && error.message ? error.message : error}`)
    console.warn("The first `mimo` run will download the binary from FDS.")
  }
}

main().catch(() => {
  // Best-effort only — never fail install.
  process.exit(0)
})
