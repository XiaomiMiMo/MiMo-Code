---
feature: dead-code-cleanup
status: in-progress
updated: 2026-09-28
branch: chore/dead-code-cleanup
commits:
---

# 无效代码清理（TUI 范围收窄）

## Report

**What was built** — 在 `chore/dead-code-cleanup` 分支删除 opencode 遗留面：11 个死包（app/desktop/console/web/storybook/enterprise/function/slack/containers/extensions/identity）、nix/flake、infra/sst、sdks/vscode、plans、根 `dev:*` 与玩具脚本、changelog/raw-changelog/sync-zed/release 及 4 个无引用 script。`version.ts` 摘掉 changelog 调用。workspaces 收成 `packages/*` + `packages/sdk/js`，lockfile 刻意更新。`docs/architecture`、`docs/harness` 误删后已恢复（仍在用）。`build-node`/`sdk`/plugin/shared/ui/script 保留。

**Verification** — `MIMOCODE_VERSION=local MIMOCODE_CHANNEL=local` 的 `bin/mimo` 与 `dist/node/*` 清理前后 sha256 **逐文件一致**；`packages/{opencode,plugin,shared,ui,sdk/js}` typecheck 通过；`test/installation` + models-catalog 烟测 39 pass。全量 `bun test` 本地超时（CI 本就分 4 shard），未在本机跑完。

**Journey log** —
- 仅凭「无代码引用」会误伤设计文档：docs/architecture、docs/harness 被删后用户纠正并恢复。
- 嵌入资源（skill `.bundle` / workflow builtin）不可按 import 图判死。
- lockfile 变更属刻意（AGENTS 禁止随意 install），与删除同提交语义。

## [S1] Problem

仓库仍是 opencode monorepo 形态，混有 web / desktop / console / cloud 面、nix 打包、过时构建脚本和根目录杂物。产品面已收窄为 TUI（`packages/opencode`）+ plugin/sdk 体系；外部消费者还包括 `~/src/mimo-desktop`（经 `script/build-node.ts` 的 `dist/node`）和 npm 发布的 `@mimo-ai/cli` / `@mimo-ai/sdk` / `@mimo-ai/plugin`。

需要删掉确定用不到的目录与脚本，且 **TUI 二进制与 `dist/node` 构建产出严格一致**。

## [S2] Design

### 构建与发布边界（清理判定基准）

| 通道 | 入口 | 产出 | 消费者 |
|---|---|---|---|
| TUI 二进制 | `packages/opencode/script/build.ts` → `src/index.ts` + `src/cli/cmd/tui/worker.ts` | `dist/*/bin/mimo` | 终端用户 / install 脚本 |
| Node 引擎 | `packages/opencode/script/build-node.ts` → `src/node.ts` | `dist/node` | **mimo-desktop**（必留） |
| npm 发布 | `script/publish.ts` | `@mimo-ai/cli` / `@mimo-ai/sdk` / `@mimo-ai/plugin` | npm |

**保留的 workspace 包**

| 包 | 原因 |
|---|---|
| `packages/opencode` | 引擎 + TUI |
| `packages/plugin` | npm 发布 `@mimo-ai/plugin` |
| `packages/sdk/js` | npm 发布 `@mimo-ai/sdk`（TUI 的 v1/v2 client 也来自这里） |
| `packages/shared` | TUI 深度依赖（filesystem / flock / glob / error …） |
| `packages/script` | build/publish 的 version/channel 工具 |

`packages/opencode/src/node.ts` + `script/build-node.ts` **不可删**：mimo-desktop 经 `MIMO_ENGINE_NODE_DIST=mimocode/packages/opencode/dist/node` 打进 Electron 主进程。

### 本轮删除清单（In Scope）

#### A. 整包删除

```
packages/app          Web UI（embed 已在 build.ts 硬编码关闭）
packages/desktop      Electron 壳（与 mimo-desktop 无关）
packages/console/     app / core / function / mail / resource
packages/web          Astro 文档/营销站
packages/storybook    ui 的 Storybook
packages/enterprise   自托管 share 服务端
packages/function     Cloudflare share/sync Worker
packages/slack        Slack bot
packages/containers   CI Docker 镜像（现 workflow 不用）
packages/extensions   Zed 扩展
packages/identity     品牌图片，零引用
packages/ui           纯 web 组件库；TUI 对其 i18n 的引用已确认无消费方，整包删除
```

#### B. 仓库基建 / 根目录

| 路径 | 说明 |
|---|---|
| `nix/` + `flake.nix` + `flake.lock` | 纯 Bun 生态用不到；`desktop.nix` 只服务已死的 desktop |
| `infra/` | SST 部署 function/console/enterprise |
| `sst.config.ts` | 只 load `infra/*` |
| `sdks/vscode/` | VS Code 扩展 |
| `plans/` | 单份旧实施计划 |
| 根 `package.json` scripts | `dev:desktop` `dev:web` `dev:console` `dev:storybook` `random` `hello` |

#### C. 构建脚本

| 路径 | 说明 |
|---|---|
| `script/changelog.ts` | 无实际用途；`version.ts` 里已 `.nothrow()` 且读不到 changelog 时回退 `"No notable changes"` |
| `script/raw-changelog.ts` | 同上；路径映射仍指向 desktop/app/vscode/zed |
| `script/version.ts` 中对 `changelog.ts` 的调用 | 与 C 一并去掉（保留 release notes 回退） |
| `script/sync-zed.ts` | 只服务 `packages/extensions` |
| `script/release`（shell） | 调不存在的 `publish.yml`，损坏 |
| `script/github/close-issues.ts` | 零引用；且硬编码旧仓库 `anomalyco/opencode` |
| `script/sign-windows.ps1` | 原调用方是已删的 `packages/desktop`；publish/build/release 均不调 |
| `packages/opencode/script/actor-notification-cases.ts` | 无引用 |
| `packages/opencode/script/subagent-resume-cases.ts` | 无引用 |
| `packages/opencode/script/time.ts` | 无引用 |
| `packages/opencode/script/trace-imports.ts` | 硬编码旧机器路径，死工具 |

