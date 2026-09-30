# super-research

[English](README.en.md) · [中文](README.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md)

Claude Code / Claude.ai 向けの **自律研究 skill**。エージェントをしばらく（数分〜一晩）走らせて、ワンショットのブラックボックス回答ではなく、**比較可能・誠実・監査可能なエビデンス**を持ち帰らせる。

Karpathy の [autoresearch](https://github.com/karpathy/autoresearch) の方法論に着想を得ており、それを 6 つの研究モードに一般化したもの。

---

## これは何か

「エージェントを一晩走らせても、翌朝その成果を信じられる」ようにするための作業規律。価値は具体的な手順ではなく、**どのモードでも同じ規律**にある：

1. **着手前にコントラクトを立てる** — 目標・主要な成果物・停止条件を書き出し、一度確認する。以後は質問しない。
2. **まずベースライン** — どのモードでも「自分が何もしなかった場合の答え」（未編集のコード / 最初の 3 件の検索結果 / 変換前の生データ）が存在する。先に記録する。さもなければ「良くなった」や「有意」に意味がない。
3. **全ステップを機械可読なログに残す。失敗も含めて** — TSV（説明文にカンマが混ざるので CSV は避ける）。失敗を黙って捨てるのが、自分と相手を欺く最短ルート。
4. **ループ途中で伺いを立てない** — コントラクト確認後、エージェントは「続けていい？」と止まらない。人は寝ているかもしれない。
5. **ズルはしない** — eval コードを編集しない、都合の悪いソースを外さない、p-hack しない、都合のいい部分集合をつまみ食いしない。

---

## 6 つのモード

Skill はユーザーの言い回しからモードを選ぶ。明示指定も可能。

| モード | 使うタイミング | トリガー語 | 詳細 |
| --- | --- | --- | --- |
| **Experiment loop** | 1 つのシステムを数値目標に向けて改善 | "optimize"、"tune"、"hill-climb"、「一晩実験」 | `references/experiment-loop.md` |
| **Topic survey / 主題調査** | 問いに対して外部ソースを収集・統合 | "survey"、"literature review"、「調研 X」、"state of the art" | `references/topic-survey.md` |
| **Quantitative analysis / 定量分析** | データセットから定量的な問いに答える | "analyze this dataset"、「X は Y を予測するか」 | `references/quant-analysis.md` |
| **Benchmark comparison / 対比評価** | N 個の候補から 1 つ選ぶ | "compare X vs Y"、「どのライブラリを選ぶか」 | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因調査** | 回帰・フレーク・性能劣化の原因究明 | "why is X broken"、「デグレの原因」 | `references/root-cause.md` |
| **Ablation study / アブレーション実験** | システム各コンポーネントの寄与を帰属 | "ablate"、「X のどの部分が効いているか」 | `references/ablation-study.md` |

**近接モードの見分け方**（skill は自動で選ぶが、明示的に誘導もできる）：

- **Experiment loop vs Benchmark** — experiment は *1 つの* システムを改善、benchmark は *複数の* 候補から選ぶ。「選ぶ」なら benchmark、「この指標を押し下げる」なら experiment。
- **Experiment loop vs Ablation** — どちらも編集して再計測する。experiment は改善を保持するが、ablation は *全ての* 結果を保持し、大きな効果が見つかっても早期停止しない — 目的は最適化ではなく理解。
- **Root-cause vs Experiment loop** — root-cause は *壊れた* ベースラインを調査、experiment は *動いている* ベースラインから登る。ログのスキーマと停止規則が異なる。

---

## 使い方

### トリガー

該当するフレーズで skill が自動的に呼び出される。明示指定も可：

```
super-research の <mode> モードで。一晩走らせて、成果物は <dir>/ に。
```

### 典型的な流れ

```
あなた : lib_a, lib_b, lib_c でテキストクリーニングの対比評価をしてほしい。
        候補をチューニングしないで、5 つのケース各 2 回以上。
Claude : [skill 発火 → SKILL.md + references/benchmark-comparison.md を読み込む]
         [コントラクト起草：候補・マトリクス・指標・公平予算・作業ディレクトリ]
         [一度だけ確認を求める — 最後に発言できるチャンス]
あなた : 確認
Claude : [自律ループ — ハーネスの smoke test → マトリクス実行 → 各セルを
          matrix.tsv に追記 → 集計 → drop-one-case 安定性検査 → report.md]
         [最終レポート：勝者 / ランキング / 安定性 / 統合上の注意 / ログの場所]
```

要点：**コントラクト確認後、Claude はもう質問しない**。数十分から数時間走ることもある。離席して構わない。

### モードごとの成果物

| モード | 作業ディレクトリ | 主要ログ | 成果物 |
| --- | --- | --- | --- |
| Experiment loop | `research/<tag>/`（git ブランチ） | `results.tsv` | 最良コミット + レポート |
| Topic survey | `survey/<tag>/` | `sources.tsv` + `claims.tsv` | 引用付きサーベイ `report.md` |
| Quant analysis | `analysis/<tag>/` | `analysis_log.tsv` | `scripts/` + `report.md` + `figures/` |
| Benchmark | `benchmark/<tag>/` | `matrix.tsv` | ランキング + 推奨 `report.md` |
| Root-cause | `investigation/<tag>/` | `hypotheses.tsv` + `baseline.md` | 根本原因 + 双方向反転による証明 |
| Ablation | `ablation/<tag>/` | `ablation.tsv` | コンポーネント分類 + レポート |

ログはすべて **TSV**（タブ区切り）、ヘッダー付き。ディレクトリはカレントディレクトリ配下に作られ、`<tag>` は日付（例：`jul7`）がデフォルト。

### 最終レポートの構造

全モード共通で 1 ページ以内のコンパクトな markdown：

- **Contract** — 何をやると決めたか
- **Baseline vs final** — 開始時と終了時の数値
- **What worked** — 根拠付きで 3〜5 項目
- **What didn't** — 行き止まり・クラッシュ・矛盾。**これが最も情報量の多い部分**
- **Open questions / next steps**
- **Where to look** — ログ・ブランチ・成果物のパス

主眼は：**人間が 5 分で作業を検証し、次にどこを見るか分かる**こと。ストーリーテリングではない。

---

## ディレクトリ構成

```
super-research/
├── SKILL.md                     # frontmatter（トリガー）+ 共通規律 + モード選択表
├── references/                  # モード毎に 1 ファイル、モード確定後に読み込まれる
│   ├── experiment-loop.md
│   ├── topic-survey.md
│   ├── quant-analysis.md
│   ├── benchmark-comparison.md
│   ├── root-cause.md
│   └── ablation-study.md
└── evals/                       # skill 自体をテストするための資材
    ├── evals.json               # 8 テストケース + アサーション
    ├── toy_repo/                # experiment-loop 用（合成トレーニングスクリプト）
    ├── toy_dataset/             # quant-analysis 用（Simpson's paradox データ）
    ├── toy_bench/               # benchmark 用（3 cleaner × 5 case）
    ├── toy_regression/          # root-cause 用（bisect 可能な 5 コミットのリポジトリ）
    └── toy_pipeline/            # ablation 用（5 個の ON/OFF 可能なコンポーネント）
```

---

## Progressive disclosure（設計）

- **SKILL.md は常時コンテキスト内** — 共通規律 + モード選択表のみ。100 行未満。
- **`references/<mode>.md` は必要時のみ読み込み** — モード確定後、その 1 ファイルだけが読まれる。
- **evals/ はコンテキストに入らない** — skill-creator の評価ハーネスから使うのみ。

したがって skill 発火時、Claude が追加で読むのは数百行程度で、6 モード分のルールセット全てを読み込むわけではない。

---

## Skill 自体のテストと反復

`evals/evals.json` に 6 モードを網羅する 8 ケース + 2 つの規律テスト（`handles-crash-gracefully`、`ambiguous-goal-must-clarify`）が入っている。各ケースには：

- `prompt` — エージェントへの指示
- `files` — 作業ディレクトリに配置する fixture
- `expectations` — プログラム的に検証可能なアサーション

推奨経路：`skill-creator` skill を使う。ケースごとに 2 つの subagent（skill あり／なし）を起動し、成果物を収集、アサーションを実行、`benchmark.json` と HTML ビューアを生成する。

fixture は全て自己完結で高速（`toy_repo/run.py` は `time.sleep(0.5)` でトレーニングを模擬、`toy_regression/setup.sh` は呼ばれるたびに新しい repo を生成、`toy_pipeline/pipeline.py` は純粋な合成スコアリング）。

---

## 使**わない**方がよい場面

- 数分で終わる一回限りのタスク — 通常の会話で済ませる。
- 単一の数値や単一の答えに落とし込めないゴール — 先に整理する。
- 各ステップに人間の承認が必要 — それはペアプログラミングであって自律研究ではない。

Skill の価値は **量 × 規律**：同じ基準で走らせた安価な実験 10 本の方が、賢いが未検証の主張 1 つより勝る。安価な実験と比較可能な基準の両方が無ければ、規律は空回りする。
