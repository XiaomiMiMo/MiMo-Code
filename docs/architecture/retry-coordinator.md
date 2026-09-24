# Retry Coordinator

Retry 必须区分两个问题：错误是否可能恢复，以及当前 scope 还允许多少次尝试。transport retry 不做语义修复，只在预算内重建同一次请求。

## Scope

| Scope         | 语义                                    | 默认策略                        |
| ------------- | --------------------------------------- | ------------------------------- |
| request       | 尚未产生 provider output 的请求建立失败 | 仅作用于**非** network/rate_limit/server 的可恢复类（如 unknown）；可恢复三类见下表 |
| live-step     | 已建立 stream、但未完成的普通 turn      | 按错误 kind 选择预算            |
| max-candidate | max-mode 内存 candidate                 | 3 次，500ms 起步，3min deadline |
| max-judge     | max-mode 内存 judge                     | 3 次，500ms 起步，3min deadline |

| Kind       | 默认策略 |
| ---------- | -------- |
| network    | **persistent** 指数退避，5s 起步，最大间隔 60s，无 jitter；**不区分 phase**（request 阶段同样适用） |
| rate_limit | **persistent** 指数退避，Retry-After 优先；最大间隔默认 5min；**不区分 phase** |
| server     | **persistent** 指数退避，2s 起步，最大间隔默认 30s；**不区分 phase** |
| stream     | 5 次，2s 起步，10min deadline（非上述三类的 live stream 故障） |
| unknown    | 8 次，2s 起步，15min deadline |
| terminal   | 0 次 |

`budgetFor` 选择顺序：`max-candidate` / `max-judge` 自有预算 → 宿主显式行为的 phase 预算 → kind ∈ {network, rate_limit, server} 的预算 → `phase=request` 的 request 预算 → 其余。无宿主覆盖时，request 阶段的 DNS/连接失败、429、5xx 默认不会掉进 4 次/30s 的 request 窗口；显式宿主 bounded 则必须使用有限的 request/stream 预算。

Persistent network / rate_limit / server retry 只适用于 transport 或上游瞬态故障，不适用于 quota、auth、context overflow 或已经跨过 tool side-effect boundary 的 live step。每次等待只更新同一个 retry 状态，不能向 transcript 无限追加 Reconnecting 文本。

网络指纹（`ProviderError`）**按形状判定，不是可重试码白名单**：① 用户 Abort 永不 transport；② `UND_ERR_*` 一律 undici transport；③ POSIX 形态 `E*` 系统码一律 transport，**除非**落在本地 fs/进程 deny-list（`ENOENT`/`EACCES`/`EINVAL`…）；④ message 族匹配 connect/fetch/socket/dns 语言。因此新出现的网络 errno / undici 码不必先补枚举即可落入 `kind=network`；本地文件系统错误不会误入重试。

## 分类不变量与宿主目录

分类顺序固定为：真正的用户 abort、context overflow、缺少 API key 等安全错误 → 已匹配宿主的 terminal/persistent/bounded 行为 → 未匹配错误的 HTTP/网络与既有启发式。精确匹配的宿主 bounded HTTP403 可以越过宽泛403终止规则，但不会使其他403可重试。宿主 terminal 业务响应即使带 HTTP5xx、408/504 或 IO/网络关键词也不重试；业务码、产品文案和 providerID 字面值不内置于引擎。

宿主 v2 规则在 LLM API 边界用调用上下文的可信 providerID + 通用 RFC 6901 JSON Pointer 字段、任意完整 JSON 值或空 body + 可选 status 匹配。字段值支持 string/number/boolean/null 严格相等，空指针选根，~0/~1 转义，数组仅规范索引，只读取自有属性；missing 不等于 null。非法指针整体拒绝且保留旧快照，完整 JSON 支持 object/array/primitive/null。空 body 必须限定 status，语义不变。首次匹配仅位于 provider 的实际 doStream 调用及其原始返回流（error part 与读取异常）；fullStream、插件准备、工具修复及 whole-attempt catch 不能创建绑定。原始流保持背压并将取消传回 provider。边界开启 SDK 现有 includeRawChunks；compatible 适配器若把错误压成字符串，仅用紧邻且 message 相同的 raw/error 配对恢复结构，支持有/无顶层 type 的错误帧。最多保留一个待配对错误帧，其他 part、正常 raw、结束和取消均清理；内部开启的 raw 不向 fullStream/UI 传播，正常 raw 不参与目录匹配。完整 JSON 匹配使用原始帧而非补充 type 的归一化对象，不增加 fetch/SSE 解析器。SDK 展平的流错误使用其 data 中保留的原始错误 frame。来源不从 body、metadata 或 URL 推断。规则和 miss 按原始对象与 providerID 缓存，reload 不改已有故障；外层只沿 SDK RetryError 的 last-error 链继承已有绑定，不从 earlier errors 借用、不重新匹配。非 API 的 invalid output、tool、abort 等错误不产生宿主码；NamedError 不再全局 enrichment，归一化/decide 不重新匹配目录。流帧的 error.code 与 error.type 独立检查 context overflow，业务码不能遮蔽安全终止；原始/SDK展平帧及持久化往返都保持无宿主码的 ContextOverflowError。

