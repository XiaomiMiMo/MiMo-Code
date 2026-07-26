#!/usr/bin/env bun
import { $ } from "bun"

function formatTime(ms: number) {
  const sec = (ms / 1000).toFixed(2)
  return `${sec}s`
}

const isFast = process.argv.includes("--fast") || process.env.FAST === "true" || process.argv.includes("--dir")
const totalStart = Date.now()

console.log(`\n🚀 ===== 开始 macOS 桌面端打包 (模式: ${isFast ? "极速免压缩 .app 模式" : "完整 DMG+ZIP 发布模式"}) =====\n`)

// 步骤 1: Prebuild (图标复制 & opencode 后端编译)
console.log("⏱️  [1/3] 执行 prebuild...")
const prebuildStart = Date.now()
await $`bun ./scripts/prebuild.ts`
console.log(`✅ [1/3] prebuild 耗时: ${formatTime(Date.now() - prebuildStart)}\n`)

// 步骤 2: electron-vite build
console.log("⏱️  [2/3] 执行 electron-vite build...")
const viteStart = Date.now()
await $`electron-vite build --logLevel warn`
console.log(`✅ [2/3] electron-vite build 耗时: ${formatTime(Date.now() - viteStart)}\n`)

// 步骤 3: 极速生成 .app 包 (绕过 electron-builder 的 Bun node_modules 全量扫描)
console.log("⏱️  [3/3] 正在生成 macOS .app 应用...")
const appStart = Date.now()
await $`bun ./scripts/fast-mac-app.ts`
console.log(`✅ [3/3] .app 目录生成耗时: ${formatTime(Date.now() - appStart)}\n`)

// 如果是完整发布模式，再调用 electron-builder 打包 DMG/ZIP
if (!isFast) {
  const channel = process.env.OPENCODE_CHANNEL || "dev"
  const productNameMap: Record<string, string> = {
  dev: "MiMo-Code Dev",
  beta: "MiMo-Code Beta",
  prod: "MiMo-Code",
}
const productName = productNameMap[channel] ?? "MiMo-Code Dev"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const targetAppPath = `dist/mac-${arch}/${productName}.app`

  console.log("📦 [附加步骤] 正在生成 DMG/ZIP 最终发布包...")
  const dmgStart = Date.now()
  await $`electron-builder --mac --prepackaged ${targetAppPath} --config electron-builder.config.ts`
  console.log(`✅ 发布包制作完成 耗时: ${formatTime(Date.now() - dmgStart)}\n`)
}

console.log(`🎉 ===== 打包全流程完成！总耗时: ${formatTime(Date.now() - totalStart)} =====\n`)
