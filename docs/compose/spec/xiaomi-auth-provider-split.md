---
feature: xiaomi-auth-provider-split
status: in-progress
updated: 2026-02-15
source: feat/xiaomi-auth-provider-split
---

# Xiaomi 凭据按 Provider 分键落盘

## Report

## [S1] Problem

MiMo 开放平台登录（浏览器授权 / 粘贴 Code）返回 `{sk, uid, url}`，其中 `url` 既可能是计费网关（API Key）也可能是 Token Plan 集群。当前实现把两类凭据都写进 `auth.json` 的同一个 `xiaomi` 键，仅靠 `metadata.base_url` 区分：

- `packages/cli/src/plugin/mimo.ts` 的授权回调只返回 `key + metadata`，不声明目标 provider；
- `packages/cli/src/provider/auth.ts` 的 `callback` 把 api / oauth 两种凭据都写进 `input.providerID`，并把结果里的 `provider` 重定向字段解构丢弃（`cli/cmd/providers.ts` 的 `handlePluginAuth` 反而支持该字段）；
- `packages/cli/src/cli/cmd/providers.ts` 的 `mimoLogin()` 硬编码 `put("xiaomi", ...)`。

这与 models.dev 目录的分类不符：目录把 API 与 Token Plan 三集群登记为**四个 provider**（`xiaomi` → `https://api.xiaomimimo.com/v1`；`xiaomi-token-plan-cn|ams|sgp` → `https://token-plan-*.xiaomimimo.com/v1`），API Key 与 Token Plan 凭据应存放在不同 provider 下，且可以共存。现状导致：二次登录互相覆盖、Token Plan 用户的凭据无法按目录 provider 直接命中，一批特判 `providerID === "xiaomi"` 的消费点（X-Mimo-Source 头、websearch、TUI 登出/whoami/默认模型等）也不认识 `xiaomi-token-plan-*`。

## [S2] Design

### S2.1 Provider 派生（单源）

新增 `packages/cli/src/provider/xiaomi-family.ts`：

- 常量：`XIAOMI_API_PROVIDER_ID = "xiaomi"`；Token Plan 三档 id `xiaomi-token-plan-cn|ams|sgp` 与默认端点表（与 models.dev 一致）。
- `xiaomiProviderForEndpoint(url?: string): string`：按 URL 的 **hostname** 精确归类——`api.xiaomimimo.com` → `xiaomi`；`token-plan-cn|ams|sgp.xiaomimimo.com` → 对应三档 id；解析失败或未知主机 → 回落 `xiaomi`（保持旧行为：凭据进 `xiaomi` 并保留 `metadata.base_url`，由插件 loader 重定向）。
- `isXiaomiFamilyProvider(id?: string): boolean`：`id === "xiaomi" || id.startsWith("xiaomi-")`，与 `provider/error.ts` 现有网关族判据同形。

### S2.2 通用 OAuth 回调落盘尊重 `result.provider`

`packages/cli/src/provider/auth.ts` `callback`：api（`key`）与 oauth（`refresh`）两种写入统一使用 `result.provider ?? input.providerID` 作为落盘键。这样插件可以按端点把凭据写进不同 provider，CLI 与 TUI/服务端两条登录路径行为一致。

### S2.3 MimoAuthPlugin 声明目标 provider

`packages/cli/src/plugin/mimo.ts` 授权回调（本地 server 与粘贴 Code 两个分支）在 success 结果里返回 `provider: xiaomiProviderForEndpoint(result.url)`。`metadata.uid` / `metadata.base_url` 照旧写入，不改加密协议。`chat.headers` 的 `X-Mimo-Source` 门改为 `isXiaomiFamilyProvider(model.providerID)`。

### S2.4 CLI 登录与 whoami

