# 构建与发布

本项目在内部 GitLab 开发，推送到 GitHub (`https://github.com/XiaomiMiMo/MiMo-Code`) 时代码经过裁剪，因此**构建和发布在本地完成**，不使用 GitHub Actions CI 构建。

---

## GitHub 保留内容

```
.github/
├── actions/
│   └── setup-bun/action.yml          # bun 安装（typecheck 用）
├── workflows/
│   └── typecheck.yml                  # PR 门控：类型检查
├── ISSUE_TEMPLATE/                    # Issue 模板
└── pull_request_template.md           # PR 模板
```

已删除：publish/test workflow、setup-git-committer、github bot、CODEOWNERS、TEAM_MEMBERS 等。

---

## 本地发布流程

### .env 配置

在项目根目录创建 `.env`（已在 .gitignore 中）：

```env
NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

可选（如需发布 GitHub Release）：

```env
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GH_REPO=XiaomiMiMo/MiMo-Code
```

`NPM_TOKEN` 获取：npmjs.com → Access Tokens → Granular Access Token（Packages: Read and write, scope: `@mimo-ai`）

### 构建

```bash
source .env && OPENCODE_VERSION="1.0.0" OPENCODE_CHANNEL="latest" ./packages/opencode/script/build.ts
```

### 发布到 npm

```bash
source .env && OPENCODE_VERSION="1.0.0" OPENCODE_CHANNEL="latest" NODE_AUTH_TOKEN="$NPM_TOKEN" ./script/publish.ts
```

### Preview 发布（不影响 latest tag）

```bash
source .env && OPENCODE_VERSION="1.0.0-preview.0" OPENCODE_CHANNEL="preview" ./packages/opencode/script/build.ts
source .env && OPENCODE_VERSION="1.0.0-preview.0" OPENCODE_CHANNEL="preview" NODE_AUTH_TOKEN="$NPM_TOKEN" ./script/publish.ts
```

### 环境变量说明

| 环境变量 | 必须 | 用途 | 默认行为 |
|----------|------|------|----------|
| `NPM_TOKEN` | 是 | npm publish 认证 | — |
| `NODE_AUTH_TOKEN` | 是 | 传递给 npm（= NPM_TOKEN） | — |
| `OPENCODE_VERSION` | 否 | 覆盖版本号 | 读取 `packages/opencode/package.json` |
| `OPENCODE_CHANNEL` | 否 | npm dist-tag (latest/preview/beta) | 从 git branch 推断 |
| `OPENCODE_BUMP` | 否 | 自动递增 (major/minor/patch) | 不 bump |
| `GH_TOKEN` | 否 | GitHub Release 创建/上传 | 不发 Release |
| `GH_REPO` | 否 | 目标 GitHub 仓库 | — |
| `OPENCODE_RELEASE` | 否 | 启用 GitHub Release 流程 | 由 version.ts 自动设置 |

### 一键发布

```bash
GH_REPO=XiaomiMiMo/MiMo-Code \
NPM_TOKEN=npm_xxxxx \
GH_TOKEN=$(gh auth token) \
  ./script/release.ts
```

这会依次执行：
1. **version** — 计算版本号，创建 draft GitHub Release
2. **build** — 编译全平台 CLI 二进制，上传到 draft Release
3. **publish npm** — 发布 `@mimo-ai/cli` + 平台包 + SDK + plugin 到 npm
4. **finalize release** — 将 GitHub Release 从 draft 改为 published

### 分步执行

如果只需要其中部分步骤：

```bash
# 仅构建（不发布）
OPENCODE_VERSION=1.2.3 ./packages/opencode/script/build.ts

# 仅 npm publish（需要先构建）
NPM_TOKEN=npm_xxxxx OPENCODE_VERSION=1.2.3 ./script/publish.ts

# 仅创建 GitHub Release（不含 npm）
GH_TOKEN=$(gh auth token) GH_REPO=XiaomiMiMo/MiMo-Code ./script/version.ts
# 然后手动上传二进制:
gh release upload v1.2.3 packages/opencode/dist/*.zip packages/opencode/dist/*.tar.gz --repo XiaomiMiMo/MiMo-Code
gh release edit v1.2.3 --draft=false --repo XiaomiMiMo/MiMo-Code
```

---

## 版本号逻辑

`packages/script/src/index.ts` 中 VERSION 的决策：

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | `OPENCODE_VERSION` 有值 | 直接使用 |
| 2 | preview channel（非 latest） | `0.0.0-{channel}-{timestamp}` |
| 3 | `OPENCODE_BUMP` 有值 | 从 package.json 读取并 bump |
| 4 | 无 bump | 原样使用 package.json 版本 |

---

## 首次发布

1. 确认 npmjs.org 上 `@mimo-ai` org 存在
2. 创建 Granular Access Token（Packages: Read and write, scope: `@mimo-ai`）
3. 确认 `gh auth status` 有 `XiaomiMiMo/MiMo-Code` 的 repo 权限
4. 设定 package.json 版本为 `0.1.0`
5. 运行 `./script/release.ts`

---

## npm 包结构

| 包名 | 内容 |
|------|------|
| `@mimo-ai/cli` | Wrapper 包（bin shim + postinstall） |
| `mimocode-darwin-arm64` | macOS ARM 二进制 |
| `mimocode-darwin-x64` | macOS x64 二进制 |
| `mimocode-linux-arm64` | Linux ARM 二进制 |
| `mimocode-linux-x64` | Linux x64 二进制 |
| `mimocode-win32-arm64` | Windows ARM 二进制 |
| `mimocode-win32-x64` | Windows x64 二进制 |
