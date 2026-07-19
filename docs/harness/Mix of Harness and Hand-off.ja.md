# Mix of Harness && Hand-off の仕組み

**一言で言えば**：**Codex CLI** と **Claude Code CLI** を呼び出し可能な実行器として skill にラップし、MiMoCode が「低収益ループ」に陥ったとき、現在の turn を一時停止して、ユーザーがワンクリックで別の harness に作業を引き継げるようにする仕組みです。制御プレーンは MiMoCode セッションに残り、実行プレーンは選択した harness で動作します。この 2 つのプレーンは分離されています。

対応 harness：**Codex CLI** && **Claude Code CLI**。

---

## 1. Mix of Harness が必要な理由

単一の harness は、そもそも不得意なタスクに遭遇しても、ほとんど自力で立て直せません。Codex は楽観的で完了を早まって宣言しやすく、Claude Code はより細かく探索しますが、明確な指示のもとでは似た diff を何度も書き直す状態に陥りがちです。本当の失敗シグナルは「ある手順が失敗した」ことではなく、**token を使い続けても progress が得られない**ことです。同じファイルを繰り返し編集する、同じ bash コマンドをそのまま再試行する、探索と変更の比率が改善しない、といった状態が該当します。

Mix of Harness（以下 MoH）は、各 harness を MiMoCode が skill 経由で起動し、サブプロセスとして実行できる実行器にすることで、この問題を解決します。**Try-Best 検出器**が現在の turn の健全性を監視し、低収益ループを検出すると turn を一時停止して、より適切な harness をユーザーに選んでもらいます。

**中核となる境界**：MoH は**セッションの provider/model を切り替えません**。「Codex CLI に引き継ぐ」または「Claude Code CLI に引き継ぐ」を選んだ後も、セッションは元の MiMoCode セッション、モデルも元のモデルのままです。対応する skill をロードし、選択した harness に実行を委譲するよう指示されるだけです。そのため、コンテキスト、タスクパネル、メモリ、承認ルーティングを再構築する必要はありません。

---

## 2. SKILL の設計

Codex と Claude Code は、それぞれ **built-in skill** としてラップされ、パスは `<data>/builtin_skills/local/skills/codex/` と `<data>/builtin_skills/local/skills/claude-code/` です。各 skill ディレクトリの内容は次のとおりです。

```
codex/
  SKILL.md                # トリガー説明 + 操作ルール（headless 優先、--yolo 以外の対話を無効化）
  agents/openai.yaml
  references/
    recipes.md            # codex exec の一般的なパターン
    windows.md            # ネイティブ PowerShell / WSL2 を分けて扱う際の注意事項

claude-code/
  SKILL.md
  references/
    config.md
    flags.md
    interactive-tmux.md
    platforms.md
    print-mode.md
```

SKILL.md が入口であり、`description` フィールドが skill router のトリガー条件を決めます。原則は、**skill がそのまま実行可能な CLI コマンドテンプレートを提供する**ことです。たとえば Codex skill は、すぐに次を提示します。

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "<TASK>"
```

モデル自身に flag の組み合わせを調べさせることはしません。プラットフォーム間の差異（macOS/Linux、Windows PowerShell、WSL2）は `references/` 配下の文書で補完します。

> **組み込みツールではなく、独立した skill にする理由は？** harness の操作詳細を skill 内に保持し、モデルの prompt と一緒に注入できるためです。ツール層は「サブプロセスを実行する」能力だけを公開します。skill の更新、プラットフォーム差異、flag の変更は、コードを変更せずに skill ディレクトリを置き換えるだけで対応できます。

---

## 3. MoH の 5 つのモード

タスクによって必要なオーケストレーション構造は異なります。現在の MoH は次の 5 モードに対応しており、**Fallback が MiMoCode のデフォルトモード**です。つまり、Try-Best 検出と Hand-off が自動的に組み込まれる経路です。

### 3.1 Single

```
Task → Codex → Validator
```

単一の harness を直接実行し、最後に validator を接続します。特定の harness を完全に信頼でき、タスク範囲が明確な場合に適しています。

### 3.2 Fallback（デフォルト）

```
Task → MiMoCode
          │ 失敗/停滞
          ▼
        Codex / Claude Code
```

MiMoCode が最初に自分で作業します。失敗/停滞シグナルを検出すると、ユーザーが別の harness を選んで引き継がせます。一般的な検出ルールは次のとおりです。

- 同種ツールが N 回連続で失敗
- X 分を超えてファイル変更がない
- コンテキスト圧縮の回数が多すぎる
- テスト結果が連続して改善しない
- コストが予算の 80% を超える
- 最終出力に必須 artifact がない

Try-Best 検出器（§4 を参照）は、このうち turn 内でリアルタイムに判定できるルールを実装しています。

### 3.3 Pipeline

```
Claude Code が調査
       ↓ HandoffPacket
Codex が実装
       ↓ Patch
MiMoCode がレビュー
       ↓ Findings
