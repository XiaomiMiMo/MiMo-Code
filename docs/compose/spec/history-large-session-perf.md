---
feature: history-large-session-perf
status: delivered
updated: 2026-09-08
branch: fix/history-large-session-perf
commits: e93a49cd97954df8cedbeff71d5f7230f6f8cc1d..0aa1d29f87810a24a142199dc45135f95e137753
---

# History 大会话检索与按需详情

## Report

**What was built** — history search/around 返回有界摘要、原始 part_id 与省略提示。get 通过 part_id 定点读取原始详情，以 UTF-16 游标连续分页；媒体默认列出定位符，显式单选后通过既有附件通道返回，遵守模型能力与文件权限边界。派生全文索引移除明确 data URL 载荷，原始数据不变；新增迁移让旧派生索引在后台重新构建，期间搜索可能暂时不完整。

工作区为 `/Users/mi/projects/mi/mimocode/.worktrees/history-large-session-perf`，分支 `fix/history-large-session-perf`，基线和当前 HEAD 均为 `e93a49cd97954df8cedbeff71d5f7230f6f8cc1d`。用户确认不自动提交；上述 commits 字段仅记录基线，实际审查范围为 `git diff HEAD` 加全部新增实现、测试及迁移文件，未提交、未推送、未合并。独立审查及复审完成，规格、正确性和代码库一致性均 PASS，无剩余 critical。

**Verification** — 命令在 `packages/opencode` 下执行：

- `bun test test/history test/tool/history.test.ts test/session/tool-attachment.test.ts --timeout 120000`：57 pass、6 个按需 benchmark skip、0 fail、320 assertions。
- `bun typecheck`：PASS。
- `bunx --no-install oxlint -c "$PWD/../../.oxlintrc.json" --no-ignore <改动 TS 文件绝对路径>`：全量 11 个改动文件 0 errors、49 warnings；审查修复后的 5 个受影响文件复验 0 errors、21 warnings。包含既有 any 与数据库类型断言警告，不声明零警告。
- `git diff --check`：PASS。
- `for variant in none file attachment input output-default output-enabled; do HISTORY_BENCH=1 HISTORY_BENCH_CASE="$variant" bun test test/history/large-session.bench.test.ts --timeout 120000 || break; done`：六个独立进程各 1 pass、11 assertions。

Bun 1.3.14；隔离合成内存数据库；每场景 1,000 条消息、1,006 个 part；媒体场景包含 6×8MiB base64 编码。下表单位 ms，搜索热值为连续三次中位数，首次是 seed 后首次调用，不是磁盘冷启动。旧值来自本次会话修改前基准，新值来自审查修复后主代理重新执行的相同负载；不同测量时间存在机器负载波动。

| 场景 | 首次回填旧 → 新 | 定向搜索热值旧 → 新 | around 首次旧 → 新 |
|---|---:|---:|---:|
| 无媒体 | 171.97 → 206.49 | 0.14 → 0.14 | 0.55 → 0.53 |
| file.url | 317.43 → 194.30 | 0.09 → 0.08 | 25.76 → 12.32 |
| tool attachments | 299.93 → 208.62 | 0.10 → 0.10 | 22.03 → 12.55 |
| tool input 内联 | 1738.98 → 361.96 | 79.64 → 0.13 | 34.83 → 12.45 |
| tool output 默认配置 | 327.60 → 196.82 | 0.17 → 0.12 | 25.99 → 15.85 |
| tool output 启用索引 | 1681.98 → 404.68 | 81.34 → 0.11 | 32.45 → 12.97 |

file 场景定向 tool 搜索无命中，不能当成图片正文搜索加速。无媒体首次回填实测增加 34.52ms，不宣称所有场景更快。input 的索引正文字节从 50,359,946 降至 28,424；启用 output 的索引正文字节从 50,359,940 降至 28,418。首次回填包含既有批次/会话 sleep。没有读取或迁移真实用户数据库，没有磁盘冷缓存、峰值内存、独立 Node 运行时或端到端 TUI 实测；附件通道用真实工具封装与路由测试验证，但未调用在线视觉模型。get 仍会解析单个原始大 part，不承诺流式读取。

**Journey log**

