import { test, expect } from "bun:test"
import * as ProviderError from "@/provider/error"

/**
 * Regression lock: shape-based transport classification must keep covering
 * every entry that used to live in RETRYABLE_NETWORK_CODES / RETRYABLE_NETWORK_MESSAGES
 * (origin/main before the recoverable-persistent rewrite). If a deny-list or
 * pattern change drops any of these, recoverable network errors will fall out of
 * kind=network and stop using persistent budgets.
 */
const LEGACY_NETWORK_CODES = [
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  "ENETDOWN",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_ABORTED",
  "UND_ERR_SOCKET",
] as const

const LEGACY_NETWORK_MESSAGES = [
  "fetch failed",
  "SSE read timed out",
  "connection aborted",
  "connection closed",
  "connection refused",
  "connection reset",
  "connection closed by server",
  "network connection",
  "network error",
  "response body terminated",
  "response body closed",
  "socket hang up",
] as const

test("shape classification covers every legacy RETRYABLE_NETWORK_CODES entry", () => {
  for (const code of LEGACY_NETWORK_CODES) {
    expect(ProviderError.isTransportErrnoCode(code), `code ${code}`).toBe(true)
    const err = Object.assign(new Error("x"), { code })
    expect(ProviderError.isRetryableNetworkError(err), `retry ${code}`).toBe(true)
  }
})

test("message patterns cover every legacy RETRYABLE_NETWORK_MESSAGES sample", () => {
  for (const message of LEGACY_NETWORK_MESSAGES) {
    expect(ProviderError.isRetryableNetworkError(new Error(message)), `msg ${message}`).toBe(true)
  }
})

test("ENOTFOUND is network (gap in the legacy allow-list)", () => {
  const dns = Object.assign(new Error("Cannot connect to API: getaddrinfo ENOTFOUND x.srv"), { code: "ENOTFOUND" })
  expect(ProviderError.isTransportErrnoCode("ENOTFOUND")).toBe(true)
  expect(ProviderError.isRetryableNetworkError(dns)).toBe(true)
})

test("local fs/process errno stay non-transport", () => {
  for (const code of ["ENOENT", "EACCES", "EPERM", "EINVAL", "ENOSPC"] as const) {
    expect(ProviderError.isTransportErrnoCode(code)).toBe(false)
  }
})
