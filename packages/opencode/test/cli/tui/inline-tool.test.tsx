/**
 * @file InlineTool / GenericTool 空格渲染测试
 *
 * 验证：
 * 1. `input()` 格式化函数输出正确
 * 2. 源码中 GenericTool / PlanExit 的 children 包含前导空格
 * 3. 其他使用 InlineTool 的组件不受影响
 *
 * 注：opentui 渲染器不暴露文本内容提取 API，
 *     因此 UI 渲染层的验证通过源码结构检查 + 类型检查 + 手动测试覆盖。
 */
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

// ── input() 格式化函数（从 session/index.tsx 提取） ──────────────
function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

describe("input() formatter", () => {
  test("formats memory search args correctly", () => {
    const result = input({
      operation: "search",
      query: "个人设定 偏好 风格 规范 习惯",
      scope: "global",
    })
    expect(result).toBe("[operation=search, query=个人设定 偏好 风格 规范 习惯, scope=global]")
  })

  test("formats simple string args", () => {
    const result = input({ pattern: "*.ts" })
    expect(result).toBe("[pattern=*.ts]")
  })

  test("omits specified keys", () => {
    const result = input({ operation: "search", query: "test", scope: "global" }, ["scope"])
    expect(result).toBe("[operation=search, query=test]")
  })

  test("returns empty string for no primitives", () => {
    const result = input({ nested: { key: "value" } })
    expect(result).toBe("")
  })
})

// ── 源码结构验证 ──────────────────────────────────────────────────
const SESSION_FILE = path.resolve(__dirname, "../../../src/cli/cmd/tui/routes/session/index.tsx")

function getSessionSource(): string {
  return fs.readFileSync(SESSION_FILE, "utf-8")
}

describe("GenericTool source code spacing", () => {
  let source: string

  test("session/index.tsx should be readable", () => {
    source = getSessionSource()
    expect(source.length).toBeGreaterThan(0)
  })

  test("GenericTool children should have leading space expression", () => {
    source = source || getSessionSource()

    // 找到 GenericTool 的 InlineTool 调用
    const genericToolMatch = source.match(
      /<InlineTool icon="⚙" pending="Writing command\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(genericToolMatch).not.toBeNull()

    const children = genericToolMatch![1].trim()
    // children 应该以 {" "} 开头
    expect(children).toMatch(/^\{" "\}/)
  })

  test("PlanExit children should have leading space expression", () => {
    source = source || getSessionSource()

    // 找到 PlanExit 的 InlineTool 调用
    const planExitMatch = source.match(
      /<InlineTool icon="⚙" pending="Asking\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(planExitMatch).not.toBeNull()

    const children = planExitMatch![1].trim()
    // children 应该以 {" "} 开头
    expect(children).toMatch(/^\{" "\}/)
  })
})

describe("Other InlineTool components should NOT be affected", () => {
  let source: string

  test("session/index.tsx should be readable", () => {
    source = getSessionSource()
    expect(source.length).toBeGreaterThan(0)
  })

  test("Skill children should NOT have leading space (already has 'Skill ' prefix)", () => {
    source = source || getSessionSource()

    const skillMatch = source.match(
      /<InlineTool icon="→" pending="Loading skill\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(skillMatch).not.toBeNull()

    const children = skillMatch![1].trim()
    // children 应该以 Skill 开头，不带前导 {" "}
    expect(children).toMatch(/^Skill/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Glob children should NOT have leading space (already has 'Glob ' prefix)", () => {
    source = source || getSessionSource()

    const globMatch = source.match(
      /<InlineTool icon="✱" pending="Finding files\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(globMatch).not.toBeNull()

    const children = globMatch![1].trim()
    expect(children).toMatch(/^Glob/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Grep children should NOT have leading space (already has 'Grep ' prefix)", () => {
    source = source || getSessionSource()

    const grepMatch = source.match(
      /<InlineTool icon="✱" pending="Searching content\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(grepMatch).not.toBeNull()

    const children = grepMatch![1].trim()
    expect(children).toMatch(/^Grep/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("WebFetch children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="%" pending="Fetching from the web\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^WebFetch/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Write children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="←" pending="Preparing write\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Write/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Edit children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="←" pending="Preparing edit\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Edit/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Question children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="→" pending="Asking questions\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).toMatch(/^Asked/)
    expect(children).not.toMatch(/^\{" "\}/)
  })

  test("Bash children should NOT have leading space", () => {
    source = source || getSessionSource()

    const match = source.match(
      /<InlineTool icon="\$" pending="Writing command\.\.\."[^>]*>\s*\n\s*([\s\S]*?)\s*<\/InlineTool>/,
    )
    expect(match).not.toBeNull()

    const children = match![1].trim()
    expect(children).not.toMatch(/^\{" "\}/)
  })
})

// ── InlineTool 渲染逻辑验证 ──────────────────────────────────────
describe("InlineTool render logic", () => {
  test("icon and children separated by space in source", () => {
    const source = getSessionSource()

    // 验证 InlineTool 的渲染模板中 icon 和 children 之间有空格
    const renderMatch = source.match(
      /<span style=\{\{ fg: props\.iconColor \}\}>\{props\.icon\}<\/span>\s*\{props\.children\}/,
    )
    expect(renderMatch).not.toBeNull()
  })
})
