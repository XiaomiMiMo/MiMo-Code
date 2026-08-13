# RL Training Mode 分支改动说明

本文记录 `feat/rl-training-mode` 分支相对其 `main` 基线的主要改动，以及对应的 GitHub Pull Request 信息。

## 分支与 PR 信息

| 项目 | 内容 |
| --- | --- |
| 分支 | [`feat/rl-training-mode`](https://github.com/XiaomiMiMo/MiMo-Code/tree/feat/rl-training-mode) |
| 目标分支 | `main` |
| PR | [#1939 feat(rl): make training runs deterministic](https://github.com/XiaomiMiMo/MiMo-Code/pull/1939) |
| PR 状态 | Closed，未合并 |
| PR 作者 | [MiMoHardFather](https://github.com/MiMoHardFather) |
| 创建时间 | 2026-07-27 11:36:21 UTC |
| 关闭时间 | 2026-07-27 11:36:41 UTC |
| 唯一提交 | [`3544de8faf055d8eef9582fb063134b34443ff88`](https://github.com/XiaomiMiMo/MiMo-Code/commit/3544de8faf055d8eef9582fb063134b34443ff88) |
| 提交标题 | `feat(rl): make training runs deterministic` |

PR 描述给出的三个目标是：

- 关闭辅助模型侧通道和模型请求重试；
- 在不同回合之间保留历史工具结果；
- 默认启用完整权限，同时保留上下文压缩和子代理能力。

该提交共涉及 73 个文件，新增 1357 行、删除 2064 行。其中源码涉及 21 个文件（+406/-1351），测试涉及 51 个文件（+945/-707）。

> 注意：该分支只有上述 1 个独有提交。截至 2026-08-12，它已经落后 `origin/main` 202 个提交。因此，理解功能意图应以提交 `3544de8fa` 为准；若需要重新合入当前主线，应重新移植并验证，不能直接把旧分支快照视为可合并版本。

## 改动目标

该分支没有增加独立的 TUI“RL 模式”入口，而是直接调整运行时的默认行为，使一次模型动作尽量对应一次可审计的 RL trajectory：

```text
用户消息
  → 构建未被裁剪的历史
  → 发起一次非流式模型请求
  → 请求完成后转换为内部事件
  → 持久化 assistant、reasoning 和 tool parts
  → 继续工具观察回合或直接终止
```

这里的“确定性”主要指：没有隐藏的重试、恢复性重采样或默认辅助模型请求，并不表示相同输入一定产生完全相同的模型输出。

## 主要修改

### 1. 模型请求改为单次非流式采样

核心模型请求由 `streamText()` 改为 `generateText()`，并显式设置 `maxRetries: 0`。完整响应返回后，代码再将结果转换成原有的 `start`、`text-delta`、`tool-call`、`finish-step` 等内部事件，交给既有 processor 处理。

同时删除或关闭：

- AI SDK 内部请求重试；
- session/processor 层的持久重试及退避逻辑；
- assistant prefill 被 provider 拒绝后的补救重发；
- Max mode candidate 与 judge 的瞬态错误重试；
- Workflow agent 的多次尝试。

因此 429、503、ECONNRESET、断流和超时等瞬态错误会直接暴露为本次请求失败。

主要文件：

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/retry.ts`
- `packages/opencode/src/session/max-mode.ts`
- `packages/opencode/src/workflow/runtime.ts`

### 2. 异常输出不再触发恢复性重采样

主会话循环删除了多类自动续写、修复和恢复提示。以下情况改为首次发生时记录错误并终止：

- 输出达到 token 上限：保留已有部分，并记录 `MessageOutputLengthError`；
- 空输出或只有 reasoning：记录 `InvalidOutputError`；
- 模型将工具调用写成普通文本：记录 `TextToolCallError`；
- 未按 JSON Schema 生成结构化输出：记录 `StructuredOutputError`；
- n-gram 重复或跨步骤文本循环：直接终止；
- Workflow 或 Actor 的结构化输出失败：`retryCount` 固定为 `0`。

原先插入 recovery、replan、continue 等合成消息并再次请求模型的逻辑被移除，从而避免训练轨迹混入 harness 生成的恢复回合。

主要文件：

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/prompt/empty-step-detection.ts`
- `packages/opencode/src/session/prompt/text-loop-recovery.ts`
- `packages/opencode/src/session/prompt/text-ngram-detection.ts`
- `packages/opencode/src/session/message-v2.ts`

### 3. 默认关闭辅助模型侧通道

新增以下环境开关，且默认均为关闭：

- `MIMOCODE_ENABLE_TITLE_GENERATION`
- `MIMOCODE_ENABLE_CHECKPOINT`
- `MIMOCODE_ENABLE_DREAM`
- `MIMOCODE_ENABLE_DISTILL`
- `MIMOCODE_ENABLE_PREDICT_NEXT_PROMPT`

对应行为包括自动标题、checkpoint writer、dream、distill 和下一提示预测。这样可以避免与当前任务动作无关的模型请求混入训练记录。

自动 compaction 和普通子代理仍默认启用。可使用 `MIMOCODE_ENABLE_COMPACTION=false` 关闭自动 compaction。

主要文件：

- `packages/opencode/src/flag/flag.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/checkpoint.ts`
- `packages/opencode/src/session/auto-dream.ts`
- `packages/opencode/src/config/config.ts`

### 4. 历史消息改为只追加、不改写

为保持 RL trajectory 的完整性，`MIMOCODE_DISABLE_PRUNE` 被固定为 `true`。代码不再：

- 软裁剪或清空旧工具输出；
- 清除旧 reasoning 或媒体内容；
- 在 checkpoint rebuild 后 microcompact 历史 tool result；
- 通过 compaction 重写已有 message parts。

Compaction 仍可新增摘要和边界，但不能修改已经持久化的历史内容。

主要文件：

- `packages/opencode/src/session/prune.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/checkpoint.ts`

### 5. 默认启用 RL Full Permission

新增 `MIMOCODE_RL_FULL_PERMISSION`，默认值为开启。在此状态下：

- `Permission.ask()` 在规则求值前直接通过；
- 显式 deny 规则不生效；
- `bash_delete` 等强制确认权限被自动允许；
- deny 规则不再隐藏工具，所有工具保持可见。

设置 `MIMOCODE_RL_FULL_PERMISSION=false` 可恢复原有权限检查。

主要文件：

- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/flag/flag.ts`

### 6. Checkpoint、Workflow 与子代理行为

- Checkpoint 默认关闭；显式开启后，每个阈值只尝试一次 writer，同一阈值失败后不自动重试。
- Workflow 的旧 `retry` 配置仍保留解析兼容，但执行时被忽略，始终只尝试一次。
- Max mode 某个 candidate 失败时直接丢弃；judge 失败时回退到候选 0，不再次请求。
- Actor 取消和 worktree 清理改为 detached，不等待后台清理完成。
- 普通子代理调度仍保持启用。

## 用户可见行为变化

- TUI 不再逐 token 显示模型回复，而是在完整响应结束后集中出现；
- 瞬态 provider 或网络故障不再自动恢复；
- 截断、空回复、错误结构化输出和文本循环会立即显示错误；
- 默认会话标题保持初始值，不再自动生成下一问题 ghost text；
- 自动 dream、distill 和 checkpoint 默认不执行；
- 所有工具默认可见且无需权限确认；
- 长会话仍可自动 compaction，也仍可使用普通子代理；
- Workflow 即使声明多次 retry，也只执行一次。

## 测试覆盖

该提交新增了以下专项测试：

- `packages/opencode/test/flag/rl-auxiliary-generation.test.ts`
  - 验证辅助模型开关默认关闭；
  - 验证 compaction 默认开启且支持显式关闭。
- `packages/opencode/test/permission/rl-full-permission.test.ts`
  - 验证 full permission 覆盖显式 deny；
  - 验证删除类强制确认被自动允许；
  - 验证 deny 规则不会隐藏工具。
- `packages/opencode/test/permission/enforce.ts`
  - 为原权限测试提供显式关闭 RL 权限旁路的测试环境。

其他调整后的测试主要覆盖：

- 模型使用非流式请求且不重试；
- 默认不生成标题；
- 503、输出截断和结构化错误只请求一次；
- 历史消息和工具输出保持不变；
- checkpoint 默认关闭且 writer 失败不重试；
- 空输出、文本循环和 n-gram 重复直接终止；
- Workflow retry 参数不再产生多次执行；
- Max mode 网络错误不重试。

## 风险与限制

### 高风险

1. **不是隔离的训练模式，而是全局默认行为变化。** 普通运行未设置任何 RL 总开关时，也会受到非流式、无重试、默认全权限和不裁剪等行为影响。
2. **默认权限旁路仅适合隔离沙箱。** 在真实工作区中，模型可绕过显式 deny 和删除操作确认。
3. **真实流式语义丢失。** 首 token 延迟增大，TUI 实时反馈变差；循环检测也无法在模型完成整个响应前提前停止生成。
4. **分支落后主线较多。** 当前主线已经继续修改权限、provider、checkpoint、TUI、actor 和会话核心代码，重新集成时冲突面较大。

### 其他限制

- “单次请求”不等于严格可复现；温度、provider 随机性、工具外部状态和子代理并发仍会影响结果。
- 永不裁剪历史可提高轨迹完整性，但会增加数据库、内存、上下文窗口和 compaction 成本。
- Checkpoint 的临时失败可能导致较长区间没有新 checkpoint。
- Detached 清理可能在异常退出时遗留子进程、actor 状态或 worktree。
- `compaction.prune`、`checkpoint.max_writer_failures`、结构化输出 `retryCount` 和 Workflow `retry` 等兼容字段仍能配置，但不再产生原有效果。

## 

若要将这些能力重新集成到当前 `main`，建议引入明确的 RL 总开关或专用训练入口，并让以下行为仅在训练模式中生效：

- 非流式单次模型采样；
- 禁用所有请求和输出恢复重试；
- 关闭辅助模型调用；
- 历史轨迹只追加；
- full permission。