1. 普通短文本命中掩盖内联图片的 FTS 开销；必须以 tool_name 定向查询大正文。
2. JS 逐字节清洗让 around 首轮回退；改用分块原生字符集合扫描，并在 SQL 预览阶段省略大字段，保留 get 完整读取。
3. SQLite length(TEXT) 遇 NUL 截断计数；改用 BLOB 字节长度并加真实投影回归。
4. 摘要与详情的 JSON 遍历顺序不一致，不能共享位置序号；可用附件定位符只由 get 生成。
5. 一次媒体扫描优化发生子代理同时写入，已终止并发编辑并由主代理接管；最终回归、类型检查及基准均在写入停止后重跑。

## [S1] Problem

含图片的历史会话存在两类成本：file/attachments 完整 JSON 被加载后丢弃；工具输入或启用的输出内联 data URL 被全文索引。隔离合成基准（1,000 消息、6×8MiB 编码）中，大正文定向搜索热耗时约 80ms，基线约 0.14ms。用户需要轻量搜索，同时不能失去按需恢复原始信息的能力。

## [S2] Design

### 搜索与上下文

保留现有 search 过滤及 BM25 排序；展示稳定 part_id、message_id 与摘要提示，明确可调用 history operation=get part_id=...。摘要按字符和总输出字节预算截短，不能仅依赖 FTS token 数。around 保留消息导航、暴露 part_id，改为有限摘要并指向 get；超过 4,000 UTF-8 字节的单字段（包含 NUL）在 SQL 投影阶段整段替换为明确省略提示，详情仍可用 get 完整分页读取。search/around 不自动发送媒体；媒体编码不进入文本输出。

### 按需详情

新增 operation=get，以 part_id 定位原始 PartTable，而非派生 FTS；不存在时明确返回未找到。offset 为非负 UTF-16 游标，length 为正整数，默认 4,000、最大 8,000；文本响应整体不超过 20KiB，返回实际 next_offset、total_length、has_more，连续分页不丢字且不切断代理对。分页对象是确定性的详情文本：text/reasoning 原文，tool 的 input/output/error，媒体用定位占位符替代。保留普通长文本，不任意截断索引正文。

search/around 中的媒体占位仅指向 get，不提供附件序号；可用媒体定位符以 get 返回为准。get 默认返回媒体定位信息而非图片。attachment 参数显式选取一个媒体；定位符在原 part 不变时稳定，覆盖 file、tool attachments 及文本/工具 JSON 中被省略的 data URL。一次至多返回一个附件，通过现有工具附件通道，保留原 MIME/URL，不复用旧 part 身份。受模型能力与现有路由限制的媒体明确提示不能显示，不谎称已识图。不从历史 file:// 路径绕过 read 的权限读取，不主动下载外部 URL。

### 派生文本与读取成本

writer/backfill/get/around 共用明确 data URL 识别规则，剔除 base64 载荷并保留周围文字、媒体类型及按需读取线索。不猜测普通长字母数字串是图片，不改原始 PartTable。线性扫描避免巨型正则栈/回溯问题。

回填与 around 在数据库读取阶段投影需要的字段，避免将 file URL、tool attachments 等无用巨型载荷传入 JS；保留分页扫描完整性与启用 kinds 的语义。SQL JSON 提取仍有解析成本，不承诺零磁盘读取。get 仅定点读取一个 part，不承诺流式解析巨型 JSON。

旧派生索引通过新增一次性迁移失效并后台重建，原始会话不变。重建期间搜索可能暂时不完整，get 按已知 ID 仍有效；不中途改写历史来源，不执行 VACUUM。迁移需测试旧数据升级与中断后幂等回填。

## [S3] Out of Scope

不做 OCR/图片语义检索、图片存储迁移、任意裸 base64 启发式识别、自动下载历史媒体、FTS tokenizer 更换或 writer 队列架构重构。不操作用户真实历史数据库，不自动提交、推送或合并。

## Tasks

- [x] T1: 统一媒体清洗与旧索引升级 — acceptance: 明确 data URL 编码不进入 FTS，邻近文字仍命中；原始值可取回，升级与重跑不漏文本 (covers: S2)
- [x] T2: get 分页与显式单附件 — acceptance: 长文本/CJK/emoji 连续页完整，未知 ID/非法参数明确反馈；内联与原生附件可按定位符取回 (covers: S2; depends: T1)
- [x] T3: 轻量 search/around 与回填投影 — acceptance: 输出在预算内且带 part_id/省略提示；超过500个混合 part 不漏索引；file/attachments 不完整物化进 JS (covers: S2; depends: T1)
- [x] T4: 验证与独立审查 — acceptance: history/tool 回归、包 typecheck、相关 lint 通过；六场景基准记录修复前后和限制；独立审查无未解决 critical (covers: S2; depends: T2,T3)
