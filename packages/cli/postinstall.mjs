#!/usr/bin/env node

// Best-effort FDS prefetch. Failures must not fail `npm install` — mimo.js
// downloads the binary on first run when vendor/ is still empty.

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import { detectTarget, ensureBinary, packageRoot, vendorBinaryPath } from "./launcher.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

  if (process.env.MIMOCODE_BIN_PATH) return

  try {
    const root = packageRoot(__dirname)
    const target = detectTarget()
    const dest = vendorBinaryPath(root, target)
    if (!fs.existsSync(dest)) {
      await ensureBinary({ root, target })
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
