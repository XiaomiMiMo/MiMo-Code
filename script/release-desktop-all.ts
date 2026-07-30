#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync } from "node:fs"

function formatTime(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`
}

console.log("\n🚀 ===== 开始并行桌面端 Release 打包 (Electron + Tauri) =====\n")
const totalStart = Date.now()

// 1. 确保构建前端与 Sidecar 共享依赖准备就绪
console.log("📦 [1/2] 准备构建资产与 Sidecar 二进制...")
const preStart = Date.now()
await $`bun run --cwd packages/desktop prebuild`.nothrow()
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

// 2. 并行起构建 Release 包
console.log("⚡ [2/2] 并行启动 Electron 与 Tauri Release 打包任务...\n")

const buildElectron = async () => {
  const start = Date.now()
  console.log("⏳ [Electron] 开始构建 Electron 桌面包...")
  const res = await $`bun run --cwd packages/desktop package:mac`.nothrow()
  const duration = Date.now() - start
  if (res.exitCode === 0) {
    console.log(`✅ [Electron] 构建成功！耗时: ${formatTime(duration)}`)
    return { name: "Electron", success: true, duration }
  } else {
    console.error(`❌ [Electron] 构建失败！`)
    return { name: "Electron", success: false, duration, error: res.stderr.toString() }
  }
}

const buildTauri = async () => {
  const start = Date.now()
  console.log("⏳ [Tauri] 开始构建 Tauri 桌面包...")
  const res = await $`bun run --cwd packages/desktop-tauri build`.nothrow()
  const duration = Date.now() - start
  if (res.exitCode === 0) {
    console.log(`✅ [Tauri] 构建成功！耗时: ${formatTime(duration)}`)
    return { name: "Tauri", success: true, duration }
  } else {
    console.error(`❌ [Tauri] 构建失败！`)
    return { name: "Tauri", success: false, duration, error: res.stderr.toString() }
  }
}

// 执行并行构建
const results = await Promise.all([buildElectron(), buildTauri()])

console.log("\n📊 ===== 桌面端 Release 构建汇总报告 =====\n")
let hasFailure = false

for (const res of results) {
  if (res.success) {
    console.log(`  🟢 ${res.name.padEnd(10)}: 构建成功 (耗时 ${formatTime(res.duration)})`)
  } else {
    hasFailure = true
    console.log(`  🔴 ${res.name.padEnd(10)}: 构建失败 (耗时 ${formatTime(res.duration)})`)
  }
}

console.log(`\n🎉 ===== 任务结束！总耗时: ${formatTime(Date.now() - totalStart)} =====\n`)

if (hasFailure) {
  process.exit(1)
}
