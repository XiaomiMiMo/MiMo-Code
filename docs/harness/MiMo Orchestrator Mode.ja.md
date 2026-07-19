# MiMo Orchestrator Mode

**一言で**：「調整役（コーディネーター）」のプライマリモード。**単一ウィンドウ・単一セッション・純粋な自然言語**ですべてのタスクを管理する。作業を子セッション（child session）に委譲し、自身は調整・統合・報告を担うことで、複数のウィンドウ／セッションを行き来する必要をなくす（実験的機能、デフォルト無効）。

## 1. 背景と目的

複数の作業を同時に進めようとすると、通常は端末ウィンドウを複数開き、それぞれでコーディングセッションを走らせ、絶えず切り替えることになる——どれが終わったか、どれが承認待ちで止まっているか、どれに次の指示を出すか。本当の負担はマシンの計算力ではなく、**あなたの注意力とエネルギー**だ。コンテキストがウィンドウ間を往復し、人が「多重化」で消耗する。

Orchestrator モードが解決するのはまさにこの問題だ：**ひとつのウィンドウ、ひとつのセッション、純粋な自然言語ですべてのタスクを管理できるようにする**。目標を自然言語で Orchestrator に渡せば、作業を分解し、割り当て、進捗を見張り、判断が必要なときはあなたに戻り、完了したら要約する——あなたは終始同じ会話の中にいて、ウィンドウ間を飛び回らない。

そのために Orchestrator は「**リーダー／マネージャー**」の役割を担う：

- あなたの目標を**成果物単位に分解**（decomposition）し、
- 各単位に**子セッションを割り当て**（child session。自身の mode・model・タスクパネル・メモリで動く）、
- そのうえで**調整・統合（git マージ）・報告**を行う。

通常のコーディングモード（build / plan / compose）は「実行者」：ひとつのディレクトリで自らコードを読み書きしコマンドを走らせる——並行して複数を進めるにはウィンドウを複数開く必要がある。Orchestrator は「管理者」：並行する複数の子セッションはバックグラウンドで走り、あなたが向き合うのは常に**この一つ**の調整セッションだ。

**中核の境界**：Orchestrator は**実質的な作業を自分では行わない**——コードを書かず、具体的な実装計画も、品質レビューもしない。それらはすべて委譲する：計画が要る単位は `plan`（あるいは `compose`。そのワークフローに plan/review フェーズが内蔵されている）へ、コードは `build` へ。「委譲単位への分解」がその仕事であり、「ある単位をどう実装するか」と「結果のレビュー」は委譲する仕事だ。

**デフォルト無効**：機能全体は単一のフラグ `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR` で制御される（§6 参照）。無効時、MiMoCode は従来どおり——Orchestrator モードも、`session` ツールも、承認ルーティングも、ワークスペース切替もない。

## 2. 全体モデル

```
ユーザーの目標
   │  分解（decomposition）
   ▼
Orchestrator セッション（グローバルに一意、§5 参照）
   │  session create ──► child A (build,  dir=repo1, --isolate)  ┐
   │  session create ──► child B (plan,   dir=repo2)             │  バックグラウンドで並行
   │  session create ──► child C (compose,dir=repo1, --isolate)  ┘
   │
   │  子が完了 → actor_notification が inbox に戻る → Orchestrator を起こす
   ▼
調整 / 統合（各 child の mimocode/* ブランチを git merge）/ ユーザーへ報告
```

- 各 child は**独立したセッション**（固有の session id・タスクパネル・メモリを持つ）で、`mode: "peer"` として**バックグラウンド**で動く。
- Orchestrator は割り当て後**即座に戻り**、ポーリングしない。child は完了時に inbox 通知で**能動的に起こす**。
- child は peer であり、セッション内 subagent ではない——`mimo -c <id>` と同様に、任意の child セッションへ**完全に attach** して閲覧／引き継ぎができる。

## 3. `session` ツール（Orchestrator の中核能力）

`session` ツールを見て呼べるのは Orchestrator モードだけ（エージェント名による制御＋フラグ制御）。JSON と shell の両形態で呼べる（具体的な構文はツール説明が示す）。verb は 8 つ：

| verb | 役割 | 主なパラメータ |
|---|---|---|
| `create` | 新しい子セッションをバックグラウンドで割り当てる | `task`（初回タスク、必須）；任意で `mode`（build\|plan\|compose、既定 build）・`model`・`title`・`dir`（child が動くディレクトリ。任意のプロジェクト／パス、既定は Orchestrator 自身のディレクトリ）・`isolate`（`dir` のリポジトリ内の専用 git worktree で走らせ、並行書き込み衝突を避ける） |
| `switch` | フロントのパネルをあるセッションに切り替える | `sessionID`（まず `list` で自然言語を id に解決してから switch） |
| `list` | この Orchestrator の全子セッションを列挙（id / title / mode / status） | — |
| `cancel` | 不要になった子を停止；`--isolate` 済みなら worktree とブランチも削除 | `sessionID` |
| `ask` | あるセッションに**読み取り専用・一回限り**の傍流質問（履歴の凍結スナップショットから回答、実行は中断しない） | `session_id` + `question` |
| `setmode` | 子の**以降のターン**が動く mode を変更（例：plan の子が計画後 build に切り替え、**同じセッション**で実行。新規セッション不要） | `sessionID` + `mode`（build\|plan\|compose） |
| `approve` | 子の**現在保留中**の権限リクエストを承認（§4 参照） | `sessionID` |
| `grant-approval` | 事前承認：以降の権限リクエストを自動承認（毎回聞かない） | `target`（ある child の sessionID、または全子を表す `all`） |

