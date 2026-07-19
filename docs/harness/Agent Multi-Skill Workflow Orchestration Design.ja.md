# エージェントの複数 Skill 協調ワークフロー編成設計

**一言まとめ：** 複数 skill の参照 = ユーザーが複数の SKILL と質問を指定し、SKILL-Reminder がモデルに複数 SKILL ワークフローの作成を促し、最後にタスクを分解してディスクに保存して問題を解決する。

## 1. 設計の出発点

複数 skill のシナリオで解決すべきは、もはや「使うかどうか」ではなく「どう連携させるか」である。

❌ 従来のトリガーの問題
harness はクエリの意味からどの skill を有効化するかを推測する必要があり、トリガーの見逃しや誤発火が起きやすい。

✅ 明示的な `/skill` による解消
ユーザーが入力欄で直接 `/skill-a /skill-b` と書けば、トリガーは 100% 正確で、意味の曖昧さもない。

🎯 残された課題
複数 skill をどう編成するか：どちらが先か、データをどう受け渡すか、競合をどう裁定するか。

## 2. 三層の責務分担

| 層 | 責務 | 主なアクション | 失敗時のフォールバック |
|------|------|---------|---------|
| ユーザー層 | 明示的な `/` による意図表明 | 入力欄に直接 `/skill-a /skill-b` と書く | 該当なし |
| Harness 層 | 静的チェック + Reminder の注入 | frontmatter を解析し、競合点を検出し、ターゲットを絞ったプロンプトを生成 | 汎用テンプレートの Reminder へフォールバック |
| モデル層 | 構造化されたワークフローの生成 | SKILL.md を読む → 組み合わせ関係を判定 → コントラクトを定義 → ディスクへ保存 | タスク実行のドリフトはディスク保存で緩和 |

## 3. 注入位置とタイミング

中核的な判断：Reminder はシステムが注入するメッセージとして user メッセージの後に付加する（Anthropic の `long_conversation_reminder` パターンに倣う）。system prompt は書き換えない。

なぜ system prompt を変えず message 層に置くのか

| 観点 | system prompt を変更 | user メッセージの後に付加（採用案） |
|------|-----------------|-------------------------------|
| 指示遵守率 | クエリから遠く、遵守率は低め | クエリに近く、遵守率が明らかに高い |
| Prefix cache のヒット率 | 前置を汚染し、内容が変わるたびにキャッシュが壊れる | 前置は安定を保ち、動的な内容はすべて message 層に降ろす |
| オンデマンド注入 | ターン単位の条件制御が難しい | `/skill` が 2 個以上のターンにのみ現れ、他のターンでは全く意識されない |

条件トリガーのルール

`/skill` が 1 つだけの場合は Reminder を注入しない。

単一 skill のシナリオには編成の問題がなく、無理に計画を立てさせるとレイテンシが増えるだけで、過剰計画（些細なタスクに三段構えの計画を書く）を誘発する。トリガー条件は正確でなければならない：

- `/` の数 == 0 → 注入しない
- `/` の数 == 1 → 注入しない
- `/` の数 ≥ 2 → Reminder を注入する

## 4. Reminder 内容の設計

肝心なのは、計画が構造化され検証可能なものを生み出すこと。「まず A、次に B」といった漠然としたものではだめ。

### Reminder テンプレート

```
<skill_composition_reminder>
The user has explicitly referenced multiple skills: {skill_names}.
Before starting work, complete an orchestration plan:
1. Read the SKILL.md of every referenced skill FIRST, then plan
   (never plan from skill descriptions alone — the full SKILL.md
   may contain constraints that invalidate an imagined workflow)
2. Classify the composition relationship: pipeline (A's output →
   B's input) / parallel (each handles a separate part) /
   constraint overlay (one does the work, the other provides
   rules or standards)
3. If pipeline: define the interface contract for intermediate
   artifacts — format and file path
4. If two skills give instructions on the same dimension (output
   format / style / process), explicitly declare a conflict
   resolution rule: which skill takes precedence on which dimension
5. Output a concise workflow (phase → skill used → artifact),
   then execute according to it
Keep planning proportional to task complexity: for simple
combinations, two or three sentences suffice.
</skill_composition_reminder>
```

## 5. 設計トレードオフのまとめ

| トレードオフ項目 | 選択 | 見送った案とその理由 |
|--------|------|-------------------|
| トリガー方式 | 明示的な `/skill` | 自動的な意味マッチングは見送り — 不安定で過剰トリガーになりやすい |
| Reminder 注入位置 | user メッセージの後 | system prompt の変更は見送り — prefix cache を壊し、遵守率も低い |
| トリガー閾値 | `/skill` が 2 個以上 | 常時注入は見送り — 単一 skill のシナリオではレイテンシが増えるだけで過剰計画を招く |
| Reminder の内容 | 出力構造を制約する | 具体的な手順を教え込むのは見送り — skill の内容は変わるため、ハードコードは保守困難 |
| ワークフローの保存 | ディスク / Task へ保存 | assistant メッセージにのみ残すのは見送り — 長いタスクでは必然的に希釈され失われる |
| Harness の強化 | 静的な事前競合解析 | モデル自身に検知させるのは見送り — 静的チェックのほうが信頼でき、コストもほぼゼロ |