宿主行为与 RetryKind 分开：RetryDecision.hostRetryClass 决定预算，hostCode 继续传递到事件。普通 request/live-step 的 host persistent 强制无次数和累计 deadline；host bounded 强制有限预算，即使 server/request/stream 配置为 persistent。有限 count 缺失或非有限时补 phase 默认值；deadline 非正或非有限时同样回落。request 默认4次/30秒，stream默认5次/10分钟。退避和 Retry-After 仍有效；schedule 最终再次约束调用者预算，silent overload 不得截断 host persistent。

实时 request、processor、max-mode 重试入口使用 `fromLiveError`：API 宿主印记必须有当前可信 providerID 的既有绑定；无绑定或 cached miss 时清除输入自带印记，插件或 whole-attempt 抛出的普通对象及 APIError 实例不能凭字段取得宿主行为。实时非 API 错误同样清除输入自带宿主字段，避免来源污染事件。外层不匹配目录。`fromError` 保留可信持久化恢复/幂等语义，恢复字段不授予实时绑定；只有已经绑定的源错误会把绑定传给归一化结果，JSON 副本没有实时来源证明。

未匹配的 transport 包括 native/SDK cause 的网络 errno、fetch failed、HTTP408/504、SSE read timeout；归一化后的 message、metadata.code 和有界 causeChain 经 JSON 往返仍可判定。SDK RetryError 仅沿 lastError（缺失时取最后一个 errors 数组元素）和真实 cause 提取重试事实，不把 earlier attempts 当成最终错误的原因。有效事实写入 `metadata.causeChain`，剥离重试包装后仅剩一条也保留；不同的完整诊断摘要另存 `metadata.retryHistory`，后者不参与分类。无 cause 包装的裸安全错误若在归一化时丢失终止身份，则补存当前有效摘要；已终止的归一化结果不追加，重复恢复保持幂等。之前的 timeout 不能把最终 TypeError 升级为无限重试，之前的404也不能终止最终503的恢复。

空目录或未命中时保留原生信号优先级：stream_read_error/upstream_error、网络和限流等既有恢复信号先于宽泛400/401/403/422兜底终止。无这些信号的普通客户端错误仍终止；真正的 abort/context/missing-key 安全不变量和明确宿主覆盖保持优先。

request/live-step 的原生 network 仍强制 persistent：无限次数、无累计 deadline，全局/provider network.mode/maxRetries/deadlineMs 不能降级；仅退避可配置。max-candidate/max-judge 隔离预算和 side-effect replaySafe 仍优先，取消可中断等待。server/rate_limit 默认 persistent 但允许配置；非网络 stream/unknown 保持有界默认。

## 配置

全局配置提供默认预算，provider.<id>.retry 对同名字段做覆盖。maxRetries 是初始 attempt 之外的重试次数，schema 硬上限为 100；deadlineMs 必须是正整数，且不能与 noDeadline 同时出现。需要取消 wall-clock deadline 时必须显式设置 noDeadline: true；该选项不会取消 bounded budget 的 maxRetries 限制。persistent 模式忽略 maxRetries（merge 时置 undefined），maxElapsedMs=0 表示无 deadline。

配置示例：

    {
      "retry": {
        "request": { "maxRetries": 4, "deadlineMs": 30000, "initialDelayMs": 200 },
        "stream": { "maxRetries": 5, "deadlineMs": 600000, "initialDelayMs": 2000 },
        "maxCandidate": { "maxRetries": 3, "deadlineMs": 180000, "initialDelayMs": 500 },
        "maxJudge": { "maxRetries": 3, "deadlineMs": 180000, "initialDelayMs": 500 },
        "network": { "mode": "persistent", "noDeadline": true, "initialDelayMs": 5000, "maxDelayMs": 60000, "jitterRatio": 0 },
        "server": { "mode": "persistent", "noDeadline": true, "initialDelayMs": 2000, "maxDelayMs": 30000 },
        "rateLimit": { "mode": "persistent", "noDeadline": true, "initialDelayMs": 2000, "maxDelayMs": 300000 },
        "unknown": { "maxRetries": 8, "deadlineMs": 900000 },
        "jitterRatio": 0.1
      }
    }

