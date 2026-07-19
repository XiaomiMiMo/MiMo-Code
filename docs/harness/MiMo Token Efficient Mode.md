# MiM Token Efficient Mode

**一句话总结**：使用通用正则过滤pipeline \+ 启发式过滤pipeline过滤Bash Output中冗余token（实验功能，默认关闭）

## 1\. 背景与目标

bash 工具的 stdout/stderr 经常被以下噪音"撑爆"上下文：

- ANSI 色码、OSC hyperlink、DCS 终端控制序列

- `\r` 进度条多帧重叠

- 误打印的 API key / JWT / PEM 证书

- minified JS / 单行 JSON 等超长行

- pytest/go test/\.\.\.等无效信息

**核心约束**：清理只面向 LLM；TUI 实时预览与磁盘归档保持原始字节，便于人工 debug。

## 2\. 整体流程

下图给出 bash 工具输出从捕获到送达 LLM 的端到端清理路径，整合了通用过滤管线（第 3 章）、启发式过滤管线（第 4 章）以及 inline / 落盘 / TUI 三路分流约束（第 5 章）。

三条核心约束在图中的位置：

- **仅清 inline，不清落盘** — 入口分流的最左侧两路（落盘归档 / TUI 预览）直接绕开整条管线。

- **never\-worse 守门** — 管线尾部统一回吐：任何阶段使输出变大都被丢弃，回到 Raw 路径。

- **单 flag、默认关** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` 是进入清理管线的唯一开关，且默认关闭，否则走 Raw 直出。





## 3\. 通用过滤管线



|**层名**|**职责**|**关键正则 / 算法**|**顺序约束**|
|---|---|---|---|
|clean\_progress\_pipeline|按行折叠 \\r 进度条，只保留最后一帧|按行切分后取每行最后一个 \\r 之后的片段|必须先于 clean\_ansi\_pipeline|
|clean\_ansi\_pipeline|剥 ANSI CSI/OSC/DCS、退格 overstrike、控制字节|4 条 ESC 序列正则 \+ 控制字节字符类|progress 之后，下游正则之前|
|clean\_redact\_pipeline|PEM、Bearer、JWT、AWS/GH/OpenAI/Anthropic/Slack 密钥|8 组正则 \+ 跨行 PEM 块整体替换|去重截断前必须先做|
|clean\_longline\_pipeline|单行超 500 字符压成 head 160 字符 \+ 省略提示|按行扫描，长度阈值判定|放最后兜底|
|never\-worse 守门|清理后字节数没变小则回吐原文|bytesOut ≥ bytesIn 时返回原 text|管线尾部|

### 3\.1 各层正则速查

下列常量直接对应 `packages/opencode/src/tool/bash_token_efficient.ts` 实现。L1 / L4 是按行扫描算法，无单独正则；L0 / L3 共 14 条正则（4 ESC \+ 1 控制字节 \+ 1 跨行 PEM \+ 8 行内密钥）。

**L0 clean\_ansi — 4 ESC 正则 \+ 1 控制字节字符类**

```ts
const ANSI_CSI   = /\x1b\[[0-?]*[ -/]*[@-~]/g              // CSI 序列  ESC[ ... 终止符
const ANSI_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g    // OSC 序列  ESC] ... BEL 或 ESC\
const ANSI_DCS   = /\x1b[PX^_][\s\S]*?\x1b\\/g             // DCS/SOS/PM/APC 跨行序列
const BACKSPACE  = /[^\n]\x08/g                            // 退格 overstrike  循环替换至无匹配
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g     // 控制字节  保留 \t \n \r
```

**L3 clean\_redact — 1 跨行 PEM 整块 \+ 8 条行内密钥**

```ts
// 跨行 PEM 块整体替换 → <redacted-pem-block>
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi,                          "$1 <redacted>"],
  // JWT  eyJ 三段 base64url（每段 ≥10 字符）
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,    "<redacted-jwt>"],
  // AWS access key  AKIA / ASIA 前缀 + 16 大写字母数字
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                        "<redacted-aws-key>"],
  // GitHub fine-grained / classic  gh[pousr]_ + ≥20 字符
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                       "<redacted-gh-token>"],
  // OpenAI  sk- + ≥20 字符
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g,                                           "<redacted-openai-key>"],
  // Anthropic  sk-ant- + ≥20 字符
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,                                       "<redacted-anthropic-key>"],
  // Slack  xox[abprs]- + ≥10 字符
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,                                    "<redacted-slack-token>"],
  // 通用 KEY=VALUE / "key": "value"  ≥12 字符值
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]
```

**L1 clean\_progress — 按行折叠 ****`\r`**** 进度条**

```ts
// 算法 无单独正则
text.split("\n").map(line => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  const idx = stripped.lastIndexOf("\r")
  return idx === -1 ? stripped : stripped.slice(idx + 1)   // 只留最后一帧
}).join("\n")
```

**L4 clean\_longline — 单行超长压缩**

```ts
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

