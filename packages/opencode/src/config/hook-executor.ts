/**
 * Hook 执行器
 *
 * 在 run loop 的特定生命周期点执行用户配置的 hooks。
 * 参考 Claude Code 的 hook 执行机制，但适配 MiMoCode 的 Effect 架构。
 */

import { Effect } from "effect"
import { Log } from "@/util"
import type { HookEvent, HookDefinition, HookResult } from "@/config/hooks"

const log = Log.create({ service: "hook-executor" })

/**
 * 执行单个 hook handler
 */
async function executeHandler(
  handler: { type: string; command?: string; prompt?: string; timeout?: number },
  input: Record<string, unknown>,
): Promise<HookResult> {
  const timeout = (handler.timeout ?? 30) * 1000

  if (handler.type === "command" && handler.command) {
    try {
      const proc = Bun.spawn(["bash", "-c", handler.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      // 写入 stdin
      const stdin = new TextEncoder().encode(JSON.stringify(input))
      proc.stdin.write(stdin)
      proc.stdin.end()

      // 等待完成
      const result = await Promise.race([
        new Promise<{ stdout: string; stderr: string; exitCode: number }>(async (resolve) => {
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          const exitCode = (await proc.exitCode) ?? 1
          resolve({ stdout, stderr, exitCode })
        }),
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) =>
          setTimeout(() => {
            proc.kill()
            reject(new Error("Hook timeout"))
          }, timeout)
        ),
      ])

      // 解析 stdout 为 JSON
      if (result.exitCode === 0 && result.stdout.trim()) {
        try {
          return JSON.parse(result.stdout)
        } catch {
          // stdout 不是 JSON，作为 additionalContext 返回
          return { additionalContext: result.stdout.trim() }
        }
      }

      // exit code 2 = 阻止
      if (result.exitCode === 2) {
        return { blocked: true, blockReason: result.stderr || "Hook blocked action" }
      }

      return {}
    } catch (e) {
      log.warn("hook execution failed", { error: String(e) })
      return {}
    }
  }

  // prompt 类型：单轮 Claude 评估（简化实现）
  if (handler.type === "prompt" && handler.prompt) {
    // TODO: 集成 LLM 调用
    log.info("prompt hook not yet implemented", { prompt: handler.prompt })
    return {}
  }

  // agent 类型：子 agent 验证（简化实现）
  if (handler.type === "agent" && handler.prompt) {
    // TODO: 集成 actor tool
    log.info("agent hook not yet implemented", { prompt: handler.prompt })
    return {}
  }

  return {}
}

/**
 * 在指定事件点执行所有匹配的 hooks
 */
export function executeHooks(
  event: HookEvent,
  hooksConfig: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command?: string; timeout?: number }> }>> | undefined,
  input: Record<string, unknown>,
  matcherValue?: string,
): Effect.Effect<HookResult, never> {
  return Effect.gen(function* () {
    if (!hooksConfig) return {} as HookResult

    const eventHooks = hooksConfig[event]
    if (!eventHooks || eventHooks.length === 0) return {} as HookResult

    const results: HookResult[] = []

    for (const hookDef of eventHooks) {
      // 检查 matcher
      if (hookDef.matcher && matcherValue) {
        const regex = new RegExp(hookDef.matcher)
        if (!regex.test(matcherValue)) continue
      }

      // 执行每个 handler
      for (const handler of hookDef.hooks) {
        const result = yield* Effect.promise(() => executeHandler(handler, input))
        results.push(result)

        // 如果被阻止，立即返回
        if (result.blocked) {
          log.info("hook blocked action", { event, reason: result.blockReason })
          return result
        }
      }
    }

    // 合并所有 additionalContext
    const additionalContext = results
      .filter((r) => r.additionalContext)
      .map((r) => r.additionalContext)
      .join("\n")

    return {
      additionalContext: additionalContext || undefined,
      updatedInput: results.find((r) => r.updatedInput)?.updatedInput,
      updatedOutput: results.find((r) => r.updatedOutput)?.updatedOutput,
    }
  })
}
