# MiMo-Code 仓库指南

## 调查流程

1. **使用 `sequential-thinking` 进行计划与设计** — 在编码前分析问题、识别风险、制定方案
2. **使用 `codegraph` 搜索代码** — 优先于 grep/glob 进行符号搜索、调用链分析、变更影响分析（已索引 1751 文件，28737 节点）
3. 阅读关键配置文件：`package.json`, `turbo.json`, `bunfig.toml`, `.oxlintrc.json`, `tsconfig.json`

## 关键注意

- **默认分支是 `dev`**，不是 `main`。本地 `main` 可能不存在；diff 请用 `dev` 或 `origin/dev`
- **测试不能从仓库根目录运行** — `bunfig.toml` 中有守卫 (`root = "./do-not-run-tests-from-root"`)。必须进入包目录（如 `packages/opencode`）再运行
- **永远不要直接运行 `tsc`**。始终从包目录运行 `bun typecheck`。根目录的 `bun typecheck` 通过 Turbo 委派
- **pre-push hook 会运行 `bun typecheck`** 并强制 Bun 版本 (`^1.3.11`)
- **Bun 1.3+ 必须** — `packageManager` 字段强制执行

## 常用命令

| 操作 | 命令 |
|---|---|
| 安装依赖 | `bun install` |
| 开发服务器 (TUI) | `bun dev` 或 `bun dev <dir>` |
| 开发服务器 (无头 API) | `bun dev serve` |
| 开发 Web UI | `bun dev web` 或 `bun run --cwd packages/app dev`（需后端运行） |
| 开发桌面应用 | `bun run --cwd packages/desktop tauri dev` |
| 类型检查 (全部) | `bun typecheck` |
| 类型检查 (单个) | 在包目录内运行 `bun typecheck` |
| Lint | `bun lint` (oxlint) |
| 测试 (单个包) | 在包目录内运行 `bun test` |
| 生成 DB 迁移 | 在 `packages/opencode` 内运行 `bun run db generate --name <slug>` |
| 构建独立二进制 | `./packages/opencode/script/build.ts --single` |
| 重新生成 SDK | `./packages/sdk/js/script/build.ts` |
| 全量重新生成 (SDK+OpenAPI+格式化) | `./script/generate.ts` |

## 单体仓库结构

- `packages/opencode` — 核心 CLI、服务端、TUI、Effect 服务、Drizzle schema。绝大部分工作在此
- `packages/app` — 共享的 SolidJS Web UI 组件
- `packages/desktop` — 原生 Tauri 桌面应用（包裹 `packages/app`）
- `packages/sdk/js` — 从 OpenAPI 规范生成的 JavaScript SDK
- `packages/plugin` — `@mimo-ai/plugin` 源码
- `packages/console` — 控制台应用（有独立的 Drizzle 配置）
- `packages/ui` — 共享 UI 原语
- `packages/storybook` — Storybook 组件开发
- `packages/slack` — Slack 集成
- `packages/enterprise` — 企业版功能
- `packages/function` — 函数计算相关
- `packages/shared` — 共享逻辑
- `packages/script` — @mimo-ai/script

## 深度约定

**`packages/opencode/AGENTS.md`** 包含了以下关键约定（请务必阅读）：
- **Effect 模式**：`Effect.fn` / `Effect.gen` 用法，Runtime vs InstanceState，Effect v4 beta API，服务选择
- **模块形状**：self-reexport 模式（`export * as Foo from "./foo"`），禁止 `export namespace`，多兄弟目录中禁止 barrel index
- **数据库**：Drizzle schema 位于 `src/**/*.sql.ts`，snake_case 命名，迁移生成命令

**`packages/desktop/AGENTS.md`** - Tauri IPC 规则：Renderer 只能调 `window.api`，Main 进程在 `src/main/ipc.ts` 注册 handler

## 代码风格（与众不同的部分）

- **避免 `try`/`catch`** — 能用 Effect 错误处理时不使用异常
- **避免 `any`** — 优先类型推断
- **优先使用 Bun API** — 如 `Bun.file()` 替代 `fs.readFile`
- **单次使用的值直接内联**，不另存变量
- **配置模块自导出模式** — `export * as ConfigX from "./x"`（参考 `src/config` 下的现有文件）
- **Drizzle schema 使用 snake_case** 字段名（避免重复定义列名 string）
- **测试避免 mock** — 测试真实实现，不把逻辑复制进测试
- **oxlint 已配置 Effect/SolidJS 特殊规则** — `require-yield` 关闭（Effect generator），`no-unassigned-vars` 关闭（SolidJS ref）

## Prettier 注意

- `package.json` 中 `prettier` 设置：`semi: false, printWidth: 120`
- `.editorconfig` 声明 `max_line_length = 80` — **Prettier 会覆盖 editorconfig**，遵从 `package.json` 配置（120）

## 并行执行

尽可能使用并行工具调用。对于独立的文件读写、搜索、命令执行，同时发起多个调用以减少延迟。
