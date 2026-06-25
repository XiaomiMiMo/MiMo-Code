import { lookup } from "dns/promises"

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default.svc",
])

const PRIVATE_IPV4_PREFIXES = ["10."]

const PRIVATE_IPV4_RANGES: Array<{ start: number; end: number }> = [
  { start: ip4ToInt("172.16.0.0"), end: ip4ToInt("172.31.255.255") }, // private class B
  { start: ip4ToInt("192.168.0.0"), end: ip4ToInt("192.168.255.255") }, // private class C
]

const BLOCKED_IPV4_PREFIXES = [
  "0.", // current network
]

const BLOCKED_IPV4_RANGES: Array<{ start: number; end: number }> = [
  { start: ip4ToInt("169.254.0.0"), end: ip4ToInt("169.254.255.255") }, // link-local
  { start: ip4ToInt("100.64.0.0"), end: ip4ToInt("100.127.255.255") }, // shared address (CGN)
  { start: ip4ToInt("100.100.100.200"), end: ip4ToInt("100.100.100.200") }, // Alibaba Cloud metadata
]

type SafeUrlOptions = {
  allowPrivateNetwork?: boolean
}

function ip4ToInt(ip: string): number {
  const parts = ip.split(".")
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0
}

function inRanges(ip: string, ranges: Array<{ start: number; end: number }>) {
  const n = ip4ToInt(ip)
  return ranges.some((range) => n >= range.start && n <= range.end)
}

function isPrivateIPv4(ip: string) {
  for (const prefix of PRIVATE_IPV4_PREFIXES) {
    if (ip.startsWith(prefix)) return true
  }
  return inRanges(ip, PRIVATE_IPV4_RANGES)
}

function isBlockedIPv4(ip: string, options: SafeUrlOptions = {}): boolean {
  if (!options.allowPrivateNetwork && isPrivateIPv4(ip)) return true
  for (const prefix of BLOCKED_IPV4_PREFIXES) {
    if (ip.startsWith(prefix)) return true
  }
  return inRanges(ip, BLOCKED_IPV4_RANGES)
}

function isBlockedIPv6(ip: string, options: SafeUrlOptions = {}): boolean {
  const normalized = ip.toLowerCase()
  if (normalized.startsWith("fe80:")) return true // link-local
  if (!options.allowPrivateNetwork && (normalized.startsWith("fc") || normalized.startsWith("fd"))) return true // ULA
  // IPv4-mapped IPv6 in dotted-decimal form (::ffff:a.b.c.d)
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIPv4(mapped[1]!, options)
  // IPv4-mapped IPv6 in hex form (::ffff:HHHH:HHHH) — URL parsers normalize to this
  const hexMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16)
    const lo = parseInt(hexMapped[2]!, 16)
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isBlockedIPv4(ipv4, options)
  }
  return false
}

const MAX_REDIRECTS = 5

export async function safeFetch(
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  await assertSafeUrl(url)
  let currentUrl = url
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const response = await fetchImpl(currentUrl, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) return response
      currentUrl = new URL(location, currentUrl).toString()
      await assertSafeUrl(currentUrl)
      continue
    }
    return response
  }
  throw new Error("SSRF protection: too many redirects")
}

export async function assertSafeUrl(url: string, options: SafeUrlOptions = {}): Promise<void> {
  const parsed = new URL(url)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`SSRF protection: blocked hostname "${hostname}"`)
  }

  // Numeric IPv4 check (before DNS)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIPv4(hostname, options)) {
      throw new Error(`SSRF protection: blocked private/internal IP "${hostname}"`)
    }
    return
  }

  // Numeric IPv6 check (before DNS)
  if (hostname.includes(":")) {
    if (isBlockedIPv6(hostname, options)) {
      throw new Error(`SSRF protection: blocked private/internal IPv6 "${hostname}"`)
    }
    return
  }

  // DNS resolution check to prevent DNS rebinding
  try {
    const { address, family } = await lookup(hostname)
    if (family === 4 && isBlockedIPv4(address, options)) {
      throw new Error(`SSRF protection: hostname "${hostname}" resolves to blocked IP "${address}"`)
    }
    if (family === 6 && isBlockedIPv6(address, options)) {
      throw new Error(`SSRF protection: hostname "${hostname}" resolves to blocked IPv6 "${address}"`)
    }
  } catch (e: any) {
    if (e.message?.startsWith("SSRF protection:")) throw e
    throw new Error(`SSRF protection: DNS resolution failed for "${hostname}"`)
  }
}