実装：`packages/opencode/src/tool/session.ts`（verb 一覧 `KNOWN_VERBS`）。

### 3.1 ディレクトリと隔離（`--dir` / `--isolate`）

Orchestrator は**汎用**の調整役で、異なるプロジェクトをまたいで作業できる。よって各 child のディレクトリと隔離は**タスクごとに決める**——現在のプロジェクトを前提にしない：

- `dir` —— child が動くディレクトリ。タスクが属するプロジェクト／サブプロジェクト／作業用ディレクトリを指す。省略すれば Orchestrator 自身のディレクトリ。
- `isolate` —— 有効時、child は `dir` のリポジトリ内の**専用 git worktree**（ブランチ `mimocode/<task>`）で走る。これにより複数の child が同じリポジトリを編集しても互いに、また Orchestrator と衝突しない。「ファイルを編集し、並行の可能性がある」場面向け。読み取り専用／単一書き込み、あるいは非 git ディレクトリでは無効に（非 git 時は `dir` で直接走るよう自動フォールバック）。

worktree は `dir` のリポジトリ自身の Instance 上で作成／削除される（プロジェクト横断で正しい）。child worktree は `<data>/worktree/<projID>/<task-slug>` に置かれ、ブランチは `mimocode/<task-slug>`。

### 3.2 統合とクリーンアップ

- isolated child のコミットは自身の `mimocode/<...>` ブランチ上にある。Orchestrator が自ら git で統合する（`bash` を持つ）：`git log <branch>` / `git diff <base>...<branch>` / `git merge-tree` で衝突を予見 → `git merge <branch>`（または cherry-pick）。child のブランチは `git worktree list` / `git branch --list 'mimocode/*'` で探す。
- **作業がマージ済み、またはタスク放棄後にのみ** isolated child を `cancel` する——`cancel` は worktree とブランチを削除するので、**未マージ**の作業に対して行うとその作業を永久に失う。child が「完了した」からといって `cancel` してはいけない（完了はブランチ上のマージ待ちコミットを生む）。

### 3.3 ライフサイクル（no-poll / interrupt / resume）

- **ポーリングしない**：`create` は即座に戻り、child はバックグラウンドで走り、完了時に inbox へのメッセージが Orchestrator を起こす。割り当て後は戻る／ユーザーに答える／ターンを終える——`list`／状態確認をループしてターンを浪費しない。
- **中断**：Orchestrator を中断しても child は**止まらない**——バックグラウンドで走り続け、完了時に通知する。特定の child を止めるには `session cancel <id>`。セッション全体が終了するとすべての child も終了する。
- **全再開**：`session list` で子を列挙し、最後の結果が成功でない（取消／失敗／未報告）か未完了タスクが残る child には、`actor` の send でメッセージを転送して続行させる。専用の resume コマンドはない——list ＋ リレーで駆動する。

## 4. 子セッションの権限承認ルーティング

**問題**：バックグラウンドで動く child にはユーザーに直接向き合う対話パネルがない。既定では、バックグラウンドセッションが「確認（ask）」を要する権限ゲート（ワークスペース外ディレクトリへのアクセス、`.env` の読み取りなど）に当たると**即座に拒否**される（`interactive:false` → `DeniedError`）——ユーザーには見えず、承認もできない。

Orchestrator の child には人へ至る経路がある——その親セッションと TUI を見るユーザーだ。よって **Orchestrator の peer child** では、権限 `ask` は黙殺拒否せず**承認へ転送**される：

- **判定**：`decideAskRouting`（`src/agent/config.ts`）は三分岐する：システムエージェント（checkpoint-writer/dream/distill）→ 従来どおり自動拒否；**Orchestrator peer**（background ＋ `mode:peer` ＋ 親あり）→ 承認へ転送；その他のバックグラウンド（compose の subagent 等）→ 従来どおり自動拒否。
- **誰が承認するか**：転送されたリクエストは (a) **ユーザーが直接**（その child に切り替え、通常のセッション別権限 UI で）、または (b) **Orchestrator が代理で**——一致する委譲権限を持つとき——解決できる。
- **委譲権限**：
  - `session grant-approval <childSessionID>` —— ある child の以降の ask を自動通過に事前承認；
  - `session grant-approval all` —— この Orchestrator の**すべての** child を事前承認；
  - `session approve <childSessionID>` —— その child の現在保留中のリクエストを一回限り承認。
