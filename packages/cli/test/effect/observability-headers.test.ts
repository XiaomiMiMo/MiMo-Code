import { describe, expect, test } from "bun:test"
import { parseOtlpHeaders } from "../../src/effect/otlp-headers"

describe("parseOtlpHeaders", () => {
  test("trims whitespace around entries, keys, and values", () => {
    expect(parseOtlpHeaders("Authorization=Bearer abc, X-Tenant=prod ")).toEqual({
      Authorization: "Bearer abc",
      "X-Tenant": "prod",
    })
  })

  test("skips entries without '='", () => {
    expect(parseOtlpHeaders("a=1,broken,c=2")).toEqual({ a: "1", c: "2" })
  })

  test("skips entries with an empty key", () => {
    expect(parseOtlpHeaders("=x,a=1")).toEqual({ a: "1" })
  })

  test("keeps '=' inside values", () => {
    expect(parseOtlpHeaders("a=b=c")).toEqual({ a: "b=c" })
  })

  test("returns an empty record for empty or whitespace-only input", () => {
    expect(parseOtlpHeaders("")).toEqual({})
    expect(parseOtlpHeaders(" , , ")).toEqual({})
  })
})
