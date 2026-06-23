import { lookup } from "dns/promises"

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default.svc",
])

const BLOCKED_IPV4_PREFIXES = [
  "127.", // loopback
  "10.", // private class A
  "0.", // current network
]

const BLOCKED_IPV4_RANGES: Array<{ start: number; end: number }> = [
  { start: ip4ToInt("172.16.0.0"), end: ip4ToInt("172.31.255.255") }, // private class B
  { start: ip4ToInt("192.168.0.0"), end: ip4ToInt("192.168.255.255") }, // private class C
  { start: ip4ToInt("169.254.0.0"), end: ip4ToInt("169.254.255.255") }, // link-local
  { start: ip4ToInt("100.64.0.0"), end: ip4ToInt("100.127.255.255") }, // shared address (CGN)
  { start: ip4ToInt("100.100.100.200"), end: ip4ToInt("100.100.100.200") }, // Alibaba Cloud metadata
]

function ip4ToInt(ip: string): number {
  const parts = ip.split(".")
  return ((+parts[0]! << 24) | (+parts[1]! << 16) | (+parts[2]! << 8) | +parts[3]!) >>> 0
}

function isBlockedIPv4(ip: string): boolean {
  for (const prefix of BLOCKED_IPV4_PREFIXES) {
    if (ip.startsWith(prefix)) return true
  }
  const n = ip4ToInt(ip)
  for (const range of BLOCKED_IPV4_RANGES) {
    if (n >= range.start && n <= range.end) return true
  }
  return false
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === "::1") return true
  if (normalized.startsWith("fe80:")) return true // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true // ULA
  if (normalized === "::ffff:127.0.0.1") return true
  // IPv4-mapped IPv6 — extract the IPv4 portion
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIPv4(mapped[1]!)
  return false
}

export async function assertSafeUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "")

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`SSRF protection: blocked hostname "${hostname}"`)
  }

  // Numeric IPv4 check (before DNS)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isBlockedIPv4(hostname)) {
      throw new Error(`SSRF protection: blocked private/internal IP "${hostname}"`)
    }
    return
  }

  // Numeric IPv6 check (before DNS)
  if (hostname.includes(":")) {
    if (isBlockedIPv6(hostname)) {
      throw new Error(`SSRF protection: blocked private/internal IPv6 "${hostname}"`)
    }
    return
  }

  // DNS resolution check to prevent DNS rebinding
  try {
    const { address, family } = await lookup(hostname)
    if (family === 4 && isBlockedIPv4(address)) {
      throw new Error(`SSRF protection: hostname "${hostname}" resolves to blocked IP "${address}"`)
    }
    if (family === 6 && isBlockedIPv6(address)) {
      throw new Error(`SSRF protection: hostname "${hostname}" resolves to blocked IPv6 "${address}"`)
    }
  } catch (e: any) {
    if (e.message?.startsWith("SSRF protection:")) throw e
    // DNS resolution failed — allow the request to proceed (will fail at fetch time)
  }
}
