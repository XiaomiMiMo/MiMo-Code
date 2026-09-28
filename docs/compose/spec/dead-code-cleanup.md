---
AIGC:
  Label: '1'
  ContentProducer: '001191110108596084056A10000'
  ProduceID: '3FnKHNkZ3j6Feu6ntFy9cNMyKOcjTZrnX4gODKUHK9vGCJJfOEQ'
  ReservedCode1: ''
  ContentPropagator: '001191110108596084056A10000'
  PropagateID: '3FnKHNkZ3j6Feu6ntFy9cNMyKOcjTZrnX4gODKUHK9vGCJJfOEQ'
  ReservedCode2: ''
feature: dead-code-cleanup
status: in-progress
updated: 2026-09-28
branch: chore/dead-code-cleanup
commits:
---

# 无效代码清理（TUI 范围收窄）

## Report

**What was built** — `chore/dead-code-cleanup` 把 monorepo 收成 TUI + plugin/sdk 面。

- **批次 A/B/C（包 / 基建 / 脚本）**：删 app、desktop、console/*、web、storybook、enterprise、function、slack、containers、extensions、identity；nix/flake（旧打包与 devShell，不是“Bun 就不需要”）、infra/sst、sdks/vscode、plans；根 `dev:*`/玩具脚本；changelog 工具链、sync-zed、损坏的 `release`、close-issues、sign-windows。`build-node`/`sdk`/plugin/shared/script **保留**（mimo-desktop + npm）。
- **后续（非 bit-identical）**：整包删 `packages/ui`（`useI18n` 无消费者，`ui.*` 键 TUI 不展示）；`language.tsx` 只留 TUI 词典；skills → `.agents/skills`；去掉 `.mimocode` plugin smoke 与 `mimocode.jsonc`（约束写入 AGENTS）；去掉 `.vscode` example；**停用 Drizzle Kit 工具链**（`drizzle.config.ts` / `check-migrations.ts` / `db` script / `drizzle-kit` devDep），保留 `drizzle-orm` 与 `migration/**/migration.sql`。
- `docs/architecture`、`docs/harness` 误删后恢复。lockfile 为刻意变更。

**Verification** — 以 `MODELS_DEV_API_JSON` 钉死 models 快照：

| 批次 | 产物 |
|---|---|
| 仅删死包/基建/脚本（`dbf05bfa`） | `bin/mimo` + `dist/node/*` 相对最初基线 **逐文件 sha256 一致** |
| `packages/ui` + 后续（`a826a8a9`…） | **功能一致**：wasm/package.json/README 仍一致；`bin/mimo` 仅少未使用的 `ui.*` 词典与 `UiI18nBridge`（`tui.*` 仍在）；`dist/node` 无 `ui.*` 两侧相同 |

typecheck（opencode/plugin/shared/sdk）通过；`mimo --version` smoke 通过。独立审查：`bun ci`、4 包 typecheck、57 tests、TUI/Node 构建与 CI（`c132afe7`）全绿。全量 `bun test` 本地未跑完（CI 分 shard）。

**Journey log** —
- 「无代码引用」不能当唯一判死依据：设计文档、诊断脚本、macro 嵌入资源都会误伤。
- 钉死 `MODELS_DEV_API_JSON` 才能比哈希；`generate.ts` 现拉 models.dev 会造成无关漂移。
- Drizzle Kit：**主动停用**未进入 CI/脚本的工具入口（非“路径写错即无用”；generate/check 也不要求 DB 文件存在）。构建/运行直接使用 `migration/**/migration.sql`。

### Drizzle Kit 停用决策

| 项 | 决定 |
|---|---|
| 删除 | `packages/opencode/drizzle.config.ts`、`script/check-migrations.ts`、`package.json` 的 `db` 脚本、`drizzle-kit` devDependency |
| 保留 | `drizzle-orm`（运行时）、`src/**/*.sql.ts` 表定义、`migration/**/migration.sql`（打进二进制） |
| 新迁移 | 在 `packages/opencode/migration/` 新增目录与 `migration.sql`；**不改**已发布 journal（见 AGENTS） |
| 影响 | TUI / Node / 自动迁移 / 构建发布 / CI 均不读 Kit 配置 |

## [S1] Problem

仓库仍是 opencode monorepo 形态，混有 web / desktop / console / cloud 面、nix 打包、过时构建脚本和根目录杂物。产品面已收窄为 TUI（`packages/opencode`）+ plugin/sdk 体系；外部消费者还包括 `~/src/mimo-desktop`（经 `script/build-node.ts` 的 `dist/node`）和 npm 发布的 `@mimo-ai/cli` / `@mimo-ai/sdk` / `@mimo-ai/plugin`。

需要删掉确定用不到的目录与脚本。验收分两档：**删死包/基建/脚本**要求 TUI 二进制与 `dist/node` 逐文件哈希一致；**TUI 侧源码变更**（如 `packages/ui`）按功能一致验收（`tui.*` 文案与 smoke 完好，仅去掉未消费的 `ui.*`）。

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
| `nix/` + `flake.nix` + `flake.lock` | 弃用旧打包/devShell 通道：仍描述 `opencode`/`opencode-desktop` 产物与 `desktop.nix`，与现行 `packages/opencode/script/build.ts` + `bin/mimo` 发布路径、纯 Bun workspace 失配 |
| `infra/` | SST 部署 function/console/enterprise |
| `sst.config.ts` | 只 load `infra/*` |
| `sdks/vscode/` | VS Code 扩展 |
| `plans/` | 单份旧实施计划 |
| 根 `package.json` scripts | `dev:desktop` `dev:web` `dev:console` `dev:storybook` `random` `hello` |

#### C. 构建脚本

| 路径 | 说明 |
|---|---|
| `script/changelog.ts` | 停用自动生成 release notes；`version.ts` 改为读手工 `UPCOMING_CHANGELOG.md` 或占位 `"No notable changes"`（`.nothrow()`/fallback 只说明可降级，不等于脚本无用） |
| `script/raw-changelog.ts` | 同上停用；路径映射还覆盖 Core/TUI/SDK 与已删 desktop/app/vscode/zed |
| `script/version.ts` 中对 `changelog.ts` 的调用 | 与上一并去掉（保留 notes 回退） |
| `script/sync-zed.ts` | 只服务 `packages/extensions` |
| `script/release`（shell） | 调不存在的 `publish.yml`，损坏 |
| `script/github/close-issues.ts` | 零引用；且硬编码旧仓库 `anomalyco/opencode` |
| `script/sign-windows.ps1` | 原调用方是已删的 `packages/desktop`；publish/build/release 均不调 |
| `packages/opencode/script/actor-notification-cases.ts` | 人工诊断入口（warning/failure 情景）；由 `test/inbox/parse-actor-notification.test.ts` 与 actor resume 相关测试覆盖解析/告警路径，**弃用手动矩阵**（非“无引用即无效”） |
| `packages/opencode/script/subagent-resume-cases.ts` | 人工矩阵 [TP-RUN-R12-32..34]；同 TP 已由 `test/actor/subagent-resume-*.test.ts` 自动化，**弃用手动 runner** |
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

1. **哈希**：用 `MODELS_DEV_API_JSON` 钉死 models.dev 快照再比（`generate.ts` 现拉会导致无关漂移）。**仅删死包/基建/脚本**批次前后 `bin/mimo` + `dist/node/*` sha256 一致。
2. **ui 整包删除及后续**：**不以 bit-identical 为门禁**；功能一致 — 未使用的 `ui.*` 词典从 TUI 消失，`tui.*` 保留，smoke/typecheck 通过。
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

- [x] T1: 建立构建哈希基线 — acceptance: 产物可比对，或钉死 `MODELS_DEV_API_JSON` 后可比 (covers: S2)
- [x] T2: 删除批次 A 整包 — acceptance: workspaces/bun.lock 更新，`bun ci` 成功 (covers: S2; depends: T1)
- [x] T3: 删除批次 B 基建/根目录 — acceptance: nix/infra/sdks/plans 及根 `dev:*`/玩具脚本移除；`docs/architecture`、`docs/harness` 保留 (covers: S2)
- [x] T4: 删除批次 C 构建脚本并改 `version.ts` — acceptance: changelog 工具链/sync-zed/release/死 script 移除，release 改为手工 notes 或占位 (covers: S2; depends: T3)
- [x] T5: 删除 packages/ui 并去掉 TUI 侧引用 — acceptance: 无 `@mimo-ai/ui` 引用，typecheck 通过，tui 词典仍在二进制 (covers: S2)
- [x] T6: 后续清理（.mimocode smoke、skills→.agents、vscode example、停用 Drizzle Kit）+ PR — acceptance: 功能一致验收记入 Report，PR 已开 (covers: S2; depends: T5)

（AI生成）
