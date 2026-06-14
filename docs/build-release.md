# Devora 构建与发布

Devora 由 Sheri Akhtamov 在 GitHub 仓库 `https://github.com/SheriAkhtamov/Devora` 维护。

桌面版更新以 GitHub Release 为源。macOS desktop 包由 GitHub Actions 构建并发布，应用内 updater 会从 `SheriAkhtamov/Devora` 的 release assets 读取更新。CLI/npm 发布仍可按需在本地执行。

---

## GitHub 自动化内容

```
.github/
├── actions/
│   └── setup-bun/action.yml          # Bun 安装和依赖缓存
├── workflows/
│   ├── typecheck.yml                  # main / PR 类型检查
│   └── desktop-macos-release.yml      # macOS desktop 构建和发布
├── ISSUE_TEMPLATE/                    # Issue 模板
└── pull_request_template.md           # PR 模板
```

已删除或停用：不属于 Devora fork 的上游 bot、团队元数据和旧发布流程。

---

## GitHub desktop 发布流程

### 手动触发 macOS desktop 发布

1. 打开 GitHub Actions 中的 **desktop macOS release** workflow。
2. 选择 **Run workflow**。
3. 输入版本号，例如 `0.1.1`。
4. workflow 会构建 `Devora.app`，生成 `.dmg`、`.zip` 和 `latest-mac.yml`，并发布到 `v<version>` release。

也可以用 GitHub CLI：

```bash
gh workflow run "desktop macOS release" --repo SheriAkhtamov/Devora -f version=0.1.1
```

### 自动触发

推送形如 `v1.2.3` 的 tag 也会触发同一个 workflow：

```bash
git tag v1.2.3
git push origin v1.2.3
```

### macOS 签名

如果仓库配置了以下 secrets，workflow 会启用 macOS 签名/公证相关环境变量：

| Secret | 用途 |
|--------|------|
| `CSC_LINK` | Apple Developer 证书 |
| `CSC_KEY_PASSWORD` | 证书密码 |
| `APPLE_ID` | Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | Apple Team ID |

没有这些 secrets 时，workflow 仍会构建未签名包，适合个人测试。

---

## 本地 CLI/npm 发布流程

### 前置条件

| 环境变量 | 用途 | 获取方式 |
|----------|------|----------|
| `NPM_TOKEN` | npm publish (`@devora-ai` scope) | npmjs.com → Access Tokens → Granular Token |
| `GH_TOKEN` | GitHub Release 创建/上传 | `gh auth token` 或 GitHub PAT（repo scope） |
| `GH_REPO` | 目标 GitHub 仓库 | `SheriAkhtamov/Devora` |

可选：
| 环境变量 | 用途 | 默认行为 |
|----------|------|----------|
| `DEVORA_VERSION` | 覆盖版本号 | 读取 `packages/devora/package.json` |
| `DEVORA_BUMP` | 自动递增 (major/minor/patch) | 不 bump，原样使用 |
| `DEVORA_RELEASE` | 创建 GitHub Release | 由 `script/version.ts` 自动设置 |
| `DEVORA_CHANNEL` | 发布 channel (latest/beta/...) | 从 git branch 推断，detached HEAD 默认 latest |

### 一键发布 CLI/npm

```bash
GH_REPO=SheriAkhtamov/Devora \
NPM_TOKEN=npm_xxxxx \
GH_TOKEN=$(gh auth token) \
  ./script/release.ts
```

这会依次执行：
1. **version** — 计算版本号，创建 draft GitHub Release
2. **build** — 编译全平台 CLI 二进制，上传到 draft Release
3. **publish npm** — 发布 `@devora-ai/cli` + 平台包 + SDK + plugin 到 npm
4. **finalize release** — 将 GitHub Release 从 draft 改为 published

### 分步执行

如果只需要其中部分步骤：

```bash
# 仅构建（不发布）
DEVORA_VERSION=1.2.3 ./packages/devora/script/build.ts

# 仅 npm publish（需要先构建）
NPM_TOKEN=npm_xxxxx DEVORA_VERSION=1.2.3 ./script/publish.ts

# 仅创建 GitHub Release（不含 npm）
GH_TOKEN=$(gh auth token) GH_REPO=SheriAkhtamov/Devora ./script/version.ts
# 然后手动上传二进制:
gh release upload v1.2.3 packages/devora/dist/*.zip packages/devora/dist/*.tar.gz --repo SheriAkhtamov/Devora
gh release edit v1.2.3 --draft=false --repo SheriAkhtamov/Devora
```

---

## 版本号逻辑

`packages/script/src/index.ts` 中 VERSION 的决策：

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | `DEVORA_VERSION` 有值 | 直接使用 |
| 2 | preview channel（非 latest） | `0.0.0-{channel}-{timestamp}` |
| 3 | `DEVORA_BUMP` 有值 | 从 package.json 读取并 bump |
| 4 | 无 bump | 原样使用 package.json 版本 |

---

## 首次发布

1. 确认 npmjs.org 上 `@devora-ai` org 存在
2. 创建 Granular Access Token（Packages: Read and write, scope: `@devora-ai`）
3. 确认 `gh auth status` 有 `SheriAkhtamov/Devora` 的 repo 权限
4. 设定 package.json 版本为 `0.1.0`
5. 运行 `./script/release.ts`

---

## npm 包结构

| 包名 | 内容 |
|------|------|
| `@devora-ai/cli` | Wrapper 包（bin shim + postinstall） |
| `devora-darwin-arm64` | macOS ARM 二进制 |
| `devora-darwin-x64` | macOS x64 二进制 |
| `devora-linux-arm64` | Linux ARM 二进制 |
| `devora-linux-x64` | Linux x64 二进制 |
| `devora-win32-arm64` | Windows ARM 二进制 |
| `devora-win32-x64` | Windows x64 二进制 |
