import { describe, expect, test } from "bun:test"
import { powerShellCommandArgs } from "../../src/tool/bash"

describe("PowerShell command encoding", () => {
  test("uses EncodedCommand with a UTF-8 console preamble", () => {
    const args = powerShellCommandArgs('echo "测试中文"')

    expect(args.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"])
    expect(args[3]).toBe("-EncodedCommand")
    expect(args).not.toContain("-Command")

    const decoded = Buffer.from(args[4], "base64").toString("utf16le")
    expect(decoded).toContain("[Console]::InputEncoding")
    expect(decoded).toContain("[Console]::OutputEncoding")
    expect(decoded).toContain("[System.Text.UTF8Encoding]::new($false)")
    expect(decoded).toContain('echo "测试中文"')
  })
})
