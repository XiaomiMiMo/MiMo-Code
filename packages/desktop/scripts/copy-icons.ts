import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const src = `./icons/${channel}`
const dest = "resources/icons"
const markerFile = path.join(dest, ".channel")

let currentChannel = ""
if (fs.existsSync(dest) && fs.existsSync(markerFile)) {
  try {
    currentChannel = fs.readFileSync(markerFile, "utf-8").trim()
  } catch {}
}

if (fs.existsSync(dest) && currentChannel === channel) {
  process.exit(0)
}

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
fs.writeFileSync(markerFile, channel)
console.log(`Copied ${channel} icons from ${src} to ${dest}`)
