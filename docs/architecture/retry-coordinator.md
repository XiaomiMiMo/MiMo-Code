# Retry Coordinator Design

本文是 MiMoCode provider retry 的单一设计来源。实现位于 packages/opencode/src/session/retry.ts，配置 schema 位于 packages/opencode/src/config/config.ts 与 packages/opencode/src/config/provider.ts。

## 目标

Retry 必须区分两个问题：错误是否可能恢复，以及当前 scope 是否应该继续等待。事实归一化、终态判断、预算选择和 UI 通知必须分离。

- 用户取消、鉴权、额度、上下文溢出和确定性请求错误立即停止。
- 网络连接失败可以长时间等待网络恢复，适合 long-running harness。
- 已建立的 stream 使用有限预算，避免重复推理和重复计费。
- 已执行 tool side effect 后禁止自动重放整个 model step。
- 所有 retry scope 使用同一个分类器、退避算法、Retry-After 解析器和事件模型。
- 次数、deadline、退避和 persistent network 模式可以配置，provider 可以覆盖全局默认值。

## 分层模型

原始 provider / transport error -> cause summary -> RetryDecision(kind, phase, scope) -> budget -> exponential backoff -> RetryAttempt event。

| Scope         | 语义                                    | 默认策略                        |
| ------------- | --------------------------------------- | ------------------------------- |
| request       | 尚未产生 provider output 的请求建立失败 | 4 次，200ms 起步，30s deadline  |
| live-step     | 已建立 stream、但未完成的普通 turn      | 按错误 kind 选择预算            |
| max-candidate | max-mode 内存 candidate                 | 3 次，500ms 起步，3min deadline |
| max-judge     | max-mode 内存 judge                     | 3 次，500ms 起步，3min deadline |

| Kind       | 默认策略                                                                      |
| ---------- | ----------------------------------------------------------------------------- |
| network    | live stream persistent，5s 起步，最大间隔 60s，无 jitter；request 阶段使用 request budget |
| stream     | 5 次，2s 起步，10min deadline                                                 |
| server     | 8 次，2s 起步，15min deadline                                                 |
| rate_limit | 5 次，优先 Retry-After，最大 delay 5min                                       |
| unknown    | 8 次，2s 起步，15min deadline                                                 |
| terminal   | 0 次                                                                          |

Persistent network retry 只适用于 transport connection failure，不适用于 quota、auth、context overflow 或已经跨过 tool side-effect boundary 的 live step。每次等待只更新同一个 retry 状态，不能向 transcript 无限追加 Reconnecting 文本。

## 配置

全局配置提供默认预算，provider.<id>.retry 对同名字段做覆盖。maxRetries 是初始 attempt 之外的重试次数，schema 硬上限为 100；deadlineMs 必须是正整数，且不能与 noDeadline 同时出现。需要取消 wall-clock deadline 时必须显式设置 noDeadline: true；该选项不会取消 bounded budget 的 maxRetries 限制。

配置示例：

    {
      "retry": {
        "request": { "maxRetries": 4, "deadlineMs": 30000, "initialDelayMs": 200 },
        "stream": { "maxRetries": 5, "deadlineMs": 600000, "initialDelayMs": 2000 },
        "maxCandidate": { "maxRetries": 3, "deadlineMs": 180000, "initialDelayMs": 500 },
        "maxJudge": { "maxRetries": 3, "deadlineMs": 180000, "initialDelayMs": 500 },
        "network": { "mode": "persistent", "noDeadline": true, "initialDelayMs": 5000, "maxDelayMs": 60000, "jitterRatio": 0 },
        "server": { "maxRetries": 8, "deadlineMs": 900000 },
        "rateLimit": { "maxRetries": 5, "maxDelayMs": 300000 },
        "unknown": { "maxRetries": 8, "deadlineMs": 900000 },
        "jitterRatio": 0.1
      }
    }

Persistent network retry 仍受 AbortSignal、进程退出和 provider chunkTimeout 约束。默认 provider chunkTimeout 为 8 分钟；provider 可以用 chunkTimeout 覆盖该单次 stream idle timeout。

## 退避

无服务端 retry hint 时使用 min(maxDelay, initialDelay \* 2^(attempt - 1))，再乘以 budget jitter。request/stream/server 等普通 budget 默认使用 10% jitter，network budget 默认不使用 jitter。Retry-After header 优先于指数退避；自然语言 retry hint 使用严格格式解析并设置独立上限，防止错误文本把 session 挂起数天。

## 副作用边界

普通 live-step 在收到 tool-call 后将 replaySafe 设为 false。之后即使 stream error 属于 network/server，也只能保存当前工具状态并终止本次 step，不能重放整个请求。max candidate/judge 不执行工具，可以独立重建内存 accumulator。

## 可观测性

每次实际 retry 发布 session.retry.attempt，包含 phase、scope、kind、attempt、phaseAttempt、maxAttempts、nextDelayMs 和 reason。attempt 是当前 session 跨 request/stream 的连续序号，phaseAttempt 是当前 phase 内的局部序号；attempt counter 独立于 busy/notice 状态，只在 session 回到 idle 时清零。maxAttempts 为 0 表示 persistent retry。terminal UI notice 使用独立的 session status notice，不伪装成 retry attempt。Persistent network retry 不重复创建 transcript message；UI 只更新当前状态。成功、终止、取消都必须清理 retry 状态并回到 idle。

## 兼容性

语义 retry（structured output、invalid output、text tool call、length recovery）不是 transport retry，不进入本 coordinator；它们有自己的 prompt-level bounded loop。LoadAPIKeyError 仍由 MessageV2.fromError() 识别，外部消费者只检查归一化后的 provider auth error 或 401/403 APIError。
