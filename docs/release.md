# 发版流程 (Release)

MiMoCode 通过三个渠道分发：**GitHub Release**、**小米 FDS**(国内 CDN 加速)、**npm**。
三者用的是**同一批二进制**(同一次构建产物 `dist/`)。

> 关键前提：免费 `mimo-auto` 通道的代码在私有仓库 `mimoapi` 里，构建时注入。
> 所以**构建必须从 `mimoapi` 发起**(`scripts/release.sh`)，否则产物里没有 auto 通道。

以下以发布 `0.1.4` 为例，把 `NEW=0.1.4` 改成目标版本即可。

---

## 三条铁律(踩过的坑)

1. **构建永远从 `mimoapi` 发起**(`release.sh` / `build-full.ts`)——直接在 MiMo-Code 里 `build.ts` 会缺少 auto 注入的安全保护。
2. **每步显式带版本号**(`NEW` / `MIMOCODE_VERSION`)——不带会被识别成 `0.0.0-<分支>-<时间>` 的 preview 号。
3. **GitHub Release 建好就 `--draft=false`；npm 发完查 `dist-tags` 确认 `latest` 没跑到 `preview`。**

---

## 第 0 步：bump 版本号(在 MiMo-Code)

只需填一次新版本号，旧版本号自动探测。

```bash
cd <MiMo-Code>
git checkout main && git pull

NEW=0.1.4                        # ← 只改这一行

# 自动读当前版本(从 opencode 包)
OLD=$(grep -m1 '"version"' packages/opencode/package.json | sed -E 's/.*"version": "([^"]+)".*/\1/')
echo "bump: $OLD → $NEW"

# 替换所有 package.json 里的版本号
grep -rl "\"version\": \"$OLD\"" --include=package.json . | grep -v node_modules \
  | tr '\n' '\0' | xargs -0 perl -i -pe "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/"

# 校验:应只剩 NEW,无残留 OLD
grep -rh '"version"' --include=package.json . | grep -v node_modules | sort | uniq -c

bun install                      # 同步 bun.lock(关键,别漏)
git add -A && git commit -m "chore: bump version to $NEW"
git push                         # 直推 main,或开 PR 合并
```

> `bun install` 必须在打 tag 之前跑并提交，确保 tag 指向的 commit 里 `bun.lock` 已同步。

---

## 第 1 步：打 tag + 建 GitHub Release 壳

在 bump 提交**合并进 main 之后**、构建之前。

```bash
cd <MiMo-Code>
git checkout main && git pull    # 确保含 bump 提交

git tag v$NEW && git push origin v$NEW
gh release create v$NEW --repo XiaomiMiMo/MiMo-Code --target main \
  --title "v$NEW" --notes "MiMoCode v$NEW" --draft=false
```

> `build.ts` 用的是 `gh release upload`(不会自己创建 release)，所以必须先建壳。
> `--draft=false` 必须加，否则资产传上去后页面看不到。

---

## 第 2 步：构建 + 发 GitHub & FDS(一条命令)

```bash
cd <mimoapi>
git checkout main && git pull    # ext overlay 最新

./scripts/release.sh $NEW
```

`release.sh` 自动完成：载入 `.env` 的 FDS 凭证 → 注入 ext overlay → 全平台构建(12 个包)
→ 传 GitHub Release → 传 FDS(`releases/v$NEW/*` + `releases/latest`)→ 清理注入。

> 报 `src/ext already exists` → 上次残留没清，先 `rm -rf <MiMo-Code>/packages/opencode/src/ext` 再重跑。

---

## 第 3 步：发 npm(复用第 2 步的 dist，不要重新构建)

```bash
cd <MiMo-Code>/packages/opencode
npm whoami                       # 确认登录了有 @mimo-ai 权限的账号

export MIMOCODE_VERSION=$NEW
bun run script/publish.ts

# 发完确认 latest tag 正确(历史上出现过误进 preview)
npm view @mimo-ai/cli dist-tags
# 若 latest 没指向新版本,手动修:
npm dist-tag add @mimo-ai/cli@$NEW latest
```

> npm 主包 `@mimo-ai/cli` 不含二进制，只是启动器壳；真二进制在按平台拆分的
> `@mimo-ai/mimocode-<os>-<arch>` 子包里，靠 `optionalDependencies` + `os`/`cpu` 按需安装。
> 这些子包由 `build.ts` 写进 `dist/`，`publish.ts` 一并发布。

---

## 第 4 步：mimoapi 打 tag 留痕

记录这版 auto 通道对应的 `mimoapi` commit，便于复现。

```bash
cd <mimoapi>
git tag v$NEW && git push origin v$NEW
```

---

## 第 5 步：验证三渠道

```bash
# GitHub:12 个资产
gh release view v$NEW --repo XiaomiMiMo/MiMo-Code --json assets -q '.assets|length'

# FDS:版本指针 + 包可下
curl -fsSL https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/latest          # → $NEW
curl -sI -o /dev/null -w "%{http_code}\n" \
  https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/v$NEW/mimocode-darwin-arm64.zip   # → 200

# npm:版本 + tag
npm view @mimo-ai/cli@$NEW version
npm view @mimo-ai/cli dist-tags          # latest 应指向 $NEW(正式版时)
```

验证 auto 通道：装好后跑 `mimo models`，应能看到 `mimo/mimo-auto`。

---

## 安装方式(供 README / 用户参考)

| 方式 | 命令 | 依赖 |
|---|---|---|
| 一键脚本(国内走 FDS) | `curl -fsSL https://mimo.xiaomi.com/install \| bash` | 仅需 curl + tar/unzip |
| npm | `npm install -g @mimo-ai/cli` | node/npm |
| 指定版本(npm) | `npm install -g @mimo-ai/cli@<版本>` | node/npm |
| 本地二进制 | `./install --binary <path-to-mimo>` | 无(离线) |
