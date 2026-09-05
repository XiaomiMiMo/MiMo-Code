# MiMo Loop Detection

**一句话总结**：两个检测器 + 一套处理。思维链复读用大窗口、大 N 的 n-gram 检测；工具重复调用检测连续相同调用与周期性调用，不判断进展；处理沿用代码已有的三层降级（提醒 → 重新规划 → 终止）。不依赖额外模型，全部在 agent runtime（`packages/opencode/src/session/`）执行。

以下数值是实验起点，需要用真实轨迹校准。

## 1. 思维链复读检测

只检查模型本次生成的 reasoning 和 text，不混入用户输入和工具返回。如果接口只给思考摘要，就只能检测摘要。

### 参数

| 项 | 值 |
| --- | --- |
| 滑动窗口 | 最近 8192 个检测 token（`tokenizeForNgram` 输出：按空白切词，CJK 逐字） |
| n-gram 长度 | 64 |
| 命中条件 | 同一 n-gram 出现 ≥ 3 次，按互不重叠的位置计数 |
| 检查节拍 | 每新增 256 token 检查一次，命中即中断当前生成，返回 `text-repeat` |

### 实现

复用 `TextNgramMonitor` 的流式接入位置（`processor.ts` 的 `checkTextNgram`、`max-mode.ts`），把内部检测函数从 `detectConsecutiveRepeat` 换成已有的 `detectRepeatedNgram(tokens, 64, 3)`，窗口从 500 提到 8192。用滚动哈希代替 `slice().join()`，每 token O(1)。

对应开关：`MIMOCODE_TEXT_NGRAM_N=64`、`MIMOCODE_TEXT_REPEAT_THRESHOLD=3`、`MIMOCODE_TEXT_WINDOW_TOKENS=8192`。

### 不做的事

不加 MinHash/Jaccard，不做覆盖率统计，不排除代码块。近似改写先允许漏报。

## 2. 工具重复调用检测

保留最近 12 次已完成工具调用的签名。签名 = 工具名 + 参数（JSON key 排序，复用 `stableStringify`），不压缩字符串内部空白、不删参数。比较必须含参数：连续读三个不同文件不算重复。

| 类型 | 条件 |
| --- | --- |
| 连续相同调用 | 最近 3 次签名完全相同，由 `MIMOCODE_TOOL_LOOP_THRESHOLD`（默认 3）控制 |
| 周期性调用 | 签名序列存在周期 p ∈ [2, 4]，最近 3p 次调用按位置签名相同。例：读 A → grep B → 读 A → grep B → 读 A → grep B |

命中后不判断文件是否变化、测试是否变化，直接进入第 3 章的处理。

扫描历史消息时，遇到带 synthetic 文本 part 的 user 消息即停止，避免把恢复提示之前的工具调用混入当前循环窗口。

### 轮询与重试例外（放宽阈值，仍然记录）

- bash 命令匹配 `sleep`、`wait`、`watch`、`poll`、`status`、`tail -f`，或工具本身是等待/监控类：同一签名允许 10 次或累计 10 分钟，超出后按"连续相同调用"处理。
- 上次结果是临时网络错误（`ETIMEDOUT`、`ECONNRESET`、HTTP 5xx / 429）：允许 3 次退避重试，不计入重复次数。

## 3. 处理：三层降级

沿用代码现有机制（`RECOVERY_PROMPT_MILD/STRONG`、`TEXT_NGRAM_RECOVERY_REMIND/REPLAN`），两个检测器共用一个计数器，单次用户回合上限 2 次恢复。

| 第几次命中 | 动作 | 注入内容 |
| --- | --- | --- |
| 第 1 次 | 提醒（remind） | 中断当前生成或暂停下一次调用，新建 synthetic user 消息：说明重复了什么（n-gram 片段 / 工具签名与次数），要求换措辞或换动作 |
| 第 2 次 | 重新规划（replan） | 要求放弃当前思路，写出新计划，说明原来在做什么、为什么失败、新计划有何不同 |
| 第 3 次 | 终止（terminate） | 发布 `Session.Event.Error`，保留已有修改，报告循环的具体动作、已尝试的恢复、当前阻塞点 |

思维链复读命中时，把本步 assistant 标记为 error，使 `toModelMessages` 跳过它，重复尾部不回流到下一次请求。工具重复命中时不自动重放、不自动撤销代码。

## 4. 接入与记录

- **生成流中**：n-gram 检测增量运行；拿不到流时在生成结束后整段检查。
- **步完成后、下一次决策前**：更新工具签名窗口，做连续/周期判定。位置即现有"重复步骤 nudge"处，把 nudge 改为走三层降级并计数。

日志记录 `loop_detected`（类型、签名或片段、次数）、`recovery_attempted`（第几层）、`loop_terminated`。先用 `MIMOCODE_LOOP_MODE=monitor` 只记录不干预，人工抽查命中轨迹后再切 `enforce`。

> 不要用解码期的 `no_repeat_ngram_size` 代替上述检测，它会屏蔽代码、路径等必须重复的内容，与运行时循环判定不是一回事。
