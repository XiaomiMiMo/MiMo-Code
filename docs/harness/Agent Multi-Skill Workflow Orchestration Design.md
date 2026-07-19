# Agent 多 Skill 协同Workflow编排设计

一句话概括：引用多 skill = 用户指定多SKILL和问题，SKILL-Reminder 提示模型创建多SKILL Workflow，最后分解任务落盘解决问题。

## 一、设计出发点

多 skill 场景下，要解决的不再是"要不要用"，而是"怎么协同"

❌ 传统触发问题
harness 需要从 query 语义猜测激活哪些 skill，容易漏触发或误触发。

✅ 显式 /skill 化解
用户在 input 框中直接 /skill-a /skill-b 在 input 框中直写，触发 100% 精确，语义无歧义。

🎯 剩下的挑战
多 skill 之间如何编排：谁先谁后、数据怎么传、冲突怎么裁决。

## 二、三层职责划分

| 层级 | 职责 | 关键动作 | 失败兜底 |
|------|------|---------|---------|
| 用户层 | 显式 / 声明意图 | /skill-a /skill-b 在 input 框中直写 | 不涉及 |
| Harness 层 | 静态检查 + 注入 Reminder | 解析 frontmatter，检测冲突点，生成 targeted 提示 | 降级为通用模板 Reminder |
| 模型层 | 产出结构化工作流 | 读 SKILL.md → 判定组合关系 → 定契约 → 落盘 | Task-Execution drift 由落盘缓解 |

## 三、注入位置与时机

核心决策：Reminder 作为 system-injected 消息附加在 user message 之后（对齐 Anthropic 的 long_conversation_reminder 模式），不改写 system prompt。

为什么放 message 层而不改 system prompt

| 维度 | 改 system prompt | 附在 user message 后（选定方案） |
|------|-----------------|-------------------------------|
| 指令遵循率 | 距离 query 远，遵循率较低 | 靠近 query，遵循率明显更高 |
| Prefix cache 命中率 | 污染前缀，每次内容变都破坏缓存 | 前缀保持稳定，动态内容全部下沉到 message 层 |
| 按需注入 | 难以做到 turn 级条件控制 | 只在 @≥2 skill 的 turn 出现，其他 turn 完全不感知 |

条件触发规则

/ 单个 skill 时不注入 Reminder。

单 skill 场景没有编排问题，强制规划纯粹增加延迟，还会诱发过度规划（简单任务写三段计划）。触发条件必须精确：

- /count == 0 → 不注入
- /count == 1 → 不注入
- /count >= 2 → 注入 Reminder

## 四、Reminder 内容设计

关键是让规划产出结构化且可校验的东西，而不是一段泛泛的"我先做 A 再做 B"。

### Reminder 模板

```
<skill_composition_reminder>
The user has explicitly referenced multiple skills: {skill_names}.
Before starting work, complete an orchestration plan:
1. Read the SKILL.md of every referenced skill FIRST, then plan
   (never plan from skill descriptions alone — the full SKILL.md
   may contain constraints that invalidate an imagined workflow)
2. Classify the composition relationship: pipeline (A's output →
   B's input) / parallel (each handles a separate part) /
   constraint overlay (one does the work, the other provides
   rules or standards)
3. If pipeline: define the interface contract for intermediate
   artifacts — format and file path
4. If two skills give instructions on the same dimension (output
   format / style / process), explicitly declare a conflict
   resolution rule: which skill takes precedence on which dimension
5. Output a concise workflow (phase → skill used → artifact),
   then execute according to it
Keep planning proportional to task complexity: for simple
combinations, two or three sentences suffice.
</skill_composition_reminder>
```

## 五、设计取舍总结

| 取舍点 | 选择 | 放弃的方案 & 原因 |
|--------|------|-------------------|
| 触发方式 | 显式 /skill | 放弃自动语义匹配——不可靠且易过度触发 |
| Reminder 注入位置 | user message 之后 | 放弃改 system prompt——破坏 prefix cache、遵循率低 |
| 触发阈值 | /skill≥2 | 放弃全量注入——单 skill 场景纯增延迟且诱发过度规划 |
| Reminder 内容 | 约束产出结构 | 放弃教具体做法——skill 内容会变，硬编码难以维护 |
| 工作流存储 | 落盘 / Task | 放弃仅存 assistant message——长任务必然稀释丢失 |
| Harness 增强 | 静态预解析冲突 | 放弃让模型自己发现——静态检查更可靠、成本几乎为零 |
