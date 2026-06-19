import z from "zod"

/**
 * 自动化任务调度器数据结构
 */

export const AutomationTask = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    schedule: z.string().describe("cron 表达式或间隔描述（如 '5m', '1h'）"),
    skill: z.string().describe("调用的技能名称"),
    enabled: z.boolean().default(true),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    timeout: z.number().int().positive().optional().describe("超时时间（毫秒）"),
    retries: z.number().int().min(0).max(5).default(0),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .meta({
    ref: "AutomationTask",
  })

export type AutomationTask = z.infer<typeof AutomationTask>

export const WorkItem = z
  .object({
    id: z.string(),
    type: z.enum(["ci_failure", "issue", "commit", "custom"]),
    source: z.string().describe("来源标识"),
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    metadata: z.record(z.string(), z.string()).optional(),
    discovered_at: z.number().int().positive(),
  })
  .meta({
    ref: "WorkItem",
  })

export type WorkItem = z.infer<typeof WorkItem>

export const AutomationResult = z
  .object({
    task_id: z.string(),
    task_name: z.string().optional(),
    skill: z.string().optional(),
    work_item_id: z.string().optional(),
    status: z.enum(["success", "failure", "timeout", "skipped"]),
    output: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().int().positive(),
    executed_at: z.number().int().positive(),
  })
  .meta({
    ref: "AutomationResult",
  })

export type AutomationResult = z.infer<typeof AutomationResult>

export const AutomationConfig = z
  .object({
    enabled: z.boolean().default(true),
    max_concurrent: z.number().int().min(1).max(10).default(3),
    default_timeout: z.number().int().positive().default(300000),
    retry_delay: z.number().int().positive().default(5000),
    work_discovery_interval: z.number().int().positive().default(300000),
    ci_monitoring: z.boolean().default(true),
    issue_monitoring: z.boolean().default(true),
    commit_monitoring: z.boolean().default(true),
  })
  .meta({
    ref: "AutomationConfig",
  })

export type AutomationConfig = z.infer<typeof AutomationConfig>
