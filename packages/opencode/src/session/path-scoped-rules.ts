/**
 * 路径作用域指令模块
 *
 * 扫描 .mimocode/rules/ 目录，根据当前文件路径筛选适用的规则。
 * 指令按文件路径模式作用域化，仅当处理匹配文件时才加载相关指令，
 * 减少 context 噪声，节省 token。
 */

import { Effect } from "effect"
import { Glob } from "@mimo-ai/shared/util/glob"
import path from "path"
import { Instance } from "@/project/instance"
import { readFile } from "fs/promises"

/**
 * 路径作用域规则的结构
 */
export interface PathScopedRule {
  /** 规则文件路径 */
  filePath: string
  /** 规则名称（从文件名派生） */
  name: string
  /** 路径模式（glob 格式） */
  paths: string[]
  /** 规则内容 */
  content: string
  /** 优先级（数字越大优先级越高） */
  priority: number
}

/**
 * 解析 frontmatter 中的 paths 字段
 * 支持 YAML frontmatter 格式
 */
function parseFrontmatter(content: string): { paths: string[]; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
  const match = content.match(frontmatterRegex)

  if (!match) {
    return { paths: [], body: content }
  }

  const [, frontmatter, body] = match
  const paths: string[] = []

  // 简单的 YAML 解析，提取 paths 字段
  const lines = frontmatter.split("\n")
  let inPaths = false

  for (const line of lines) {
    if (line.startsWith("paths:")) {
      inPaths = true
      continue
    }

    if (inPaths && line.startsWith("  - ")) {
      const value = line.slice(4).trim().replace(/^["']|["']$/g, "")
      paths.push(value)
    } else if (inPaths && !line.startsWith(" ")) {
      inPaths = false
    }
  }

  return { paths, body }
}

/**
 * 扫描指定目录下的规则文件
 * 支持 .md 文件，递归扫描子目录
 */
export async function scanRules(rulesDir: string): Promise<PathScopedRule[]> {
  const rules: PathScopedRule[] = []

  try {
    const pattern = "**/*.md"
    const matches = Glob.scanSync(pattern, {
      cwd: rulesDir,
      absolute: true,
      dot: true,
      symlink: true,
    })

    for (const match of matches) {
      const content = await readFile(match, "utf-8")
      const { paths, body } = parseFrontmatter(content)
      const name = path.basename(match, ".md")

      rules.push({
        filePath: match,
        name,
        paths,
        content: body,
        priority: paths.length > 0 ? 1 : 0, // 有路径作用域的规则优先级更高
      })
    }
  } catch {
    // 目录不存在或无法读取，返回空规则列表
  }

  return rules
}

/**
 * 根据当前工作目录和文件路径，筛选适用的规则
 */
export function filterRulesByPath(
  rules: PathScopedRule[],
  currentFile?: string,
): PathScopedRule[] {
  if (!currentFile) {
    // 没有指定文件时，仅返回无路径作用域的规则
    return rules.filter((r) => r.paths.length === 0)
  }

  return rules.filter((r) => {
    // 无路径作用域的规则始终适用
    if (r.paths.length === 0) return true

    // 检查文件是否匹配任一路径模式
    return r.paths.some((pattern) => Glob.match(pattern, currentFile))
  })
}

/**
 * 将规则格式化为 context 注入格式
 */
export function formatRulesForPrompt(rules: PathScopedRule[]): string {
  if (rules.length === 0) return ""

  const lines: string[] = ["# Path-Specific Rules (loaded based on files being worked on):"]

  for (const rule of rules) {
    lines.push("")
    lines.push(`## ${rule.name}`)
    if (rule.paths.length > 0) {
      lines.push(`Applies to: ${rule.paths.join(", ")}`)
    }
    lines.push(rule.content)
  }

  return lines.join("\n")
}

/**
 * 生成规则摘要，用于初始 context 注入
 * 仅包含规则名称和适用路径，不包含完整内容
 */
export function generateRulesSummary(rules: PathScopedRule[]): string {
  if (rules.length === 0) return ""

  const lines: string[] = ["Available path-scoped rules (loaded on demand):"]

  for (const rule of rules) {
    const paths = rule.paths.length > 0 ? ` → ${rule.paths.join(", ")}` : " → all files"
    lines.push(`- ${rule.name}${paths}`)
  }

  return lines.join("\n")
}
