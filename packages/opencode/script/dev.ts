#!/usr/bin/env bun
// Dev launcher. If an optional local extension overlay is available next to this
// checkout (at ../../mimoapi/packages/opencode/src/ext), it is copied into
// src/ext/ before starting the dev server and removed on exit, so the dev run
// picks up those modules while the working tree stays clean. When no overlay is
// present (e.g. an open-source checkout) this just runs the dev server.
import fs from "fs"
import path from "path"

const pkgDir = path.resolve(import.meta.dir, "..")
const extDir = path.join(pkgDir, "src", "ext")
const overlaySrc = path.resolve(pkgDir, "../../mimoapi/packages/opencode/src/ext")

let injected = false
if (!fs.existsSync(extDir) && fs.existsSync(overlaySrc)) {
  fs.cpSync(overlaySrc, extDir, { recursive: true })
  injected = true
  console.log(`Injected local extensions from ${overlaySrc}`)
}

function cleanup() {
  if (injected) fs.rmSync(extDir, { recursive: true, force: true })
}
process.on("exit", cleanup)

const proc = Bun.spawn(["bun", "run", "--conditions=browser", "src/index.ts", ...process.argv.slice(2)], {
  cwd: pkgDir,
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, MIMOCODE_HOME: process.env.MIMOCODE_HOME ?? path.resolve(pkgDir, "../../.dev-home") },
})

const onSignal = () => proc.kill()
process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)

const code = await proc.exited
cleanup()
process.exit(code ?? 0)