- **重複排除**：各権限リクエストの実体は一つだけ。ユーザー直接（`Permission.reply`）と Orchestrator（`session approve`）はどちらも同じ Deferred に収束し、二回目は冪等な no-op。いずれかが承認すると Orchestrator の転送コピーは破棄される——二重処理も残留リクエストもない。
- **ハングしない**：誰も応答しない転送 ask は `FORWARD_DENY_TIMEOUT_MS`（5 分、`src/permission/index.ts`）後に**自動拒否**され、元の自動拒否の「決してハングしない」保証を保つ。abortSignal はいつでも取り消せる。
- **通知**：転送リクエストの記録時に **Orchestrator を起こし**（child id と承認方法を伴う inbox 通知）、ユーザーには toast を出す。child の**完了**時にもユーザーへ toast（Orchestrator への通知だけでない）。

## 5. グローバルに一意な Orchestrator ワークスペース

Orchestrator モードは**固定のグローバル作業ディレクトリ**（`<data>/orchestrator`、`src/global/index.ts` の `orchestratorDir()`）を使う：

- どのディレクトリから MiMoCode を起動しても、**Orchestrator モードへ切り替える**と TUI の作業ディレクトリがこのグローバルディレクトリに切り替わり、そこにある**唯一の**ルート Orchestrator セッションに着地する（find-or-create）。
- したがって、どこで起動しても常に同じ Orchestrator セッションになる——以前作った child セッションが常に見え、アクセスできる。さもなくば、異なるディレクトリでの起動が異なる Orchestrator セッションになり、以前作った子が見つからなくなる。

切替は worktree ダイアログの手順を再利用する：`instance.dispose → switchDirectory → sync.bootstrap →` ルートセッションを探す／作って遷移。サーバーの cwd 包含チェックは、この app 所有のグローバルディレクトリを許可する（機能が有効なときのみ）。

## 6. フラグ、デフォルト無効

単一フラグが機能全体を制御し、**デフォルト無効**、明示的なオプトイン：

```
MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ORCHESTRATOR")
```

- 既定 **OFF**；`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` で有効化（傘となる `MIMOCODE_EXPERIMENTAL=1` でも同時に有効になる）。
- **二つの要となるゲート**が、無効時に機能を完全に消す：
  1. **エージェント登録**（`src/agent/agent.ts`）—— orchestrator エージェントはフラグ有効時にのみ条件付き展開で登録される（`max` モードのやり方に合わせる）。無効時はエージェント集合に入らず、TUI のモード巡回（Tab）、エージェントダイアログ、`defaultAgent` に現れず、peer も割り当てられない。
  2. **ツール登録**（`src/tool/registry.ts`）—— `session` ツールはフラグ有効時にのみ登録される。無効時はどのエージェントも取得できない。
- **多層防御**（無効時はデッドコードだが明示的に）：TUI の Orchestrator 入場ディレクトリ切替 effect は無効時に早期 return；サーバーミドルウェアのグローバルディレクトリ例外は有効時のみ；`decideAskRouting` は `orchestratorEnabled:false` を受けると peer を自動拒否にフォールバックする。

フラグは import 時に一度だけ評価される（`process.env` を読む）。テストでは `test/preload.ts` で早期に `true` に設定する（Orchestrator のテスト群が機能を行使するため）。

## 7. クイックスタート

1. 機能を有効化：`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true`（または `MIMOCODE_EXPERIMENTAL=1`）。
2. MiMoCode を起動し、**Tab** で **Orchestrator** モードに巡回する——作業ディレクトリは自動でグローバル Orchestrator ワークスペースに切り替わり、唯一の Orchestrator セッションに着地する。
3. 作業を任せる。例：*「build モードの子を作り、repo1 にログインページを追加。dir は /path/to/repo1、isolate を有効に。さらに compose の子を作り repo2 の課金スキーマを設計。」*
4. `/sessions`（または Orchestrator に `session list` させる）で `↳` 付きの子を確認；選べば完全に attach して閲覧／引き継ぎでき、session-parent キーバインドで戻れる。
5. 子の完了は Orchestrator を起こしあなたに toast する；承認が要る操作はあなたに転送される（または `grant-approval` の授権により自動承認）。
6. 満足したら、各 isolated child の `mimocode/*` ブランチを Orchestrator にマージ／統合させる。

## 8. 関連ソース

| 関心事 | 位置 |
|---|---|
| Orchestrator エージェント定義 + フラグゲート | `packages/opencode/src/agent/agent.ts` |
| Orchestrator システムプロンプト（委譲者アイデンティティ） | `packages/opencode/src/session/prompt/orchestrator.txt` |
| `session` ツール（8 verb） | `packages/opencode/src/tool/session.ts` |
| ツール登録 + フラグゲート | `packages/opencode/src/tool/registry.ts` |
| 権限承認ルーティング判定 | `packages/opencode/src/agent/config.ts`（`decideAskRouting`） |
| 転送／授権 ref + 重複排除 | `packages/opencode/src/permission/permission-forward-ref.ts`、`src/permission/index.ts` |
| グローバル Orchestrator ワークスペース | `packages/opencode/src/global/index.ts`（`orchestratorDir`）、`src/cli/cmd/tui/app.tsx` |
| フラグ定義 | `packages/opencode/src/flag/flag.ts`（`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`） |