### 保留 / 勿删

| 路径 | 原因 |
|---|---|
| `script/build-node.ts` + `src/node.ts` | **mimo-desktop 依赖** |
| `packages/sdk/**` | **npm 发布 `@mimo-ai/sdk`** |
| `script/publish.ts` `release.ts` `version.ts` `generate.ts` `format.ts` | 发布/工具链 |
| `script/build-install-ps1.ts` `sync-registry.ts` | 安装与产物 |
| `install` `install.ps1` `install-utf8.ps1` `local-install.sh` | 安装入口 |
| `patches/` `packages/script/` `bin/mimo` | 运行/构建链 |
| `docs/architecture/` `docs/harness/` | 仍在用的设计文档（勿按「无代码引用」误删） |
| `src/skill/**/.bundle/**` `src/workflow/builtin/*.js` | Bun macro 字符串嵌入，动了会改二进制 |
| `src/ext/**` 构建期 overlay 钩子 | 内部版注入点（`dev.ts` / `build.ts`） |
| `docs/compose/` | 不在本范围 |

### 耦合点（删除时一并处理）

1. **workspaces**：已收成 `packages/*` + `packages/sdk/js`；`bun.lock` 已随删除刻意更新
2. **CI typecheck 仍走 turbo**：根 `typecheck` = `bun turbo typecheck`，`typecheck.yml` 与 pre-push 都调它；**CI 并未排除 turbo**（仅 `test.yml` 直接 `bun test`）。仍有 typecheck 的包：`opencode` `plugin` `shared` `sdk/js`
3. **根脚本引用**：上面 A/B 列出的 `dev:*` 与玩具脚本
4. **`version.ts`**：摘掉 `changelog.ts` 调用

### packages/ui 吸收结论（已实施为整包删除）

`language.tsx` 原先把 `@mimo-ai/ui` 的 17 语言词典 merge 进 TUI 词典，并用 `UiI18nBridge` 包一层 `I18nProvider`。核实：

- `useI18n()` / `I18nContext` 全仓零调用（组件删完后无消费者）
- TUI 源码从不使用 `ui.*` 键
- `ui.*` 与 `tui.*` 键集合零交集；ko/de/da/pl/ar/no/br/th/bs/tr 等在 TUI 自家词典里本就没有译文

因此**无需并入 shared**，直接去掉 `@mimo-ai/ui` 依赖与 `UiI18nBridge`，`language.tsx` 只保留 `../i18n/*`。已翻译的 TUI 语言（zh/zht/es/fr/ja/ru）仍从自家词典动态加载，其余回退英文。

### 验证

1. **哈希**：用 `MODELS_DEV_API_JSON` 钉死 models.dev 快照再比（`generate.ts` 现拉会导致无关漂移）。死包/基建/脚本批次前后 `bin/mimo` + `dist/node/*` sha256 一致。
2. **ui 整包删除**：非 bit-identical（去掉未使用的 `ui.*` 词典字符串）；`tui.*` 键仍在，`ui.sessionReview.*` 等已消失，`mimo --version` smoke 通过。按功能一致验收。
3. typecheck：`opencode` / `plugin` / `shared` / `sdk/js` 通过。

## [S3] Out of Scope

以下**本轮不动**，仅备忘，不在实现任务内：

| 项 | 说明 |
|---|---|
| `build.ts` 内 `createEmbeddedWebUIBundle` / `skipEmbedWebUi` / `routes/ui.ts` / `Flag.MIMOCODE_DISABLE_EMBEDDED_WEB_UI` | embed 残骸 |
| `packages/opencode/src` 内部零引用模块 | 已有清单，暂不删 |
| turbo → 朴素 `bun run <task>` | `turbo.json`/依赖暂留；typecheck 仍是 `bun turbo typecheck`（CI + pre-push），可后改成串/并联 `bun run --cwd … typecheck` |
| opencode → core 改名 | 另一议题 |
| 根 `package.json` `name: "opencode"` 命名 | 同上 |

内部零引用备忘（**不在范围**）：`util/scrap.ts`、`cli/cmd/web.ts`、`session/message.ts`、若干死 barrel、0 字节文件、未挂载 TUI 组件等。

## Tasks

- [x] T1: 建立构建哈希基线 — acceptance: `build:local` 与 `build-node` 两次产物哈希可比对，或已确定替代 oracle (covers: S2)
- [x] T2: 删除批次 A 整包 — acceptance: workspaces/bun.lock 更新，`bun install` 成功 (covers: S2; depends: T1)
- [x] T3: 删除批次 B 基建/根目录 — acceptance: nix/infra/sdks/plans 及根 `dev:*`/玩具脚本移除；`docs/architecture`、`docs/harness` 保留 (covers: S2)
- [x] T4: 删除批次 C 构建脚本并改 `version.ts` — acceptance: changelog/raw-changelog/sync-zed/release/死 script 移除，release 流程仍能生成 notes (covers: S2; depends: T3)
- [ ] T5: 删除 packages/ui 并去掉 TUI 侧引用 — acceptance: 无 `@mimo-ai/ui` 引用，typecheck 通过，tui 词典仍在二进制 (covers: S2)
- [ ] T6: 验证 + 提交 — acceptance: smoke 通过，变更可评审 (covers: S2; depends: T5)
