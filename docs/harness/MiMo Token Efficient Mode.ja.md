# MiMo Token Efficient Mode

**一言まとめ**: 汎用正規表現フィルタパイプライン + ヒューリスティックフィルタパイプラインを使って Bash 出力の冗長トークンを除去する（実験機能、デフォルト無効）。

## 1. 背景と目的

bash ツールの stdout/stderr は、以下のノイズによってコンテキストが「膨れ上がる」ことがよくあります：

- ANSI カラーコード、OSC ハイパーリンク、DCS 端末制御シーケンス

- `\r` プログレスバーの複数フレーム重ね書き

- 誤って出力された API key / JWT / PEM 証明書

- minified JS / 単一行 JSON などの超長行

- pytest / go test / … などの無効情報

**中心的な制約**: クリーンアップは LLM に対してのみ行う。TUI のリアルタイムプレビューとディスクへのアーカイブは、人手デバッグのために元のバイト列を保持する。

## 2. 全体フロー

以下の図は、bash ツール出力がキャプチャされてから LLM に届くまでのエンドツーエンドのクリーンアップ経路を示しています。汎用フィルタパイプライン（第 3 章）、ヒューリスティックフィルタパイプライン（第 4 章）、および inline / 落盤 / TUI の 3 経路分岐制約（第 5 章）を統合しています。

図中における 3 つの中心的制約の位置：

- **inline のみクリーン、ディスクは触らない** — 入口分岐の最も左側の 2 経路（ディスクアーカイブ / TUI プレビュー）はパイプライン全体をバイパスする。

- **never-worse ガード** — パイプライン末尾で統一的にロールバック：いずれかの段階で出力が大きくなった場合は破棄し、Raw 経路に戻す。

- **単一フラグ、デフォルト無効** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` がクリーンアップパイプラインに入る唯一のスイッチで、デフォルト無効。そうでなければ Raw で直通する。




## 3. 汎用フィルタパイプライン



|**レイヤー名**|**役割**|**主要な正規表現 / アルゴリズム**|**順序制約**|
|---|---|---|---|
|clean_progress_pipeline|行単位で \r プログレスバーを折り畳み、最後のフレームのみ残す|行で分割し、各行の最後の \r 以降のセグメントを取る|clean_ansi_pipeline より前に実行必須|
|clean_ansi_pipeline|ANSI CSI/OSC/DCS、バックスペースの overstrike、制御バイトを除去|4 つの ESC シーケンス正規表現 + 制御バイト文字クラス|progress の後、下流の正規表現より前|
|clean_redact_pipeline|PEM、Bearer、JWT、AWS/GH/OpenAI/Anthropic/Slack のキー|8 グループの正規表現 + 複数行 PEM ブロック全体置換|重複除去/切り詰めより前に必ず行う|
|clean_longline_pipeline|500 文字を超える単一行を、先頭 160 文字 + 省略ヒントに圧縮|行スキャン、長さ閾値判定|セーフティネットとして最後に配置|
|never-worse ガード|クリーンアップ後のバイト数が減っていなければ元テキストへロールバック|bytesOut ≥ bytesIn の場合、元 text を返す|パイプライン末尾|

### 3.1 各レイヤーの正規表現クイックリファレンス

以下の定数は `packages/opencode/src/tool/bash_token_efficient.ts` の実装に直接対応します。L1 / L4 は行スキャンアルゴリズムで単独の正規表現はありません。L0 / L3 で計 14 個の正規表現（4 個の ESC + 1 個の制御バイト + 1 個の複数行 PEM + 8 個の行内シークレット）を定義しています。

**L0 clean_ansi — 4 つの ESC 正規表現 + 1 つの制御バイト文字クラス**

```ts
const ANSI_CSI   = /\x1b\[[0-?]*[ -/]*[@-~]/g              // CSI シーケンス  ESC[ ... 終端子
const ANSI_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g    // OSC シーケンス  ESC] ... BEL または ESC\
const ANSI_DCS   = /\x1b[PX^_][\s\S]*?\x1b\\/g             // DCS/SOS/PM/APC 複数行シーケンス
const BACKSPACE  = /[^\n]\x08/g                            // バックスペース overstrike  マッチがなくなるまでループ置換
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g     // 制御バイト  \t \n \r は保持
```

**L3 clean_redact — 複数行 PEM ブロック全体 1 個 + 行内シークレット 8 個**

```ts
// 複数行 PEM ブロック全体置換 → <redacted-pem-block>
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi,                          "$1 <redacted>"],
  // JWT  eyJ に続く 3 つの base64url セグメント（各 ≥10 文字）
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,    "<redacted-jwt>"],
  // AWS アクセスキー  AKIA / ASIA プレフィックス + 16 個の大文字英数字
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                        "<redacted-aws-key>"],
  // GitHub fine-grained / classic  gh[pousr]_ + 20 文字以上
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                       "<redacted-gh-token>"],
  // OpenAI  sk- + 20 文字以上
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g,                                           "<redacted-openai-key>"],
  // Anthropic  sk-ant- + 20 文字以上
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,                                       "<redacted-anthropic-key>"],
  // Slack  xox[abprs]- + 10 文字以上
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,                                    "<redacted-slack-token>"],
  // 汎用 KEY=VALUE / "key": "value"  値 12 文字以上
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]
```

**L1 clean_progress — `\r` プログレスバーを行単位で折り畳み**

```ts
// アルゴリズム  単独の正規表現なし
text.split("\n").map(line => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  const idx = stripped.lastIndexOf("\r")
  return idx === -1 ? stripped : stripped.slice(idx + 1)   // 最後のフレームのみ残す
}).join("\n")
```

**L4 clean_longline — 超長単一行の圧縮**

```ts
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