text.split("\n").map(line => {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
}).join("\n")
```

**never\-worse 守门 — 管线尾部回吐**

```ts
const bytesOut = Buffer.byteLength(out, "utf-8")
if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
  return { text, bytesIn, bytesOut: bytesIn, degraded: true }   // 没省到 退原文
}
```

## 4\. 启发式过滤管线

### 4\.1 双通道形状识别

不能只看命令名（用户常 pipe 嵌套：`bash -c "cd x && pytest"`），也不能只看输出开头（前 30 行可能全是 ANSI 噪音）。两路串行：

```ts
// 命令名通道
const COMMAND_PATTERNS: Array<[RegExp, ShapeID]> = [
  [/^pytest(\s|$)/,                "pytest"],
  [/^(npm|pnpm|yarn)\s+(install|i|add)/, "npm"],
  [/^(make|cmake|automake)/,       "make"],
  [/^git\s+diff/,                  "gitdiff"],
  [/^tsc(\s|$)/,                   "tsc"],
  [/^kubectl\s+get\s+pods?/,       "kubectl"],
  [/^go\s+test.*-json/,            "gostest"],
  [/^gh\s+(pr|issue)\s+view/,      "md"],
]

// 内容指纹通道（命令名未命中时兜底）
const BODY_FINGERPRINTS: Array<[RegExp, ShapeID]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m,                          "gitdiff"],
  [/^Traceback \(most recent call last\)/m,  "stacktrace"],
  [/^\s*at .+:\d+:\d+/m,                     "stacktrace"],
  [/^error\[E\d+\]:/m,                       "stacktrace"],
]
```

### 4\.2 形状策略速查

|**命令匹配**|**核心剪裁规则**|**预期减量**|
|---|---|---|
|git diff / git show|lockfile / min\.js / dist 路径白名单整段抑制；单 hunk 100 行 cap；文件尾追加 \+added \-removed|85%|
|pytest|4 态状态机 Header → TestProgress → Failures → Summary，保留 collected / E 行 / file:line: / FAILED / short summary|90%|
|npm/pnpm/yarn install|连续 npm warn deprecated 折成 \[×N deprecation warnings: top: A, B, C\]，保留 added/vuln/funding 摘要|65%|
|make / cmake / automake|砍 Entering/Leaving directory、bare 编译命令、caret，保留 file:line:col: error: 及下方 note:|53%|
|Traceback / at \.\.\.:N:N / error\[E\.\.\.\]|折 site\-packages / \.venv / node\_modules / stdlib 帧，连续 ≥2 合并为 \[N dependency frame\(s\) suppressed\]|69%|
|tsc|按错误码 group Top\-5 一行汇总；按文件 group Top\-8；每组留 1 样本|80%|
|kubectl get pods|trailer 建议 \-o json；客户端只折"全 Running/0 restart"连续行，不重写列|70%|
|输出以 \{ 或 \[ 开头|双模式：默认裁 embedding/raw\_html/body/content/base64 大字段；schema\-only 模式推断键加类型|95%|
|gh pr view / gh issue view|清 HTML 注释、徽章行、纯图片行、装饰 \-\-\-、多空行|\~50%|
|go test \.\.\. \-json|NDJSON 流式聚合：按 pkg 累 pass/fail/skip；fail 时把累积 output 作 cause|90%|

### 4\.2 命令层 passthrough

用户已经在做投影时直接放行，不再清理：

- 命令含 `--json` / `--format json` / `-o json` / `--no-color`

- 命令尾含 `| tee` / `| xxd` / `| hexdump`

- 命令含 `# nofilter` / `# raw`（已实现）

### 4\.5 扩展契约

新增形状只需实现 `Shape { match, apply }` 接口，主入口零侵入：

```TypeScript
export interface Shape {
  id: string
  match: (command: string, head4k: string, tail4k: string) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

const SHAPES = [S_gitdiff, S_pytest, S_npm, S_make, S_stacktrace,
                S_tsc, S_kubectl, S_json, S_md, S_gostest]
```



## 5\. 其他细节

**仅清 inline，不清落盘** — 只要走到 truncation file（早期流式溢出或末尾 `trunc.write(raw)`），就跳过清理。落盘归档保持原始字节，方便人工 grep；inline 输出才进清理管线，把节省字节用在最常被读到的路径上。

**TUI 预览不动** — `metadata.output` 是 TUI 实时预览字段，保持原始流式快照；只有最终 `output` 经过清理。避免清理副作用打断人对原始终端输出的判读。

**单 flag、默认关** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` 一个独立 flag 控制开关，默认关闭，不被 `MIMOCODE_EXPERIMENTAL=1` 派生。显式 opt\-in，避免静默改变默认输出。

