# Mix of Harness && Hand-off 机制

**一句话总结**：把 **Codex CLI** 与 **Claude Code CLI** 作为可调用的执行器封装成 skill，让 MiMoCode 在自己陷入"低收益循环"时能够把当前 turn 暂停、由用户一键把工作交给另一个 harness 继续。控制平面仍在 MiMoCode 会话里，执行平面在选中的 harness 里——两个平面解耦。

支持的 harness：**Codex CLI** && **Claude Code CLI**。

---

## 1. 为什么要 Mix of Harness

单一 harness 在遇到"它本来就不擅长"的任务时几乎不会自救：Codex 更乐观、容易过早宣告完成；Claude Code 探索更细，但在明确指令下容易陷入相似 diff 反复重写。真正的失败信号不是"某一步错了"，而是**继续烧 token 也换不来 progress**——同一文件被反复编辑、同一条 bash 命令原样重试、探索/修改的比例上不去。

Mix of Harness（下称 MoH）解决的是这个问题：把每个 harness 都做成可以由 MiMoCode 通过 skill 拉起、以子进程形式跑的执行器；配合 **Try-Best 检测器**监控当前 turn 的健康度，一旦命中低收益循环就暂停 turn、让用户选一个更合适的 harness 接手。

**核心边界**：MoH **不切换会话的 provider/model**。选择"交给 Codex CLI"或"交给 Claude Code CLI"之后，会话仍然是原来的 MiMoCode 会话、原来的模型，只是被要求加载对应 skill、把执行权委派给选中的 harness。这样上下文、任务面板、记忆、审批路由都不用重建。

---

## 2. SKILL 设计

Codex 和 Claude Code 各封装为一个 **built-in skill**，路径分别在 `<data>/builtin_skills/local/skills/codex/` 与 `<data>/builtin_skills/local/skills/claude-code/`。每个 skill 目录含：

```
codex/
  SKILL.md                # 触发描述 + 操作规则（headless 优先，禁用 --yolo 之外的交互）
  agents/openai.yaml
  references/
    recipes.md            # codex exec 的常用 pattern
    windows.md            # 原生 PowerShell / WSL2 分开走的注意事项

claude-code/
  SKILL.md
  references/
    config.md
    flags.md
    interactive-tmux.md
    platforms.md
    print-mode.md
```

SKILL.md 是入口，`description` 字段决定何时被 skill router 触发。原则是 **让 skill 直接给出可执行的 CLI 命令模板**——例如 Codex skill 会立刻给出：

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "<TASK>"
```

而不是让模型自己去查 flag 组合。跨平台差异（macOS/Linux vs Windows PowerShell vs WSL2）由 `references/` 里的子文档兜底。

> **为什么单独做 skill 而不是内置成工具？** 让 harness 的操作细节留在 skill 里、随模型 prompt 一并注入；工具层只暴露"运行子进程"这一层能力。skill 更新、跨平台差异、flag 变化都可以通过替换 skill 目录内容完成，不用改代码。

---

## 3. MoH 的五种模式

不同任务需要的编排结构不同。当前 MoH 支持以下五种，其中 **Fallback 是 MiMoCode 的默认模式**——也就是自动接入 Try-Best 检测 + Hand-off 的那一路。

### 3.1 Single

```
Task → Codex → Validator
```

单 harness 直跑，末尾接一个 validator。适合完全信任某个 harness、任务范围明确的场景。

### 3.2 Fallback（默认）

```
Task → MiMoCode
          │ 失败/停滞
          ▼
        Codex / Claude Code
```

MiMoCode 首选自己动手；命中失败/停滞信号后由用户挑选另一个 harness 接手。触发失败/停滞的常见规则：

- 连续 N 次同类工具失败
- 超过 X 分钟无文件变化
- 上下文压缩次数过多
- 测试结果连续没有改善
- 成本超过预算的 80%
- 最终输出缺少要求的 artifact

Try-Best 检测器（见 §4）实现了其中前几条中"可以在 turn 内实时判定"的那部分。

### 3.3 Pipeline

```
Claude Code 调研
       ↓ HandoffPacket
Codex 实现
       ↓ Patch
MiMoCode 审查
       ↓ Findings
Codex 修复
```

阶段式串联，每个阶段用最合适的 harness，相邻阶段之间用结构化 packet 传递上下文。适合有明确阶段边界的任务（先看清再改、先改完再评审）。

### 3.4 Parallel Competition

```
               ┌→ Claude Code → Patch A ┐