text.split("\n").map(line => {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
}).join("\n")
```

**never-worse ガード — パイプライン末尾でのロールバック**

```ts
const bytesOut = Buffer.byteLength(out, "utf-8")
if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
  return { text, bytesIn, bytesOut: bytesIn, degraded: true }   // 削減できていない  元テキストを返す
}
```

## 4. ヒューリスティックフィルタパイプライン

### 4.1 二経路シェイプ判定

コマンド名だけを見てはいけません（ユーザーはよくパイプをネストします：`bash -c "cd x && pytest"`）。出力の先頭だけ見てもいけません（最初の 30 行がすべて ANSI ノイズかもしれない）。2 つの経路を直列に実行します：

```ts
// コマンド名経路
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

// コンテンツ指紋経路（コマンド名がヒットしない場合のフォールバック）
const BODY_FINGERPRINTS: Array<[RegExp, ShapeID]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m,                          "gitdiff"],
  [/^Traceback \(most recent call last\)/m,  "stacktrace"],
  [/^\s*at .+:\d+:\d+/m,                     "stacktrace"],
  [/^error\[E\d+\]:/m,                       "stacktrace"],
]
```

### 4.2 シェイプ戦略クイックリファレンス

|**コマンドマッチ**|**主要トリミングルール**|**期待減量**|
|---|---|---|
|git diff / git show|lockfile / min.js / dist パスのホワイトリストで丸ごと抑制；ハンク単位で 100 行の上限；ファイル末尾に +added -removed を付加|85%|
|pytest|4 状態のステートマシン Header → TestProgress → Failures → Summary、collected / E 行 / file:line: / FAILED / short summary を保持|90%|
|npm/pnpm/yarn install|連続する npm warn deprecated を [×N deprecation warnings: top: A, B, C] にまとめ、added/vuln/funding のサマリーを保持|65%|
|make / cmake / automake|Entering/Leaving directory、素のコンパイルコマンド、キャレットを削除；file:line:col: error: とその下の note: を保持|53%|
|Traceback / at ...:N:N / error[E...]|site-packages / .venv / node_modules / stdlib フレームを折り畳み、2 つ以上連続する場合は [N dependency frame(s) suppressed] に統合|69%|
|tsc|エラーコード別 Top-5 を 1 行サマリー；ファイル別 Top-8；各グループにつき 1 サンプルを保持|80%|
|kubectl get pods|trailer で -o json を推奨；クライアント側は「全 Running/0 restart」の連続行だけ折り畳み、列は書き換えない|70%|
|出力が { または [ で始まる|2 モード：デフォルトは embedding/raw_html/body/content/base64 の大きなフィールドをトリム；schema-only モードはキーと型を推論|95%|
|gh pr view / gh issue view|HTML コメント、バッジ行、純粋な画像行、装飾的な ---、連続する空行を除去|~50%|
|go test ... -json|NDJSON ストリーム集約：pkg ごとに pass/fail/skip を累積；fail 時は累積 output を cause として使用|90%|

### 4.2 コマンドレベルパススルー

ユーザーがすでに投影処理をしている場合、そのまま通してクリーンアップしない：

- コマンドに `--json` / `--format json` / `-o json` / `--no-color` を含む

- コマンドの末尾に `| tee` / `| xxd` / `| hexdump` を含む

- コマンドに `# nofilter` / `# raw` を含む（実装済み）

### 4.5 拡張契約

新しいシェイプを追加するには `Shape { match, apply }` インターフェースを実装するだけで、メインエントリはゼロ侵襲：

```TypeScript
export interface Shape {
  id: string
  match: (command: string, head4k: string, tail4k: string) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

const SHAPES = [S_gitdiff, S_pytest, S_npm, S_make, S_stacktrace,
                S_tsc, S_kubectl, S_json, S_md, S_gostest]
```



## 5. その他の詳細

**inline のみクリーン、ディスクは触らない** — truncation file に到達したら（早期のストリームオーバーフローでも、末尾の `trunc.write(raw)` でも）クリーンアップはスキップ。ディスクアーカイブは元のバイト列を保持して人手 grep しやすくし、inline 出力のみをクリーンアップパイプラインに通して、最も読まれる経路にバイトの節約を集中させる。

**TUI プレビューは触らない** — `metadata.output` は TUI のリアルタイムプレビューフィールドで、元のストリーミングスナップショットのまま保持する。最終的な `output` のみがクリーンアップを通る。クリーンアップの副作用が、人が元の端末出力を読み取る判断を妨げるのを避ける。

**単一フラグ、デフォルト無効** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` は独立したフラグで、デフォルトは無効。`MIMOCODE_EXPERIMENTAL=1` から派生しない。明示的オプトインで、デフォルト出力を静かに変更するのを避ける。

