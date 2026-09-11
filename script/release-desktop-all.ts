#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"

function formatTime(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`
}

console.log("\n🚀 ===== 开始桌面端 Release 打包 (仅 Tauri) =====\n")
const totalStart = Date.now()

// 1. 确保构建资产与 Sidecar 二进制准备就绪
console.log("📦 [1/2] 准备构建资产与 Sidecar 二进制...")
const preStart = Date.now()
await $`./packages/opencode/script/build.ts --single`.nothrow()

// 确保 Sidecar 拷贝到位
const arm64Binary = "./packages/opencode/dist/mimocode-darwin-arm64/bin/mimo"
const x64Binary = "./packages/opencode/dist/mimocode-darwin-x64/bin/mimo"
const binarySource = existsSync(arm64Binary) ? arm64Binary : existsSync(x64Binary) ? x64Binary : null

if (binarySource) {
  const targetTriple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  await $`mkdir -p packages/desktop-tauri/src-tauri/binaries`
  await $`cp ${binarySource} packages/desktop-tauri/src-tauri/binaries/opencode-${targetTriple}`
}
console.log(`✅ [1/2] 资产准备完成，耗时: ${formatTime(Date.now() - preStart)}\n`)

// 2. 构建 Tauri Release 包
console.log("⚡ [2/2] 开始构建 Tauri 桌面包...\n")

const buildStart = Date.now()
const res = await $`bun run --cwd packages/desktop-tauri build`.nothrow()
const buildDuration = Date.now() - buildStart

if (res.exitCode === 0) {
  console.log(`\n✅ [Tauri] 构建成功！耗时: ${formatTime(buildDuration)}`)
  console.log(`🎉 ===== 任务完成！总耗时: ${formatTime(Date.now() - totalStart)} =====`)
} else {
  console.error(`\n❌ [Tauri] 构建失败！耗时: ${formatTime(buildDuration)}`)
  process.exit(1)
}