Task → Fork ───┤                        ├→ Evaluator
               └→ Codex        → Patch B ┘
```

分头做同一件事，最后由 evaluator 挑一个采纳。适合边界模糊、方案有多种走法、想赌一次概率的场景。**成本更高**，不做默认。

### 3.5 Debate / Review

```
Codex Implementer → Claude Reviewer → Codex Repairer
```

一个 harness 出方案，另一个 harness 挑刺，然后回到第一个 harness 修。适合对正确性/安全性敏感、需要交叉检查的改动。

---

## 4. Hand-off 机制（Try-Best HandOff）

Try-Best HandOff 是 Fallback 模式的自动化实现：**turn 内实时监测**低收益循环，一旦命中就把 turn 暂停、写入现场证据、把选择权交给用户。

### 4.1 什么算"低收益循环"

编码 agent 的失败模式在轨迹上有可观测的形状，Try-Best 只挑其中三种最强的信号：

- **循环与重复**。同一文件被反复编辑（edit 次数超过阈值）、连续出现语义相近的 diff、同一条 bash 命令反复失败后原样重试。这是最强的失败前兆——agent 陷入循环后几乎不会自己爬出来，继续烧 token 纯属浪费。实现上对最近 N 个 tool call 做**滑动窗口去重**就够，不需要 embedding。
- **进度与消耗脱钩**。定义一个粗粒度 progress 信号（测试通过数变化、diff 覆盖 issue 提到的文件的比例），对比 token burn rate。烧了 40% 预算但 progress 为零，基本可以判定这个 harness 不适合该任务，触发切换比等它跑完便宜得多。
- **迷路模式**。探索阶段读文件是正常的，但后期还在大范围 grep、反复读同一批大文件、打开与 issue 无关的目录，说明它没建立起对 repo 的工作模型。用"最近 K 步中新增信息类操作 vs 修改类操作的比例"来量化——健康轨迹这个比例应该随时间单调下降。
- **过早宣告完成**。harness 声明 done 但轨迹里没有跑测试/跑了但没看结果。**不要信任自报完成状态**，Codex 在这点上比 Claude Code 更乐观。

### 4.2 检测机制（三类命中原因）

当前实现在 `packages/opencode/src/session/try-best-detector.ts` 中命中前两类信号的三种具体规则：

| Reason | 说明 | 默认阈值 |
|---|---|---|
| `edit_repeat` | 对**同一文件**做近似编辑：把 diff 抽成 3-shingle 集合、用 **Jaccard 相似度**比对最近 12 个 edit 事件；相似度 > 0.8 视为一次匹配 | 累计 ≥ 2 次匹配就触发（即"第 3 次近似编辑" ） |
| `bash_retry` | 规范化后的 bash 命令**连续失败**、且失败输出没有变化 | 连续 3 次 |
| `action_streak` | 连续同类动作（`edit` 或 `verify`）没有可观察改善 | 连续 4 次 |

命令与结果都会做归一化，避免因时间戳、临时路径、随机 seed 造成误判：

- 命令：`/tmp/...` → `<TMP>`、纯数字（6 位以上）→ `<NUM>`、`--seed=xxx` → `<SEED>`
- 结果：额外抹掉 `Ns / Nms / N seconds` 时长；超过 2000 字符时头尾各留一半、中间插 `<TRUNCATED>`

`verify` 类命令（bun/npm/pnpm/yarn test/typecheck/lint/build、pytest、cargo test、go test、make test、tsc 等）在参与 `bash_retry` 判定的同时也进入 `action_streak` 计数。

### 4.3 暂停与持久化

命中任一 reason 后，`SessionProcessor.detectTryBest` 会：

1. **reset monitor**——避免同一 turn 反复触发。
2. **置 `ctx.blocked = true`**——processor 后续对模型输出 return `stop`，让 prompt loop 立刻退出当前 turn。
3. **写入 synthetic `TextPart`**：`text` 是人类可读的原因描述（"Try-best loop detected; this turn was paused. …"），`metadata.origin` 里带 `kind: "try_best"`、当前 `providerID / modelID`、完整 `incident`（reason + evidence）。**part 是事实来源**，即便事件订阅者掉线，重新拉起 session 也能通过扫描 part 恢复。
4. **发布 `session.try_best.detected` 事件**：TUI 端订阅这条事件即时弹出 dialog。事件是低延迟通知，与 part 互为兜底。
5. **发布 metrics 事件** `Metrics.TryBestDetected`：便于统计各模型/reason 的触发频率。

### 4.4 用户选择（TUI dialog 三选项）

暂停后 TUI 弹出 dialog，标题 "Try-best loop detected — turn paused"，描述里带具体证据（例如"Near-identical edits repeated 3 times in packages/opencode/src/foo.ts"）。三个选项：

1. **交给 Codex CLI 继续**（`Hand off to Codex CLI`）
2. **交给 Claude Code CLI 继续**（`Hand off to Claude Code CLI`）
3. **保留当前模型换策略继续**（`Continue with <model>`）——让原模型放弃当前 approach、重新规划

候选目标按**模型家族排除同类**（`packages/opencode/src/cli/cmd/tui/util/handoff.ts` 里的 `handoffTargets`）：

- 当前 provider 是 `openai` 或模型名含 `gpt / codex` → 只显示 "Claude Code CLI"（不给自己回炉的机会）
- 模型名含 `anthropic / claude` → 只显示 "Codex CLI"
- 其他 → 两个都显示

同时检查 `sync.data.command` 中对应 skill（`codex` / `claude-code`）已注册；未注册的选项会灰掉。

### 4.5 执行协议（编排式 handoff）

选定 harness 后 TUI **不换会话、不换模型**，而是向原 sessionID 发起 `promptAsync`，把一段 `<system-reminder>` 作为下一轮的输入（模板见 `formatHarnessReminder`）：

```
<system-reminder>
Try-best loop detection paused the previous turn: <detail>
The user explicitly selected and authorized the <harness> harness to take over the unfinished work.
You MUST load and follow the `<skill>` skill now and invoke <harness> as the primary executor …
Give the selected harness the complete user goal, relevant workspace state, the failed approach, and all remaining validation requirements. Do not include credentials, secrets, or unrelated private data.
Stay in this CLI and supervise <harness> until it completes or reaches a concrete blocker …
Inspect the harness result and workspace changes, ensure its validation is complete, and report the final outcome to the user. Do not stop after merely launching the harness.
</system-reminder>
```

关键点：

- **控制平面 = 原会话**：任务面板、审批路由、上下文、记忆都在 MiMoCode 会话里；harness 只是被拉起来的子进程。
- **执行平面 = 选中的 harness**：真正的调研、实现、修复、验证都要在这个子进程里完成。system-reminder 显式禁止"只是把 harness 当参考"，也禁止"launch 完 harness 就 return"。
- **原模型仍然在场**：负责调用 skill、把工作打包给 harness、监督到完成、把最终结果汇报给用户。它不是把控制权交出去，而是变成 harness 的运行时监工。

选择"保留当前模型换策略"时不发 reminder，仅解除 `ctx.blocked`，让原模型下一轮自己重规划。

---

## 5. 配置

### 5.1 总开关

- **环境变量 `MIMOCODE_ENABLE_TRY_BEST_HANDOFF`**（默认 `true`）
  - 设为 `false` 或 `0` → 关闭 loop 检测、turn 暂停、handoff dialog 全套能力。
  - 定义见 `packages/opencode/src/flag/flag.ts`。

### 5.2 阈值（`experimental.try_best`）

在 `mimocode.json` / config 里可以逐项覆盖检测阈值：

```json
{
  "experimental": {
    "try_best": {
      "edit_window": 12,
      "edit_similarity": 0.8,
      "edit_matches": 2,
      "action_streak": 4
    }
  }
}
```

含义：

| Key | 默认 | 说明 |
|---|---|---|
| `edit_window` | 12 | 参与比对的最近 edit 事件数 |
| `edit_similarity` | 0.8 | Jaccard 相似度阈值（0–1）；超过视为一次匹配 |
| `edit_matches` | 2 | 触发前需要累计的相似匹配次数（即"第 N+1 次编辑"触发） |
| `action_streak` | 4 | `edit`/`verify` 无进展的连续次数 |

`bash_retry` 的连续失败次数目前固定为 3（`TRY_BEST_BASH_RETRIES`），无 config 项。

### 5.3 skill 注册状态

Handoff dialog 的两个 harness 选项要求 `codex` 与 `claude-code` skill 已在 `sync.data.command` 中注册。未注册时对应选项会被隐藏，避免选了却拉不起来。
