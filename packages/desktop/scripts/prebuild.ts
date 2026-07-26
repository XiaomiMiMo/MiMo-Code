#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

import { existsSync, mkdirSync, cpSync } from "node:fs"
import path from "node:path"

const channel = resolveChannel()
const desktopDir = path.resolve(import.meta.dir, "..")

console.log("   👉 [prebuild] 正在复制图标...")
const iconStart = Date.now()
await $`bun ./scripts/copy-icons.ts ${channel}`
console.log(`   👉 [prebuild] 图标复制完成 (${((Date.now() - iconStart) / 1000).toFixed(2)}s)`)

function locateLydellDir(desktopDir: string): string | null {
  const candidates = [
    path.join(desktopDir, "node_modules/@lydell"),
    path.resolve(desktopDir, "../../node_modules/@lydell"),
    path.resolve(desktopDir, "../../node_modules/.bun/node_modules/@lydell"),
    path.resolve(desktopDir, "../opencode/node_modules/@lydell"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

console.log("   👉 [prebuild] 正在确保 node-pty 原生模块分类就绪...")
const ptyDest = path.join(desktopDir, "node_modules/@lydell")
const lydellSource = locateLydellDir(desktopDir)
if (lydellSource && lydellSource !== ptyDest) {
  mkdirSync(path.dirname(ptyDest), { recursive: true })
  cpSync(lydellSource, ptyDest, { recursive: true, dereference: true })
}

console.log("   👉 [prebuild] 正在编译 opencode 后端核心 (script/build-node.ts)...")
const opencodeStart = Date.now()
await $`cd ../opencode && bun script/build-node.ts`
console.log(`   👉 [prebuild] opencode 后端编译完成 (${((Date.now() - opencodeStart) / 1000).toFixed(2)}s)`)
