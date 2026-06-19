import z from "zod"

/**
 * @deprecated AgentRole/PredefinedRoles/PredefinedTeams are placeholder implementations.
 * Not used in the main execution flow. Planned for removal or redesign.
 * The actual multi-agent coordination is handled by the actor tool and agent prompt system.
 */

export const AgentRole = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    reasoning: z.enum(["low", "medium", "high", "max"]).default("medium"),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    permissions: z
      .object({
        tools: z.array(z.string()).optional(),
        directories: z.array(z.string()).optional(),
        commands: z.array(z.string()).optional(),
      })
      .optional(),
    responsibilities: z.array(z.string()),
    constraints: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .meta({
    ref: "AgentRole",
  })

export type AgentRole = z.infer<typeof AgentRole>

export const PredefinedRoles = {
  writer: {
    name: "writer",
    description: "负责实现代码的代理角色",
    reasoning: "medium",
    responsibilities: ["根据需求实现代码", "编写单元测试", "更新相关文档"],
    constraints: ["不进行代码审查", "不直接修改配置文件"],
  } satisfies AgentRole,

  reviewer: {
    name: "reviewer",
    description: "负责代码审查的代理角色",
    reasoning: "high",
    responsibilities: ["审查代码质量", "检查安全漏洞", "验证测试覆盖"],
    constraints: ["不直接修改代码", "只提供建议和反馈"],
  } satisfies AgentRole,

  explorer: {
    name: "explorer",
    description: "负责代码探索和研究的代理角色",
    reasoning: "low",
    responsibilities: ["快速查找文件和代码", "分析代码结构", "提供上下文信息"],
    constraints: ["只读操作", "不修改任何文件"],
  } satisfies AgentRole,

  architect: {
    name: "architect",
    description: "负责设计和架构决策的代理角色",
    reasoning: "max",
    responsibilities: ["设计系统架构", "制定技术方案", "评估技术选型"],
    constraints: ["不直接实现代码", "只提供设计方案"],
  } satisfies AgentRole,

  debugger: {
    name: "debugger",
    description: "负责问题诊断和修复的代理角色",
    reasoning: "high",
    responsibilities: ["分析错误日志", "定位问题根源", "提出修复方案"],
    constraints: ["需要完整的错误信息", "优先考虑最小修复"],
  } satisfies AgentRole,
} satisfies Record<string, AgentRole>

export const AgentTeam = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    roles: z.array(AgentRole),
    workflow: z
      .object({
        mode: z.enum(["parallel", "sequential", "conditional"]).default("sequential"),
        conditions: z
          .array(
            z.object({
              role: z.string(),
              condition: z.string(),
              next_roles: z.array(z.string()),
            }),
          )
          .optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .meta({
    ref: "AgentTeam",
  })

export type AgentTeam = z.infer<typeof AgentTeam>

export const PredefinedTeams = {
  codeReview: {
    name: "code-review",
    description: "代码审查团队，包含编写者和检查者",
    roles: [PredefinedRoles.writer, PredefinedRoles.reviewer],
    workflow: {
      mode: "sequential",
    },
  } satisfies AgentTeam,

  debugging: {
    name: "debugging",
    description: "问题诊断团队，包含探索者和调试者",
    roles: [PredefinedRoles.explorer, PredefinedRoles.debugger],
    workflow: {
      mode: "sequential",
    },
  } satisfies AgentTeam,

  architecture: {
    name: "architecture",
    description: "架构设计团队，包含探索者和架构师",
    roles: [PredefinedRoles.explorer, PredefinedRoles.architect],
    workflow: {
      mode: "sequential",
    },
  } satisfies AgentTeam,
} satisfies Record<string, AgentTeam>
