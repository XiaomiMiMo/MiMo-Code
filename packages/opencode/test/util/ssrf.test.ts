import { describe, expect, test } from "bun:test"
import { assertSafeUrl } from "../../src/util/ssrf"

describe("assertSafeUrl", () => {
  describe("blocks private IPv4", () => {
    test.each(["http://10.0.0.1/", "http://10.255.255.255/"])("blocks 10.x: %s", async (url) => {
      await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
    })

    test.each(["http://172.16.0.1/", "http://172.31.255.255/"])("blocks 172.16-31.x: %s", async (url) => {
      await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
    })

    test.each(["http://192.168.0.1/", "http://192.168.255.255/"])("blocks 192.168.x: %s", async (url) => {
      await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
    })

    test.each(["http://169.254.0.1/", "http://169.254.169.254/"])("blocks link-local: %s", async (url) => {
      await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
    })

    test("blocks CGN range", async () => {
      await expect(assertSafeUrl("http://100.64.0.1/")).rejects.toThrow("SSRF protection")
      await expect(assertSafeUrl("http://100.100.100.200/")).rejects.toThrow("SSRF protection")
    })
  })

  describe("blocks metadata hostnames", () => {
    test.each(["http://metadata.google.internal/", "http://metadata.goog/", "http://kubernetes.default.svc/"])(
      "blocks %s",
      async (url) => {
        await expect(assertSafeUrl(url)).rejects.toThrow("SSRF protection")
      },
    )
  })

  describe("blocks IPv6", () => {
    test("blocks link-local", async () => {
      await expect(assertSafeUrl("http://[fe80::1]/")).rejects.toThrow("SSRF protection")
    })

    test("blocks ULA", async () => {
      await expect(assertSafeUrl("http://[fd00::1]/")).rejects.toThrow("SSRF protection")
      await expect(assertSafeUrl("http://[fc00::1]/")).rejects.toThrow("SSRF protection")
    })

    test("blocks IPv4-mapped private IPs (hex form)", async () => {
      // ::ffff:c0a8:101 = 192.168.1.1
      await expect(assertSafeUrl("http://[::ffff:c0a8:101]/")).rejects.toThrow("SSRF protection")
      // ::ffff:a9fe:a9fe = 169.254.169.254
      await expect(assertSafeUrl("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow("SSRF protection")
    })
  })

  describe("allows loopback (CLI tool use case)", () => {
    test("allows 127.0.0.1", async () => {
      await expect(assertSafeUrl("http://127.0.0.1:3000/")).resolves.toBeUndefined()
    })

    test("allows localhost", async () => {
      await expect(assertSafeUrl("http://localhost:8080/")).resolves.toBeUndefined()
    })
  })

  describe("allows public IPs", () => {
    test("allows non-private IPv4", async () => {
      await expect(assertSafeUrl("http://8.8.8.8/")).resolves.toBeUndefined()
      await expect(assertSafeUrl("http://172.32.0.1/")).resolves.toBeUndefined()
      await expect(assertSafeUrl("http://93.184.216.34/")).resolves.toBeUndefined()
    })
  })

  describe("DNS fail-closed", () => {
    test("rejects unresolvable hostnames", async () => {
      await expect(assertSafeUrl("http://this-domain-definitely-does-not-exist-xyz123.invalid/")).rejects.toThrow(
        "SSRF protection: DNS resolution failed",
      )
    })
  })
})