Persistent retry 可由 AbortSignal 或进程退出中断。provider chunkTimeout 约束单次 stream 的空闲等待（默认 8 分钟），超时后产生 network 故障并重新尝试；它不是整个 retry coordinator 的累计时间上限。network 配置只调整退避，mode/maxRetries/deadlineMs 不会使普通 session 的网络恢复提前退出。

## 退避

无服务端 retry hint 时使用 min(maxDelay, initialDelay \* 2^(attempt - 1))，再乘以 budget jitter。request/stream/server 等普通 budget 默认使用 10% jitter，network budget 默认不使用 jitter。Retry-After header 优先于指数退避；自然语言 retry hint 使用严格格式解析并设置独立上限，防止错误文本把 session 挂起数天。

## 副作用边界

普通 live-step 在收到 tool-call 后将 replaySafe 设为 false。之后即使 stream error 属于 network/server，也只能保存当前工具状态并终止本次 step，不能重放整个请求。max candidate/judge 不执行工具，可以独立重建内存 accumulator。

## 可观测性

每次实际 retry 可发布 `Session.Event.RetryAttempt`，包含 phase、scope、kind、attempt、phaseAttempt、maxAttempts、nextDelayMs 和 reason。

- **processor stream 阶段**（`isMain`）：`status.setRetry` 同时维护 session 级 `retryAttempts` 计数并写入 `session.status{type:"retry"}` 的 `attempt`——该计数跨 request/stream 在 **processor 可见 status** 上连续，session 回到 idle 时清零。
- **llm request 阶段**：只发 `RetryAttempt` 作诊断，**不**写 session.status；其 `attempt`/`phaseAttempt` 是 **phase 局部序号**（每个 processor 外层周期从 1 起），不是 session 全局连续序号。
- request 事件必须在原 Effect fiber 内通过 `Bus.Service.publish` 发布。不能转到静态 `Bus.publish` Promise bridge：后者重新读取环境 ALS，当其与 fiber 的 InstanceRef 不同时会把整组 retry 事件投递到另一目录。跨 Instance 集成测试使用真实 HTTP408/429/503 后成功，严格检查归属目录收到全部事件、错误目录收到零事件以及 GlobalBus 的 directory。

maxAttempts 为 0 表示 persistent retry。terminal UI notice 使用独立的 session status notice，不伪装成 retry attempt。Persistent network retry 不重复创建 transcript message；UI 只更新当前状态。成功、终止、取消都必须清理 retry 状态并回到 idle。

`session.status{type:"retry"}` 是 **session 维度** 的展示状态，不是 per-model-call 计数。

**发布归属**：`session.status{retry}` 只由 **processor stream 阶段**（`isMain`）通过 `status.setRetry` 发布，对应用户可见等待。`llm.ts` **request 阶段** 退避只发布 `Session.Event.RetryAttempt`（诊断），**不再**写 session.status——否则每个 processor 外层周期会重置 200ms×4 的 request 阶梯，在上游不可达时实测约 32s 内叠满 ~20 条 UI「正在重新连接」帧（`Cannot connect to API` 时 stream 侧按 ~2s 起步的 server/stream 阶梯，多轮 `4 request + 1 stream` 打包），观感上完全不像指数退避。

**request 阶段对 TUI 更安静**：在 request 微退避期间没有 `session.status{retry}`，界面保持 busy，直到 processor stream 重试才出现重连/倒计时。这是 ownership 契约的刻意取舍（用户可见等待 = stream 阶梯），不是回归。

max-mode propose-only ensemble（candidates/judge）共用 sessionID 并行跑 `llm.stream`：request 阶段已不写 session.status；ensemble 显式传 `retryScope: max-candidate/max-judge`，使内部 request retry 同样受隔离预算约束，并传 `quietRetryDiagnostics: true` 以抑制 N 路 request `RetryAttempt` 总线噪音。**不要**为此设置 `ephemeral`（还会跳过 plugin trigger、session-affinity 头、OTel functionId、system 组装）。ensemble 内部退避走 max-candidate / max-judge budget + `onRetry`。

## 兼容性

语义 retry（structured output、invalid output、text tool call、length recovery）不是 transport retry，不进入本 coordinator；它们有自己的 prompt-level bounded loop。LoadAPIKeyError 仍由 MessageV2.fromError() 识别，外部消费者只检查归一化后的 provider auth error 或 401/403 APIError。
