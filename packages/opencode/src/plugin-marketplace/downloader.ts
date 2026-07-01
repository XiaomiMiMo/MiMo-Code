import path from "path"
import { rename, rm } from "fs/promises"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { Flock } from "@mimo-ai/shared/util/flock"
import type { MarketplaceSource } from "@/cli/cmd/tui/feature-plugins/system/marketplace"
import { isPluginInstalled } from "@/cli/cmd/tui/feature-plugins/system/marketplace"

const MARKETPLACE_OWNER = "anthropics"
const MARKETPLACE_REPO = "claude-plugins-official"
const MARKETPLACE_REF = "main"

const FETCH_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3
const GIT_RETRY_MS = 500

// git stderr 中标识"瞬时网络错误"的关键词——这类错误值得重试（国内 GitHub 访问不稳是常态）。
// 永久错误（not found / authentication failed / could not read Username）不在此列，重试无意义。
const TRANSIENT_GIT_ERR = [
  "schannel",
  "SSL/TLS",
  "failed to receive handshake",
  "Connection reset",
  "RPC failed",
  "early EOF",
  "timed out",
  "Could not resolve host",
  "Empty reply",
]

function isTransientGitError(stderr: string): boolean {
  return TRANSIENT_GIT_ERR.some((kw) => stderr.includes(kw))
}

// 对瞬时网络错误指数退避重试，永久错误直接返回。返回最后一次结果（成功即成功）。
// dep.git 仍可能因 cwd 不存在同步抛错，由调用方兜底。
async function gitWithRetry(
  args: string[],
  opts: { cwd: string },
  dep: DownloadDeps,
): Promise<{ ok: boolean; stderr: string }> {
  let result = await dep.git(args, opts)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (result.ok || !isTransientGitError(result.stderr)) return result
    await Bun.sleep(GIT_RETRY_MS * 2 ** (attempt - 1))
    result = await dep.git(args, opts)
  }
  return result
}

// 给瞬时网络错误附加中文排查提示，帮助用户自助定位（代理 / SSL backend / DNS）。
function withNetworkHint(stderr: string): string {
  if (!isTransientGitError(stderr)) return trimGitError(stderr)
  return `${trimGitError(stderr)}（可能是网络问题：检查代理设置或 git sslBackend，国内可尝试配置 http.proxy）`
}

export type DownloadDeps = {
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
  write: (file: string, data: Uint8Array) => Promise<void>
  exists: (file: string) => Promise<boolean>
  // 目录是否为空。仅测试通过 deps 注入以 mock 边界场景（如空目录残留）；
  // 生产路径不提供，isInstalled 直接走 isPluginInstalled（含 dotfile 处理）。
  isEmpty?: (dir: string) => Promise<boolean>
  remove: (dir: string) => Promise<void>
  // 执行 git 命令，返回是否成功（exit 0）和 stderr
  git: (args: string[], opts: { cwd: string }) => Promise<{ ok: boolean; stderr: string }>
  pluginsDir: string
  lock: (key: string) => Promise<AsyncDisposable>
}

export type DownloadResult =
  | { ok: true; dir: string; skipped: boolean }
  | { ok: false; code: "tree_fetch_failed" | "no_files" | "file_download_failed" | "git_failed"; error?: unknown }

const defaultDeps: DownloadDeps = {
  fetch: (url, init) => globalThis.fetch(url, init),
  write: (file, data) => Filesystem.write(file, data),
  exists: (file) => Filesystem.exists(file),
  remove: (dir) => rm(dir, { recursive: true, force: true }),
  git: async (args, opts) => {
    const proc = Bun.spawn(["git", ...args], { cwd: opts.cwd, stdout: "ignore", stderr: "pipe" })
    const stderr = await new Response(proc.stderr).text()
    const ok = (await proc.exited) === 0
    return { ok, stderr }
  },
  pluginsDir: path.join(Global.Path.data, "plugins"),
  lock: (key) => Flock.acquire(`plugin-install:${key}`),
}

interface TreeEntry {
  path: string
  type: string
}

interface TreeResponse {
  tree: TreeEntry[]
}