Codex が修正
```

段階を直列につなぎ、各段階に最適な harness を使い、隣接する段階の間では構造化 packet でコンテキストを渡します。段階の境界が明確なタスク（理解してから変更する、実装後にレビューする）に適しています。

### 3.4 Parallel Competition

```
               ┌→ Claude Code → Patch A ┐
Task → Fork ───┤                        ├→ Evaluator
               └→ Codex        → Patch B ┘
```

同じ作業を別々に実行し、最後に evaluator が採用する案を選びます。境界が曖昧で複数の進め方があり、確率に賭ける価値がある場合に適しています。**コストが高い**ため、デフォルトにはしません。

### 3.5 Debate / Review

```
Codex Implementer → Claude Reviewer → Codex Repairer
```

1 つの harness が案を出し、別の harness が問題点を指摘し、最初の harness が修正します。正確性やセキュリティに敏感で、クロスチェックが必要な変更に適しています。

---

## 4. Hand-off の仕組み（Try-Best HandOff）

Try-Best HandOff は Fallback モードを自動化したものです。**turn 内でリアルタイムに**低収益ループを監視し、検出すると turn を一時停止し、その時点の証拠を記録して、選択権をユーザーに渡します。

### 4.1 「低収益ループ」とは何か

コーディング agent の失敗モードは、軌跡上で観測可能な形を持ちます。Try-Best は、その中でも強いシグナルを選びます。

- **ループと反復**。同じファイルを繰り返し編集する（edit 回数がしきい値を超える）、意味的に近い diff が連続する、同じ bash コマンドが繰り返し失敗した後もそのまま再試行される、といった状態です。これは最も強い失敗の予兆です。agent は一度ループに入ると、ほぼ自力で抜け出せず、token の消費を続けても無駄になります。実装上は、直近 N 件の tool call に対する**スライディングウィンドウ重複排除**で十分で、embedding は不要です。
- **進捗と消費の乖離**。粗い progress シグナル（合格したテスト数の変化、issue で言及されたファイルを diff がカバーする割合）を定義し、token burn rate と比較します。予算の 40% を消費しても progress がゼロなら、その harness はタスクに不向きだとほぼ判断でき、完了を待つより切り替えるほうがはるかに安価です。
- **迷走パターン**。探索段階でファイルを読むのは正常ですが、後半にも広範囲の grep を続ける、同じ大きなファイル群を繰り返し読む、issue と無関係なディレクトリを開く場合、repo の作業モデルを構築できていません。「直近 K ステップにおける新規情報操作と変更操作の比率」で定量化します。健全な軌跡では、この比率は時間とともに単調減少するはずです。
- **早すぎる完了宣言**。harness が done と宣言しても、軌跡内でテストを実行していない、またはテスト後に結果を確認していない状態です。**自己申告の完了状態を信用してはいけません**。この点で Codex は Claude Code より楽観的です。

### 4.2 検出の仕組み（3 種類の検出理由）

現在の `packages/opencode/src/session/try-best-detector.ts` の実装は、最初の 2 種類のシグナルを次の 3 ルールで検出します。

| Reason | 説明 | デフォルトしきい値 |
|---|---|---|
| `edit_repeat` | **同じファイル**への類似編集：diff を 3-shingle の集合に変換し、直近 12 件の edit イベントを **Jaccard 類似度**で比較。類似度 > 0.8 を 1 回の一致とする | 一致が累計 2 回以上で発火（つまり「3 回目の類似編集」） |
| `bash_retry` | 正規化後の bash コマンドが**連続して失敗**し、失敗出力も変化しない | 3 回連続 |
| `action_streak` | 同種の操作（`edit` または `verify`）が連続し、観測可能な改善がない | 4 回連続 |

タイムスタンプ、一時パス、ランダム seed による誤検出を避けるため、コマンドと結果を正規化します。

- コマンド：`/tmp/...` → `<TMP>`、6 桁以上の純粋な数値 → `<NUM>`、`--seed=xxx` → `<SEED>`
- 結果：`Ns / Nms / N seconds` のような所要時間も除去。2,000 文字を超える場合は先頭と末尾を半分ずつ残し、中央に `<TRUNCATED>` を挿入

`verify` 系コマンド（bun/npm/pnpm/yarn test/typecheck/lint/build、pytest、cargo test、go test、make test、tsc など）は `bash_retry` の判定に加わると同時に、`action_streak` にもカウントされます。

### 4.3 一時停止と永続化

いずれかの reason が検出されると、`SessionProcessor.detectTryBest` は次を実行します。

1. **monitor を reset**し、同じ turn で繰り返し発火するのを防ぎます。
2. **`ctx.blocked = true` に設定**し、processor が後続のモデル出力に `stop` を return して、prompt loop が現在の turn を直ちに終了するようにします。
3. **synthetic `TextPart` を書き込み**ます。`text` は人間が読める理由（"Try-best loop detected; this turn was paused. …"）で、`metadata.origin` には `kind: "try_best"`、現在の `providerID / modelID`、完全な `incident`（reason + evidence）が含まれます。**part が信頼できる事実の情報源**です。イベント購読者が切断しても、session の再起動時に part を走査して復元できます。
4. **`session.try_best.detected` イベントを発行**します。TUI はこれを購読し、即座に dialog を表示します。イベントは低遅延通知で、part がフォールバックになります。
5. **metrics イベント** `Metrics.TryBestDetected` を発行し、モデル/reason ごとの発火頻度を集計できるようにします。

### 4.4 ユーザーの選択（TUI dialog の 3 オプション）

一時停止後、TUI はタイトルが "Try-best loop detected — turn paused" の dialog を表示します。説明には具体的な証拠（例："Near-identical edits repeated 3 times in packages/opencode/src/foo.ts"）が含まれ、次の 3 つを選べます。

1. **Codex CLI に引き継いで続行**（`Hand off to Codex CLI`）
2. **Claude Code CLI に引き継いで続行**（`Hand off to Claude Code CLI`）
3. **現在のモデルを維持し、戦略を変えて続行**（`Continue with <model>`）—元のモデルに現在の approach を捨てて再計画させる

候補は**同じモデルファミリーを除外**します（`packages/opencode/src/cli/cmd/tui/util/handoff.ts` の `handoffTargets`）。

- 現在の provider が `openai`、またはモデル名に `gpt / codex` が含まれる → "Claude Code CLI" のみ表示（自分自身に再挑戦させない）
- モデル名に `anthropic / claude` が含まれる → "Codex CLI" のみ表示
- その他 → 両方を表示

同時に `sync.data.command` で対応する skill（`codex` / `claude-code`）が登録済みか確認し、未登録のオプションは無効化されます。

### 4.5 実行プロトコル（オーケストレーション型 handoff）

harness を選択しても、TUI は**セッションもモデルも切り替えません**。元の sessionID に `promptAsync` を送り、`<system-reminder>` を次の turn の入力にします（テンプレートは `formatHarnessReminder` を参照）。

```
<system-reminder>
Try-best loop detection paused the previous turn: <detail>
The user explicitly selected and authorized the <harness> harness to take over the unfinished work.
You MUST load and follow the `<skill>` skill now and invoke <harness> as the primary executor …
Give the selected harness the complete user goal, relevant workspace state, the failed approach, and all remaining validation requirements. Do not include credentials, secrets, or unrelated private data.
Stay in this CLI and supervise <harness> until it completes or reaches a concrete blocker …
Inspect the harness result and workspace changes, ensure its validation is complete, and report the final outcome to the user. Do not stop after merely launching the harness.
</system-reminder>
```

要点：

- **制御プレーン = 元のセッション**：タスクパネル、承認ルーティング、コンテキスト、メモリはすべて MiMoCode セッションに残り、harness は起動されたサブプロセスにすぎません。
- **実行プレーン = 選択した harness**：実際の調査、実装、修正、検証はすべてこのサブプロセス内で完了させます。system-reminder は「harness を参考として使うだけ」や「harness の launch 後すぐ return する」ことを明示的に禁止します。
- **元のモデルも引き続き存在**：skill の呼び出し、harness への作業のパッケージング、完了までの監督、ユーザーへの最終結果報告を担当します。制御権を手放すのではなく、harness のランタイム監督者になります。

「現在のモデルを維持し、戦略を変える」を選んだ場合は reminder を送らず、`ctx.blocked` を解除するだけです。元のモデルは次の turn で自ら再計画します。

---

## 5. 設定

### 5.1 マスタースイッチ

- **環境変数 `MIMOCODE_ENABLE_TRY_BEST_HANDOFF`**（デフォルト `true`）
  - `false` または `0` に設定 → loop 検出、turn の一時停止、handoff dialog の全機能を無効化。
  - 定義は `packages/opencode/src/flag/flag.ts`。

### 5.2 しきい値（`experimental.try_best`）

`mimocode.json` / config で検出しきい値を個別に上書きできます。

```json
{
  "experimental": {
    "try_best": {
      "edit_window": 12,
      "edit_similarity": 0.8,
      "edit_matches": 2,
      "action_streak": 4
    }
  }
}
```

各項目の意味：

| Key | デフォルト | 説明 |
|---|---|---|
| `edit_window` | 12 | 比較対象となる直近の edit イベント数 |
| `edit_similarity` | 0.8 | Jaccard 類似度のしきい値（0–1）。超えると 1 回の一致とみなす |
| `edit_matches` | 2 | 発火前に必要な類似一致の累計回数（つまり N+1 回目の編集で発火） |
| `action_streak` | 4 | progress のない `edit`/`verify` の連続回数 |

`bash_retry` の連続失敗回数は現在 3（`TRY_BEST_BASH_RETRIES`）に固定されており、config 項目はありません。

### 5.3 skill の登録状態

Hand-off dialog の 2 つの harness オプションを表示するには、`codex` と `claude-code` skill が `sync.data.command` に登録されている必要があります。未登録のオプションは、起動できない harness を選ばせないよう非表示になります。
