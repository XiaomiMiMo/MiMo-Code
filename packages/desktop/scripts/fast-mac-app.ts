#!/usr/bin/env bun
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { $ } from "bun"
import { resolveChannel } from "./utils"

const start = Date.now()

const channel = resolveChannel()
const productNameMap: Record<string, string> = {
  dev: "MiMo-Code Dev",
  beta: "MiMo-Code Beta",
  prod: "MiMo-Code",
}
const productName = productNameMap[channel] ?? "MiMo-Code Dev"
const arch = process.arch === "arm64" ? "arm64" : "x64"

const desktopDir = resolve(import.meta.dir, "..")
const distDir = join(desktopDir, "dist", `mac-${arch}`)
const appName = `${productName}.app`
const appPath = join(distDir, appName)

console.log(`⏱️  [Direct Packager] 正在生成 macOS .app (${productName}, ${arch})...`)

// 1. 清理旧产物
await $`rm -rf ${appPath}`
mkdirSync(distDir, { recursive: true })

// 2. 定位 node_modules 中的 Electron.app 模板
function locateElectronAppTemplate(): string | null {
  try {
    const electronExe = require("electron")
    if (typeof electronExe === "string" && electronExe.includes("Electron.app")) {
      const appIndex = electronExe.indexOf("Electron.app")
      const extractedPath = electronExe.slice(0, appIndex + "Electron.app".length)
      if (existsSync(extractedPath)) return extractedPath
    }
  } catch {}

  try {
    const electronPkgMain = require.resolve("electron")
    const dir = dirname(electronPkgMain)
    const candidates = [
      join(dir, "dist/Electron.app"),
      join(dir, "dist/mac/Electron.app"),
      resolve(desktopDir, "../../node_modules/electron/dist/Electron.app"),
      resolve(desktopDir, "node_modules/electron/dist/Electron.app"),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  } catch {}

  return null
}

let electronAppTemplate = locateElectronAppTemplate()

if (!electronAppTemplate) {
  console.log("⚠️ 尝试自动补齐下载 Electron 基础模板...")
  try {
    await $`node node_modules/electron/install.js`.cwd(desktopDir).nothrow()
    await $`bunx electron --version`.cwd(desktopDir).nothrow()
  } catch {}
  electronAppTemplate = locateElectronAppTemplate()
}

if (!electronAppTemplate) {
  console.error("❌ 找不到 Electron 模板，请检查 node_modules 中的 electron 安装状态")
  process.exit(1)
}

// 3. 复制 Electron.app 骨架
cpSync(electronAppTemplate, appPath, { recursive: true })

// 4. 复制 out 目录、node_modules/@lydell 原生依赖与 package.json
const resourcesAppDir = join(appPath, "Contents/Resources/app")
mkdirSync(resourcesAppDir, { recursive: true })
cpSync(join(desktopDir, "out"), join(resourcesAppDir, "out"), { recursive: true })

function locateLydellDir(baseDir: string): string | null {
  const candidates = [
    join(baseDir, "node_modules/@lydell"),
    resolve(baseDir, "../../node_modules/@lydell"),
    resolve(baseDir, "../../node_modules/.bun/node_modules/@lydell"),
    resolve(baseDir, "../opencode/node_modules/@lydell"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

const lydellSource = locateLydellDir(desktopDir)
const ptyDest = join(resourcesAppDir, "node_modules/@lydell")
if (lydellSource) {
  mkdirSync(join(resourcesAppDir, "node_modules"), { recursive: true })
  cpSync(lydellSource, ptyDest, { recursive: true, dereference: true })
}

const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"))
writeFileSync(
  join(resourcesAppDir, "package.json"),
  JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    type: "module",
    main: "./out/main/index.js",
  }, null, 2)
)

// 5. 复制图标与配置 Info.plist
const iconPath = join(desktopDir, "resources/icons/icon.icns")
if (existsSync(iconPath)) {
  cpSync(iconPath, join(appPath, "Contents/Resources/electron.icns"))
}

// 重命名 macOS 可执行二进制文件
const oldExe = join(appPath, "Contents/MacOS/Electron")
const newExe = join(appPath, "Contents/MacOS", productName)
if (existsSync(oldExe)) {
  await $`mv ${oldExe} ${newExe}`
}

// 更新 Info.plist
const plistPath = join(appPath, "Contents/Info.plist")
if (existsSync(plistPath)) {
  let plist = readFileSync(plistPath, "utf8")
  plist = plist.replace(/<key>CFBundleExecutable<\/key>\s*<string>Electron<\/string>/, `<key>CFBundleExecutable</key>\n\t<string>${productName}</string>`)
  plist = plist.replace(/<key>CFBundleDisplayName<\/key>\s*<string>Electron<\/string>/, `<key>CFBundleDisplayName</key>\n\t<string>${productName}</string>`)
  plist = plist.replace(/<key>CFBundleName<\/key>\s*<string>Electron<\/string>/, `<key>CFBundleName</key>\n\t<string>${productName}</string>`)
  writeFileSync(plistPath, plist)
}

// 6. 执行临时签名 (Ad-hoc signing)
await $`codesign --sign - --force --deep ${appPath}`

const elapsed = ((Date.now() - start) / 1000).toFixed(2)
console.log(`✅ .app 应用包生成完成 (${elapsed}s) -> ${appPath}\n`)