`mimoLogin()` 落盘键改为 `result.provider ?? "xiaomi"`。写入 Token Plan 档时，若 `xiaomi` 现存条目是旧 CLI 形态（`type:"api"` 且 `metadata.base_url` 归类为同一 Token Plan 档），同一事务内删除该旧键，避免同一凭据双挂。`providers whoami` 遍历族内四键（`xiaomi` + 三档），逐条展示已登录条目。

### S2.5 引擎消费端族识别

- `tool/websearch/index.ts`：走 MiMo 网关分支的判据改为族判据；密钥按 `model.providerID` 取（不再硬编码 `auth.get("xiaomi")`），端点继续用 `model.api.url`。
- `tool/registry.ts`：WebSearchTool 可用性判据改族判据。
- `provider/provider.ts` `inHouse` 排序、`provider/transform.ts` `usesLargeModelDefaults`：`mimo` 或小米族。
- `provider/error.ts` 已按 `xiaomi-*` 族工作，不动。

### S2.6 TUI 消费端

- 登出（`app.tsx` provider.logout）：移除族内四键（逐个 `auth.remove`）。
- 登录成功（`dialog-mimo-login.tsx` `onLoginSuccess`）：在族内有凭据的 provider 中选默认模型（优先 `mimo-v2.6-pro`），不再假定 `xiaomi`。
- 语音（`tui/util/voice.ts`）：`resolveCredentials` 在配置的族内 provider 缺 key 时按 `xiaomi-token-plan-cn → ams → sgp → xiaomi` 顺序回退到族内第一个有 key 的 provider（与桌面端语音回退次序一致）；缺省 baseURL 回落补全覆盖族内四档默认端点。

### S2.7 兼容

旧条目（`xiaomi` 键 + Token Plan `metadata.base_url` 的 CLI 形态）继续可读可用：插件 loader 的 baseURL 重定向与桌面端消费（其语音用例 TP-R7-07 明示兼容该形态）均不受影响。不做主动迁移；仅 S2.4 的同档重登清理。

## [S3] Out of Scope

- 桌面端（mimo-desktop）自身的 auth.json 写入路径不在本次范围；其消费侧已兼容分键与旧形态。
- 不改平台加密载荷契约（仍为 `{sk, uid, url}`）。
- 不为 `xiaomi-token-plan-*` 增加插件 auth hook/loader（目录 api.url 已提供正确端点）。
- 不改 `provider-priority.ts` 登录列表排序、不迁移历史条目。

## Tasks

- [ ] T1: 新增 `xiaomi-family.ts` 派生与族判据 — acceptance: 单测覆盖四端点归类、未知 URL 回落 `xiaomi`、族判据真/假样例 (covers: S2.1)
- [ ] T2: `provider/auth.ts` callback 落盘键尊重 `result.provider` — acceptance: 单测证明 api 与 oauth 两种结果都按重定向键落盘，缺省仍为 `input.providerID` (covers: S2.2)
- [ ] T3: `plugin/mimo.ts` 回调返回派生 provider + `chat.headers` 族门 — acceptance: 单测证明 Token Plan 回调返回对应 provider、`X-Mimo-Source` 对 `xiaomi-token-plan-*` 生效 (covers: S2.3)
- [ ] T4: `mimoLogin` 分键落盘 + 旧形态同档清理 + whoami 族遍历 — acceptance: 单测证明 Token Plan 登录写入 `xiaomi-token-plan-*`、旧 `xiaomi` 同档条目被清、API 登录写 `xiaomi`、两类可共存 (covers: S2.4)
- [ ] T5: 引擎消费端族识别（websearch/registry/inHouse/transform） — acceptance: 单测证明 `xiaomi-token-plan-cn` 模型走 MiMo websearch 且按自身 provider 取 key、WebSearchTool 可用 (covers: S2.5)
- [ ] T6: TUI 消费端（登出清族、登录默认模型、语音族回退） — acceptance: 单测证明登出移除族内四键、语音在配置档缺 key 时回退族内有 key 档 (covers: S2.6)

## Journey log