// 单文件 fetch，网络抖动（ECONNRESET）时指数退避重试。4xx 不重试，5xx 才重试。
async function fetchWithRetry(url: string, dep: DownloadDeps): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await Bun.sleep(500 * 2 ** (attempt - 1))
    try {
      const resp = await dep.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (resp.status < 500) return resp
      lastError = new Error(`HTTP ${resp.status}`)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

// 下载插件到 pluginsDir/<name>/。跳过式幂等，失败时清理半成品。
// relative 型走 Git Trees API 逐文件下载，其余走系统 git clone。
export async function downloadPlugin(
  name: string,
  source: MarketplaceSource,
  dep: DownloadDeps = defaultDeps,
): Promise<DownloadResult> {
  const dir = path.join(dep.pluginsDir, name)
  try {
    await using _ = await dep.lock(name)
    const result = source.kind === "relative"
      ? await runDownload(source, dir, dep)
      : await runGitDownload(source, dir, dep)
    if (!result.ok) await dep.remove(dir).catch(() => {})
    return result
  } catch (error) {
    return { ok: false, code: "git_failed", error }
  }
}

export type UninstallResult =
  | { ok: true; dir: string; removed: boolean }
  | { ok: false; code: "remove_failed"; error?: unknown }

// 卸载插件：删除 pluginsDir/<name>/。MCP/skill 在 config/skill 加载时扫描该目录，
// 删除后重启即自然消失，无需额外清理配置（mcp_origins 是运行时态不持久化）。
// removed=false 表示本来就没装（目录不存在），非错误——便于 UI 区分提示。
export async function uninstallPlugin(
  name: string,
  dep: DownloadDeps = defaultDeps,
): Promise<UninstallResult> {
  const dir = path.join(dep.pluginsDir, name)
  try {
    await using _ = await dep.lock(name)
    const existed = await dep.exists(dir)
    if (!existed) return { ok: true, dir, removed: false }
    await dep.remove(dir)
    return { ok: true, dir, removed: true }
  } catch (error) {
    return { ok: false, code: "remove_failed", error }
  }
}

// 已安装判定。生产路径复用 marketplace.ts 的 isPluginInstalled（单一事实来源，
// 含 dotfile 处理）；测试可通过 deps.isEmpty 注入来 mock 空目录等边界场景。
async function isInstalled(dir: string, dep: DownloadDeps): Promise<boolean> {
  if (!dep.isEmpty) return isPluginInstalled(dir)
  if (!(await dep.exists(dir))) return false
  return !(await dep.isEmpty(dir))
}

async function runDownload(
  source: { kind: "relative"; path: string },
  dir: string,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  // 持锁后复查：等锁期间可能已被其他进程装好（且装完整，非空）
  if (await isInstalled(dir, dep)) return { ok: true, dir, skipped: true }

  // source.path 形如 "./plugins/foo"，去掉 "./" 得到仓库内相对路径用于 tree 过滤
  const prefix = source.path.replace(/^\.\//, "")
  const blobs = await fetchTree(prefix, dep)
  if ("ok" in blobs) return blobs

  for (const entry of blobs) {
    const rawUrl = `https://raw.githubusercontent.com/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/${MARKETPLACE_REF}/${entry.path}`
    let buf: Uint8Array
    try {
      buf = new Uint8Array(await (await fetchWithRetry(rawUrl, dep)).arrayBuffer())
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
    // entry.path 是仓库内完整路径（plugins/foo/skills/x/SKILL.md），
    // 剥离 prefix 后写盘，避免 dir 已含 <name> 再嵌套一层
    try {
      await dep.write(path.join(dir, entry.path.slice(prefix.length + 1)), buf)
    } catch (error) {
      return { ok: false, code: "file_download_failed", error }
    }
  }
  return { ok: true, dir, skipped: false }
}

// 拉取仓库文件树，过滤出插件目录下的 blob
async function fetchTree(
  prefix: string,
  dep: DownloadDeps,
): Promise<TreeEntry[] | DownloadResult> {
  const treesUrl = `https://api.github.com/repos/${MARKETPLACE_OWNER}/${MARKETPLACE_REPO}/git/trees/${MARKETPLACE_REF}?recursive=1`
  let resp: Response
  try {
    resp = await fetchWithRetry(treesUrl, dep)
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }
  if (!resp.ok) return { ok: false, code: "tree_fetch_failed", error: new Error(`trees API HTTP ${resp.status}`) }

  let tree: TreeEntry[]
  try {
    tree = ((await resp.json()) as TreeResponse).tree ?? []
  } catch (error) {
    return { ok: false, code: "tree_fetch_failed", error }
  }

  const blobs = tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix + "/"))
  return blobs.length ? blobs : { ok: false, code: "no_files" }
}

// git 型 source（url / git-subdir / github）下载。先用系统 git clone，
// 因 schannel/openssl TLS 失败时降级走 GitHub tarball（fetch 路径不受 git TLS 后端影响）。
async function runGitDownload(
  source: Exclude<MarketplaceSource, { kind: "relative" }>,
  dir: string,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  if (await isInstalled(dir, dep)) return { ok: true, dir, skipped: true }

  const { url, sha, subdir } = gitSourceParams(source)
  const sparse = subdir !== undefined

  // 临时 clone 目录
  const tmp = `${dir}.tmp`
  await dep.remove(tmp).catch(() => {})

  // git-subdir 用 sparse-checkout 只取子目录，其余整仓库 clone
  const cloneArgs = ["clone", "--depth", "1"]
  if (sparse) cloneArgs.push("--filter=blob:none", "--sparse")
  cloneArgs.push(url, tmp)
  const clone = await gitWithRetry(cloneArgs, { cwd: dep.pluginsDir }, dep)
  if (clone.ok) {
    return finishGitClone(tmp, dir, sparse, sha, subdir, dep)
  }

  // git clone 失败（常见：国内 Windows schannel TLS 握手失败）→ 降级 tarball
  return fallbackTarball(url, sha, subdir, dir, dep, clone.stderr)
}

// 完成 git clone 后的 sparse-checkout / 版本 checkout / 移动
async function finishGitClone(
  tmp: string,
  dir: string,
  sparse: boolean,
  sha: string | undefined,
  subdir: string | undefined,
  dep: DownloadDeps,
): Promise<DownloadResult> {
  if (sparse) {
    const sc = await gitWithRetry(["sparse-checkout", "set", subdir!], { cwd: tmp }, dep)
    if (!sc.ok) {
      await dep.remove(tmp).catch(() => {})
      return { ok: false, code: "git_failed", error: new Error(withNetworkHint(sc.stderr)) }
    }
  }

  // checkout 固定版本。--depth 1 无法直接 clone 到任意 sha，需 fetch 再 checkout。
  if (sha) {
    const fetchOk = (await gitWithRetry(["fetch", "--depth", "1", "origin", sha], { cwd: tmp }, dep)).ok
    if (fetchOk) {
      const co = await gitWithRetry(["checkout", sha], { cwd: tmp }, dep)
      if (!co.ok) {
        await dep.remove(tmp).catch(() => {})
        return { ok: false, code: "git_failed", error: new Error(withNetworkHint(co.stderr)) }
      }
    }
    // fetch 失败则保留 depth 1 最新版（降级，不阻断）
  }

  // clone 完成后移到最终目录（删 .git 避免 skill 扫描干扰）
  await dep.remove(path.join(tmp, ".git")).catch(() => {})
  await dep.remove(dir).catch(() => {})
  try {
    await rename(tmp, dir)
  } catch (error) {
    await dep.remove(tmp).catch(() => {})
    return { ok: false, code: "git_failed", error }
  }

  return { ok: true, dir, skipped: false }
}

// git clone 失败时的降级路径：从 GitHub codeload 拉 tarball，解压写盘。
// fetch 走和 tree/file 下载相同的网络栈，不受 git 的 schannel/openssl TLS 后端影响。
async function fallbackTarball(
  url: string,
  sha: string | undefined,
  subdir: string | undefined,
  dir: string,
  dep: DownloadDeps,
  gitStderr: string,
): Promise<DownloadResult> {
  const repo = parseGithubRepo(url)
  // 仅支持 github.com 仓库的 tarball 降级；非 github 仓库无 codeload 端点，直接返回 git 错误
  if (!repo) return { ok: false, code: "git_failed", error: new Error(withNetworkHint(gitStderr)) }

  // ref 用 sha 精确定位版本，否则用 main
  const ref = sha ?? "main"
  const tarballUrl = `https://codeload.github.com/${repo.owner}/${repo.name}/tar.gz/${ref}`

  let resp: Response
  try {
    resp = await fetchWithRetry(tarballUrl, dep)
  } catch (error) {
    // tarball fetch 也失败 → 返回原始 git 错误（它通常更接近用户认知）
    return { ok: false, code: "git_failed", error: new Error(withNetworkHint(gitStderr)) }
  }
  if (!resp.ok) {
    return { ok: false, code: "git_failed", error: new Error(withNetworkHint(gitStderr)) }
  }

  const gz = await resp.arrayBuffer()
  const files = extractTarEntries(gz)
  // 剥离 tarball 顶层目录（如 superpowers-main/ 或 repo-<sha>/）
  for (const f of files) {
    const rel = stripTopDir(f.name)
    // git-subdir：只保留 subdir/ 下的文件，并剥离 subdir 前缀
    const target = subdir ? underSubdir(rel, subdir) : rel
    if (!target) continue
    try {
      await dep.write(path.join(dir, target), f.data)
    } catch (error) {
      return { ok: false, code: "git_failed", error }
    }
  }
  return { ok: true, dir, skipped: false }
}

// 从 https://github.com/<owner>/<name>(.git) 解析出 owner/name；非 github 返回 undefined
function parseGithubRepo(url: string): { owner: string; name: string } | undefined {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:[/?#]|$)/)
  return m ? { owner: m[1], name: m[2] } : undefined
}

// 剥离路径的第一段（tarball 顶层目录，如 superpowers-main）
function stripTopDir(p: string): string {
  const idx = p.indexOf("/")
  return idx === -1 ? "" : p.slice(idx + 1)
}

// 若路径以 subdir/ 开头，返回剥离 subdir 后的相对路径；否则返回 undefined（不在子目录内）
function underSubdir(p: string, subdir: string): string | undefined {
  const norm = subdir.replace(/^\//, "").replace(/\/$/, "")
  if (p === norm || p.startsWith(norm + "/")) {
    const rest = p.slice(norm.length)
    return rest.startsWith("/") ? rest.slice(1) : rest
  }
  return undefined
}

// 解析 tar.gz 字节流，提取所有普通文件条目（含字节内容）。
// tar 格式：每条目 512 字节 header + 数据（按 512 对齐）。header 字段：name@0, size@124(octal), type@156
function extractTarEntries(gz: ArrayBuffer): { name: string; data: Uint8Array }[] {
  let buf: Uint8Array
  try {
    buf = Bun.gunzipSync(new Uint8Array(gz) as Uint8Array<ArrayBuffer>)
  } catch {
    return []
  }
  const files: { name: string; data: Uint8Array }[] = []
  let off = 0
  const dec = new TextDecoder()
  while (off + 512 <= buf.length) {
    const name = dec.decode(buf.subarray(off, off + 100)).replace(/\0/g, "")
    if (!name) {
      off += 512
      continue
    }
    // ustar 长名前缀（@345），与 name 拼接
    const prefix = dec.decode(buf.subarray(off + 345, off + 500)).replace(/\0/g, "")
    const fullName = prefix ? `${prefix}/${name}` : name
    const sizeStr = dec.decode(buf.subarray(off + 124, off + 135)).replace(/[\0 ]/g, "")
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(buf[off + 156])
    // type "0"/"\0" = 普通文件；"5" = 目录；其他（软链等）跳过
    if (type === "0" || type === "" || type === "\u0000") {
      files.push({ name: fullName, data: buf.subarray(off + 512, off + 512 + size) })
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

// 从 source 解析 clone 参数
function gitSourceParams(source: Exclude<MarketplaceSource, { kind: "relative" }>): {
  url: string
  sha: string | undefined
  subdir: string | undefined
} {
  if (source.kind === "url") return { url: source.url, sha: source.sha, subdir: undefined }
  if (source.kind === "github") return { url: `https://github.com/${source.repo}`, sha: source.sha, subdir: undefined }
  // git-subdir
  return { url: source.url, sha: source.sha, subdir: source.path }
}

function trimGitError(stderr: string): string {
  return stderr.trim().split("\n").filter((l) => !l.startsWith("warning:")).slice(0, 3).join(" ")
}

