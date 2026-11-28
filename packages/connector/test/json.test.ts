import { describe, expect, test } from "bun:test"
import { parseObject } from "../src/json"

// connect-protocol [TP-R63-07]: strict wire lexing, including extension fields.
describe("Connect wire JSON", () => {
  test.each([
    ["duplicate decoded keys", '{"extra":{"é":1,"\\u00e9":2}}'],
    ["duplicate decoded supplementary characters", '{"😀":1,"\\ud83d\\ude00":2}'],
    ["a fractional token", '{"extra":3.0}'],
    ["an exponent token", '{"extra":1e0}'],
    ["a negative number", '{"extra":-1}'],
    ["negative zero", '{"extra":-0}'],
    ["an unsafe integer", '{"extra":9007199254740992}'],
    ["a leading zero", '{"extra":01}'],
    ["an unpaired surrogate", '{"extra":"\\uD800"}'],
    ["trailing content", '{"extra":1} {}'],
    ["a trailing array comma", '{"extra":[1,]}'],
    ["non-JSON whitespace", '{ "extra":1}'],
  ])("rejects %s", (_case, text) => {
    expect(() => parseObject(text)).toThrow(SyntaxError)
  })

  test("accepts nested objects with independently scoped keys and plain integer lexemes", () => {
    expect(parseObject(' \t\r\n{"a":[{"a":0},{"a":9007199254740991}],"key":"\\ud83d\\ude00"} \r\n')).toEqual({
      a: [{ a: 0 }, { a: Number.MAX_SAFE_INTEGER }],
      key: "😀",
    })
  })
})
