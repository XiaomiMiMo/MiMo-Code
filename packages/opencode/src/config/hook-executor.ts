/**
 * Hook 执行器
 *
 * 在 run loop 的特定生命周期点执行用户配置的 hooks。
 * 支持 command/prompt/agent 三种 handler 类型。
 * 当用户未配置 hooks 时，使用默认配置。
 */

import { Effect } from "effect"
import { Log } from "@/util"
import type { HookEvent, HookResult } from "@/config/hooks"
import { DEFAULT_HOOKS, mergeHooks } from "./default-hooks"

const log = Log.create({ service: "hook-executor" })

type HookHandlerConfig = { type: string; command?: string; prompt?: string; timeout?: number }

/**
 * 执行 command 类型的 hook handler
 */
async function executeCommandHandler(
  handler: HookHandlerConfig,
  input: Record<string, unknown>,
): Promise<HookResult> {
  const timeout = (handler.timeout ?? 30) * 1000

  try {
    const proc = Bun.spawn(["bash", "-c", handler.command!], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    const stdin = new TextEncoder().encode(JSON.stringify(input))
    proc.stdin.write(stdin)
    proc.stdin.end()

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

    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        return JSON.parse(result.stdout)
      } catch {
        return { additionalContext: result.stdout.trim() }
      }
    }

    if (result.exitCode === 2) {
      return { blocked: true, blockReason: result.stderr || "Hook blocked action" }
    }

    return {}
  } catch (e) {
    log.warn("command hook failed", { error: String(e) })
    return {}
  }
}

/**
 * 执行 prompt 类型的 hook handler
 */
async function executePromptHandler(
  handler: HookHandlerConfig,
  input: Record<string, unknown>,
): Promise<HookResult> {
  const timeout = (handler.timeout ?? 30) * 1000

  try {
    const evalPrompt = handler.prompt!.replace(/\$ARGUMENTS/g, JSON.stringify(input))

    const proc = Bun.spawn(
      [
        "bash", "-c",
        `echo '${evalPrompt.replace(/'/g, "'\\''")}' | mimo run "Evaluate and return JSON: {\\\"allowed\\\": true/false, \\\"reason\\\": \\\"...\\\"}" 2>/dev/null`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )

    const result = await Promise.race([
      new Promise<{ stdout: string; exitCode: number }>(async (resolve) => {
        const stdout = await new Response(proc.stdout).text()
        const exitCode = (await proc.exitCode) ?? 1
        resolve({ stdout, exitCode })
      }),
      new Promise<{ stdout: string; exitCode: number }>((_, reject) =>
        setTimeout(() => {
          proc.kill()
          reject(new Error("Prompt hook timeout"))
        }, timeout)
      ),
    ])

    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const eval_result = JSON.parse(result.stdout)
        if (eval_result.allowed === false) {
          return { blocked: true, blockReason: eval_result.reason || "Prompt hook denied" }
        }
        if (eval_result.additionalContext) {
          return { additionalContext: eval_result.additionalContext }
        }
      } catch {}
    }

    return {}
  } catch (e) {
    log.warn("prompt hook failed", { error: String(e) })
    return {}
  }
}

/**
 * 执行 agent 类型的 hook handler
 */
async function executeAgentHandler(
  handler: HookHandlerConfig,
  input: Record<string, unknown>,
): Promise<HookResult> {
  const timeout = (handler.timeout ?? 60) * 1000

  try {
    const evalPrompt = handler.prompt!.replace(/\$ARGUMENTS/g, JSON.stringify(input))

    const proc = Bun.spawn(
      [
        "bash", "-c",
        `echo '${evalPrompt.replace(/'/g, "'\\''")}' | mimo run "Verify and return JSON: {\\\"passed\\\": true/false, \\\"findings\\\": [...], \\\"additionalContext\\\": \\\"...\\\"}" 2>/dev/null`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )

    const result = await Promise.race([
      new Promise<{ stdout: string; exitCode: number }>(async (resolve) => {
        const stdout = await new Response(proc.stdout).text()
        const exitCode = (await proc.exitCode) ?? 1
        resolve({ stdout, exitCode })
      }),
      new Promise<{ stdout: string; exitCode: number }>((_, reject) =>
        setTimeout(() => {
          proc.kill()
          reject(new Error("Agent hook timeout"))
        }, timeout)
      ),
    ])

    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const eval_result = JSON.parse(result.stdout)
        if (eval_result.passed === false) {
          const findings = eval_result.findings?.join("\n") || "Agent verification failed"
          return {
            blocked: true,
            blockReason: findings,
            additionalContext: eval_result.additionalContext,
          }
        }
        if (eval_result.additionalContext) {
          return { additionalContext: eval_result.additionalContext }
        }
      } catch {}
    }

    return {}
  } catch (e) {
    log.warn("agent hook failed", { error: String(e) })
    return {}
  }
}

/**
 * 执行单个 hook handler
 */
async function executeHandler(
  handler: HookHandlerConfig,
  input: Record<string, unknown>,
): Promise<HookResult> {
  if (handler.type === "command" && handler.command) {
    return executeCommandHandler(handler, input)
  }
  if (handler.type === "prompt" && handler.prompt) {
    return executePromptHandler(handler, input)
  }
  if (handler.type === "agent" && handler.prompt) {
    return executeAgentHandler(handler, input)
  }
  return {}
}

/**
 * 在指定事件点执行所有匹配的 hooks
 * 自动合并用户配置的 hooks 与默认 hooks
 */
export function executeHooks(
  event: HookEvent,
  userHooksConfig: Record<string, Array<{ matcher?: string; hooks: HookHandlerConfig[] }>> | undefined,
  input: Record<string, unknown>,
  matcherValue?: string,
): Effect.Effect<HookResult, never> {
  return Effect.gen(function* () {
    // 合并用户 hooks 与默认 hooks
    const hooksConfig = mergeHooks(userHooksConfig as any)

    const eventHooks = hooksConfig[event]
    if (!eventHooks || eventHooks.length === 0) return {} as HookResult

    const results: HookResult[] = []

    for (const hookDef of eventHooks) {
      if (hookDef.matcher && matcherValue) {
        const regex = new RegExp(hookDef.matcher)
        if (!regex.test(matcherValue)) continue
      }

      for (const handler of hookDef.hooks) {
        const result = yield* Effect.promise(() => executeHandler(handler, input))
        results.push(result)

        if (result.blocked) {
          log.info("hook blocked action", { event, reason: result.blockReason })
          return result
        }
      }
    }

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
