import type { APIEvent } from "@solidjs/start"
import type { DownloadPlatform } from "../types"

type GitHubRelease = {
  prerelease?: boolean
  assets?: {
    name?: string
    browser_download_url?: string
  }[]
}
type CachedRequestInit = RequestInit & {
  cf?: {
    cacheTtl: number
    cacheEverything: boolean
  }
}

const repo = "XiaomiMiMo/MiMo-Code"
const cache = {
  cacheTtl: 60 * 5,
  cacheEverything: true,
}

function cachedRequest(init: RequestInit = {}): CachedRequestInit {
  return { ...init, cf: cache }
}

const assetNames: Record<string, string> = {
  "darwin-arm64-zip": "mimocode-darwin-arm64.zip",
  "darwin-x64-zip": "mimocode-darwin-x64.zip",
  "windows-x64-zip": "mimocode-windows-x64.zip",
  "linux-x64-tar": "mimocode-linux-x64.tar.gz",
  "linux-arm64-tar": "mimocode-linux-arm64.tar.gz",
} satisfies Record<DownloadPlatform, string>

// Doing this on the server lets us preserve the friendly product name for direct downloads.
const downloadNames: Record<string, string> = {
  "darwin-arm64-zip": "MiMoCode CLI macOS arm64.zip",
  "darwin-x64-zip": "MiMoCode CLI macOS x64.zip",
  "windows-x64-zip": "MiMoCode CLI Windows x64.zip",
  "linux-x64-tar": "MiMoCode CLI Linux x64.tar.gz",
  "linux-arm64-tar": "MiMoCode CLI Linux arm64.tar.gz",
} satisfies Record<DownloadPlatform, string>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isGitHubAsset(value: unknown) {
  if (!isRecord(value)) return false
  return (
    (value.name === undefined || typeof value.name === "string") &&
    (value.browser_download_url === undefined || typeof value.browser_download_url === "string")
  )
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (!isRecord(value)) return false
  return (
    (value.prerelease === undefined || typeof value.prerelease === "boolean") &&
    (value.assets === undefined || (Array.isArray(value.assets) && value.assets.every(isGitHubAsset)))
  )
}

async function latestBetaAssetUrl(assetName: string) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=20`,
    cachedRequest({
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "MiMoCode-Console",
      },
    }),
  )
  if (!response.ok) return undefined

  const releases: unknown = await response.json()
  if (!Array.isArray(releases)) return undefined

  return releases
    .filter(isGitHubRelease)
    .flatMap((release) => (release.prerelease ? (release.assets ?? []) : []))
    .find((asset) => asset.name === assetName)?.browser_download_url
}

export async function GET({ params: { platform, channel } }: APIEvent) {
  const assetName = channel === "stable" || channel === "beta" ? assetNames[platform] : undefined
  if (!assetName) return new Response(null, { status: 404 })

  const url =
    channel === "stable" ? `https://github.com/${repo}/releases/latest/download/${assetName}` : await latestBetaAssetUrl(assetName)
  if (!url) return new Response(null, { status: 404 })

  const resp = await fetch(url, cachedRequest())

  const downloadName = downloadNames[platform]

  const headers = new Headers(resp.headers)
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}
