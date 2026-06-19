#!/usr/bin/env bun
/**
 * validate-instructions.ts — 指令冲突自动检测
 *
 * 扫描所有系统提示词文件，检测已知的规则冲突模式（C1-C9）。
 * 每次修改 prompt 文件后运行，防止引入新的指令矛盾。
 *
 * 用法:
 *   bun run packages/opencode/script/validate-instructions.ts
 */

import { readdirSync, readFileSync, existsSync } from "fs"
import { join } from "path"

const PROMPT_DIR = join(import.meta.dirname, "..", "src", "session", "prompt")

/** 一条冲突规则定义 */
interface ConflictPair {
  id: string
  description: string
  /** 子串 A 必须匹配到的规则文本（大小写不敏感） */
  patternA: RegExp
  /** 子串 B 必须匹配到的规则文本 */
  patternB: RegExp
  /** 允许出现在同一文件中的冲突（跨文件冲突才报） */
  crossFileOnly?: boolean
}

/** 所有已知冲突对 */
const CONFLICT_PAIRS: ConflictPair[] = [
  {
    id: "C1",
    description: "注释规则矛盾: '禁止注释' vs '注释必须用特定语言'",
    patternA: /\bdo not\s+add\s+comments\b/i,
    patternB: /(comments?\s+(must|should|shall)|(code\s+)?comment|注释)/i,
  },
  {
    id: "C2",
    description: "输出风格矛盾: '1-3句简洁' vs '必须详细分析'",
    patternA: /\b1-3\s+sentences?\b/,
    // patternB should match rules demanding verbose output, not research rules
    patternB: /(output\s+must\s+be\s+detailed|详细分析|必须.*分析.*输出|describe\s+(every|each|all)\s+step)/i,
  },
  {
    id: "C3",
    description: "错误处理矛盾: '禁止错误处理' vs '需要防御性处理'",
    patternA: /\bdo not\s+add\s+error\s+handling\b/i,
    patternB: /(defensive|error\s+handling|fallbacks?|validation|boundar)/i,
  },
  {
    id: "C4",
    description: "功能范围矛盾: '禁止额外功能' vs '必须完成全部占位符'",
    // Only match UNQUALIFIED "do not add features" (without scope carve-out)
    patternA: /\bdo not\s+add\s+features\b(?!\s+beyond)/i,
    patternB: /\b(placeholder|stub|complete.*impl|完善.*占位)/i,
  },
  {
    id: "C5",
    description: "抽象原则矛盾: '三行胜过抽象' vs 'DRY/SOLID'",
    patternA: /\bthree\s+similar\s+lines\s+are\s+better\b/i,
    patternB: /\bDRY\b|不要重复|don't\s+repeat/i,
  },
  {
    id: "C6",
    description: "文件创建矛盾: '禁止创建文件' vs '必须生成验证报告'",
    patternA: /\bdo not\s+create\s+files?\b/i,
    patternB: /(verification.report|context.summary|operations.log|审查|验证|报告)/i,
  },
  {
    id: "C7",
    description: "向后兼容矛盾: '禁止向前兼容代码' vs '提供回滚方案'",
    patternA: /\bdo not\s+add\s+backw/,
    patternB: /(rollback|migration\s+step|回滚|迁移)/i,
  },
  {
    id: "C8",
    description: "语言优先级矛盾: '跟随用户语言' vs '强制使用中文'",
    patternA: /follow\s+the\s+same\s+major\s+language/i,
    patternB: /(强制|simplified\s+chinese|简体中文|必须使用.*中文)/i,
  },
]

interface FileResult {
  file: string
  matchedPatterns: string[]
  warnings: string[]
  errors: string[]
}

function scanFile(filePath: string): FileResult {
  const content = readFileSync(filePath, "utf-8")
  const basename = filePath.split("/").pop() ?? filePath
  const matched: string[] = []
  const warnings: string[] = []
  const errors: string[] = []

  for (const pair of CONFLICT_PAIRS) {
    const hasA = pair.patternA.test(content)
    const hasB = pair.patternB.test(content)

    if (hasA) matched.push(`${pair.id}A`)
    if (hasB) matched.push(`${pair.id}B`)

    if (hasA && hasB && !pair.crossFileOnly) {
      errors.push(`[${pair.id}] ${pair.description}`)
    } else if (hasA && hasB && pair.crossFileOnly) {
      warnings.push(`[${pair.id}] ${pair.description} (允许同文件，需跨文件检查)`)
    }
  }

  return { file: basename, matchedPatterns: matched, warnings, errors }
}

function main(): number {
  const files = readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".txt"))

  if (!files.length) {
    console.error(`❌ 未在 ${PROMPT_DIR} 中找到 .txt 文件`)
    return 1
  }

  console.log(`\n📋 扫描 ${files.length} 个提示词文件中的已知冲突...\n`)

  const results: FileResult[] = []
  let totalErrors = 0
  let totalWarnings = 0

  for (const file of files) {
    const result = scanFile(join(PROMPT_DIR, file))
    results.push(result)
  }

  // 输出每个文件的匹配情况
  for (const r of results) {
    if (r.matchedPatterns.length > 0) {
      console.log(`  ${r.file.padEnd(25)} ${r.matchedPatterns.join(", ")}`)
    }
    if (r.errors.length > 0) {
      totalErrors += r.errors.length
      for (const e of r.errors) {
        console.error(`  ❌ ${r.file}: ${e}`)
      }
    }
    if (r.warnings.length > 0) {
      totalWarnings += r.warnings.length
      for (const w of r.warnings) {
        console.warn(`  ⚠️  ${r.file}: ${w}`)
      }
    }
  }

  // 跨文件冲突检查: 检查 C8 在 prompt 文件和 CLAUDE.md 之间
  const projectClaudeMd = join(import.meta.dirname, "..", "..", "..", "..", "CLAUDE.md")
  if (existsSync(projectClaudeMd)) {
    const claudeContent = readFileSync(projectClaudeMd, "utf-8")
    const hasChineseRule = /简体中文|必须使用.*中文/.test(claudeContent)
    for (const r of results) {
      if (r.matchedPatterns.includes("C8A") && hasChineseRule) {
        const c8Warn = `[C8] 语言优先级矛盾 (跨文件): ${r.file} 说"跟随用户语言", CLAUDE.md 说"强制中文"`
        r.warnings.push(c8Warn)
        r.errors.push(c8Warn)
        totalErrors++
        console.error(`  ❌ ${r.file}: ${c8Warn}`)
      }
    }
  }

  console.log(
    `\n${totalErrors > 0 ? "❌" : "✅"} 发现 ${totalErrors} 个冲突, ${totalWarnings} 个警告`,
  )

  return totalErrors > 0 ? 1 : 0
}

process.exit(main())
