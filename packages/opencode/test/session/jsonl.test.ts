import { test, expect, describe } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Jsonl } from "../../src/session/jsonl"

async function tmpfile(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-jsonl-test-"))
  const file = path.join(dir, "data.jsonl")
  await fs.writeFile(file, content)
  return {
    file,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function collect(file: string) {
  const out: string[] = []
  for await (const line of Jsonl.lines(file)) out.push(line)
  return out
}

describe("Jsonl.lines", () => {
  test("yields the same lines as String.split", async () => {
    const content = ["{}", '{"a":1}', "", "last"].join("\n")
    await using tmp = await tmpfile(content)
    expect(await collect(tmp.file)).toEqual(content.split("\n"))
  })

  test("handles a trailing newline without emitting a phantom line", async () => {
    await using tmp = await tmpfile('{"a":1}\n{"b":2}\n')
    expect(await collect(tmp.file)).toEqual(['{"a":1}', '{"b":2}'])
  })

  test("yields lines longer than the stream chunk size intact", async () => {
    // fs.ReadStream default highWaterMark is 64KB; make one line span multiple chunks.
    const long = '{"text":"' + "x".repeat(256 * 1024) + '"}'
    await using tmp = await tmpfile(`${long}\n{"tail":true}\n`)
    const lines = await collect(tmp.file)
    expect(lines).toEqual([long, '{"tail":true}'])
    expect(JSON.parse(lines[0]).text.length).toBe(256 * 1024)
  })

  test("preserves CRLF carriage returns for the caller to trim", async () => {
    await using tmp = await tmpfile('{"a":1}\r\n{"b":2}\r\n')
    expect(await collect(tmp.file)).toEqual(['{"a":1}\r', '{"b":2}\r'])
  })

  test("does not split multi-byte UTF-8 characters across chunks", async () => {
    // 3-byte CJK chars at a size that guarantees chunk boundaries land mid-character.
    const cjk = "汉".repeat(64 * 1024)
    await using tmp = await tmpfile(`${cjk}\n`)
    expect(await collect(tmp.file)).toEqual([cjk])
  })

  test("empty file yields nothing", async () => {
    await using tmp = await tmpfile("")
    expect(await collect(tmp.file)).toEqual([])
  })
})

describe("Jsonl.maxImportFileBytes", () => {
  test("defaults to 512MB when unset or blank", () => {
    expect(Jsonl.maxImportFileBytes(undefined)).toBe(Jsonl.DEFAULT_MAX_IMPORT_FILE_BYTES)
    expect(Jsonl.maxImportFileBytes("")).toBe(Jsonl.DEFAULT_MAX_IMPORT_FILE_BYTES)
    expect(Jsonl.maxImportFileBytes("  ")).toBe(Jsonl.DEFAULT_MAX_IMPORT_FILE_BYTES)
  })

  test("accepts a numeric override in bytes", () => {
    expect(Jsonl.maxImportFileBytes("1048576")).toBe(1048576)
  })

  test("0 disables the guard", () => {
    expect(Jsonl.maxImportFileBytes("0")).toBe(0)
  })

  test("falls back to the default on garbage or negative values", () => {
    expect(Jsonl.maxImportFileBytes("not-a-number")).toBe(Jsonl.DEFAULT_MAX_IMPORT_FILE_BYTES)
    expect(Jsonl.maxImportFileBytes("-5")).toBe(Jsonl.DEFAULT_MAX_IMPORT_FILE_BYTES)
  })
})
