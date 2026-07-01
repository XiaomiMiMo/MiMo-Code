import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { isRecord } from "@/util/record"
import { Glob } from "@mimo-ai/shared/util/glob"

// 构建时注入的内置 marketplace.json（dev 环境为 undefined，走联网 fetch）
declare const BUILTIN_MARKETPLACE: string | undefined

interface RawMarketplaceEntry {
  name: string
  description?: string
  source?: unknown
}

export interface MarketplacePlugin {
  name: string
  description: string
  source: MarketplaceSource | undefined
}

// 解析后的来源描述（discriminated union）。
// 刻意区别于 shared.ts 的 PluginSource（"file"|"npm"，描述代码插件安装来源）；
// MarketplaceSource 描述 marketplace.json 条目 source 字段的形态，不可混用。
export type MarketplaceSource =
  | { kind: "relative"; path: string }
  | { kind: "url"; url: string; sha?: string }
  | { kind: "git-subdir"; url: string; path?: string; sha?: string }
  | { kind: "github"; repo: string; sha?: string }

// 解析 marketplace.json 条目的 source 字段为 MarketplaceSource。
// 纯函数，可单测。覆盖 4 种形态 + 无 source / 畸形值兜底 undefined。
export function parsePluginSource(raw: unknown): MarketplaceSource | undefined {
  if (typeof raw === "string" && raw.startsWith("./")) {
    return { kind: "relative", path: raw }
  }
  if (!isRecord(raw)) return
  const kind = raw.source
  if (typeof kind !== "string") return

  if (kind === "url") {
    const url = raw.url
    if (typeof url !== "string") return
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "url", url, sha }
  }
  if (kind === "git-subdir") {
    const url = raw.url
    if (typeof url !== "string") return
    const sub = typeof raw.path === "string" ? raw.path : undefined
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "git-subdir", url, path: sub, sha }
  }
  if (kind === "github") {
    const repo = raw.repo
    if (typeof repo !== "string") return
    const sha = typeof raw.sha === "string" ? raw.sha : undefined
    return { kind: "github", repo, sha }
  }
}

export type LoadResult =
  | { status: "ready"; plugins: MarketplacePlugin[] }
  | { status: "error"; message: string }

// 插件已安装的统一判定（marketplace 功能内唯一事实来源）：目录存在且含文件。
// dot:true 是关键——GitHub 类插件（如官方 MCP）整包全是点文件，不传则 glob
// 默认忽略 dotfile，与下载器的 skip 判定冲突（“提示已安装但分组看不到”）。
export async function isPluginInstalled(dir: string): Promise<boolean> {
  if (!(await Filesystem.isDir(dir))) return false
  const files = await Glob.scan("**/*", { cwd: dir, include: "file", dot: true }).catch(() => [])
  return files.length > 0
}

// 解析 marketplace.json 文本 → MarketplacePlugin[]
// 容忍任意 JSON：非数组 plugins 当空；null/无 name 的条目过滤掉；
// description 缺失或非字符串兜底空字符串。
export function parseMarketplaceJson(raw: string): MarketplacePlugin[] {
  const data = JSON.parse(raw) as { plugins?: unknown }
  const entries = Array.isArray(data.plugins) ? data.plugins : []
  return entries
    .filter(
      (entry): entry is RawMarketplaceEntry & { name: string } =>
        entry != null && typeof entry.name === "string" && entry.name.length > 0,
    )
    .map((entry) => ({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      source: parsePluginSource(entry.source),
    }))
}

const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json"
const FETCH_TIMEOUT_MS = 15_000
const CACHE_FILE = path.join(Global.Path.cache, "marketplace.json")
const ETAG_FILE = path.join(Global.Path.cache, "marketplace.json.etag")

async function readCache(): Promise<{ raw: string; etag?: string } | undefined> {
  const raw = await Filesystem.readText(CACHE_FILE).catch(() => undefined)
  if (!raw) return
  const etag = await Filesystem.readText(ETAG_FILE).catch(() => undefined)
  return { raw, etag: etag || undefined }
}

async function writeCache(raw: string, etag?: string): Promise<void> {
  await Filesystem.write(CACHE_FILE, raw)
  if (etag) await Filesystem.write(ETAG_FILE, etag)
}

// 加载市场数据。
// force=false：有缓存先返回缓存（调用方可再后台静默 force 检查更新）。
// force=true：忽略缓存，强制重新 fetch。
export async function loadMarketplace(options?: { force?: boolean }): Promise<LoadResult> {
  const cache = !options?.force ? await readCache() : undefined

  // 有缓存且非强制：立即返回缓存数据
  if (cache) {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    } catch {
      // 缓存损坏，当作无缓存继续
    }
  }

  // 无缓存：优先用内置版本（构建时注入，离线秒开，不联网）
  if (typeof BUILTIN_MARKETPLACE !== "undefined") {
    try {
      return { status: "ready", plugins: parseMarketplaceJson(BUILTIN_MARKETPLACE) }
    } catch {
      // 内置数据损坏（理论不可能），继续联网 fetch
    }
  }

  const headers: Record<string, string> = {}
  if (cache?.etag) headers["If-None-Match"] = cache.etag

  try {
    const response = await fetch(MARKETPLACE_URL, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (response.status === 304 && cache) {
      return { status: "ready", plugins: parseMarketplaceJson(cache.raw) }
    }

    if (!response.ok) {
      return { status: "error", message: `HTTP ${response.status}` }
    }

    const raw = await response.text()
    const etag = response.headers.get("etag") ?? undefined
    const plugins = parseMarketplaceJson(raw)
    await writeCache(raw, etag).catch(() => {})
    return { status: "ready", plugins }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { status: "error", message }
  }
}
