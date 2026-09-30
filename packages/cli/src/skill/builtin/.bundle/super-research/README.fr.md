# super-research

[English](README.en.md) · [中文](README.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md)

**Skill de recherche autonome** pour Claude Code / Claude.ai. Laissez un agent tourner un moment (quelques minutes à toute une nuit) et récupérez des **preuves comparables, honnêtes et auditables** — pas une réponse boîte-noire ponctuelle.

Inspiré de l'[autoresearch](https://github.com/karpathy/autoresearch) de Karpathy. Cette skill généralise sa méthodologie à six modes de recherche.

---

## Qu'est-ce que c'est

Une discipline de travail conçue pour que « si vous laissez l'agent tourner toute la nuit, vous puissiez faire confiance au résultat le lendemain matin ». La valeur n'est pas la procédure spécifique — c'est **la même discipline dans chaque mode** :

1. **Contrat avant action** — écrire le but, la sortie principale, la condition d'arrêt ; confirmer une fois. Ensuite, plus de questions.
2. **Baseline d'abord** — chaque mode a « la réponse sans aucun de mon travail » (code non modifié / trois premiers résultats de recherche / jeu de données brut). L'enregistrer d'abord, sinon « meilleur » et « significatif » ne veulent rien dire.
3. **Chaque étape dans un journal machine-lisible, échecs compris** — TSV (pas CSV ; les descriptions contiennent des virgules). Écarter silencieusement les tentatives ratées est le moyen le plus rapide de se tromper soi-même.
4. **Pas de check-ins en cours de boucle** — après le contrat, l'agent ne s'arrête pas pour demander « je continue ? ». L'humain peut être en train de dormir.
5. **Pas de triche** — ne pas éditer le code d'évaluation, ne pas retirer une source qui gêne, pas de p-hacking, pas de cherry-picking.

---

## Six modes

La skill choisit un mode à partir de la formulation de l'utilisateur. Vous pouvez aussi en spécifier un explicitement.

| Mode | Quand l'utiliser | Déclencheurs | Détails |
| --- | --- | --- | --- |
| **Experiment loop** | Améliorer un système vers un objectif chiffré | "optimize", "tune", "hill-climb", « expériences pendant la nuit » | `references/experiment-loop.md` |
| **Topic survey / 主题调研** | Collecter + synthétiser des sources externes sur une question | "survey", "revue de littérature", « état de l'art de X » | `references/topic-survey.md` |
| **Quantitative analysis / 量化分析** | Répondre à une question quantifiable depuis un dataset | "analyser ce dataset", « X prédit-il Y » | `references/quant-analysis.md` |
| **Benchmark comparison / 对比评测** | Choisir parmi N candidats | "comparer X vs Y", « quelle bibliothèque choisir » | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因排查** | Diagnostiquer une régression / un test flaky / une perte de perf | « pourquoi X est cassé », « déboguer la régression » | `references/root-cause.md` |
| **Ablation study / 消融实验** | Attribuer la contribution des composants d'un système | "ablate", « quelles parties de X comptent » | `references/ablation-study.md` |

**Modes voisins — comment les distinguer** (la skill choisit, mais vous pouvez orienter) :

- **Experiment loop vs Benchmark** — experiment améliore *un seul* système ; benchmark choisit parmi *plusieurs*. « Choisir entre » → benchmark ; « faire bouger cette métrique » → experiment.
- **Experiment loop vs Ablation** — les deux modifient et remesurent. Experiment garde les améliorations ; ablation garde *chaque* résultat et ne s'arrête jamais en avance — le but est la compréhension, pas l'optimisation.
- **Root-cause vs Experiment loop** — root-cause enquête sur une baseline *cassée* ; experiment grimpe depuis une baseline *qui fonctionne*. Le schéma de journal et la règle d'arrêt diffèrent.

---

## Comment l'utiliser

### Phrase de déclenchement

La skill se charge automatiquement sur les tournures correspondantes. Ou spécifiez explicitement :

```
Utilise le mode <mode> de super-research. Tourne toute la nuit. Sortie dans <dir>/.
```

### Flux typique

```
Vous   : Compare lib_a, lib_b, lib_c pour le nettoyage de texte. Benchmark
         comparison, sans tuning par candidat. Chacun des 5 cas au moins deux fois.
Claude : [déclenche skill → lit SKILL.md + references/benchmark-comparison.md]
         [rédige le contrat : candidats, matrice, métriques, budget d'équité, dir]
         [demande une confirmation — votre dernière occasion de parler]
Vous   : Confirmé
Claude : [boucle autonome — smoke-test du harness → exécute la matrice → chaque
          cellule dans matrix.tsv → agrège → drop-one-case → report.md]
         [rapport final : vainqueur / classement / stabilité / notes d'intégration / logs]
```

Le point clé : **après le contrat, Claude ne pose plus de questions**. Il peut tourner des dizaines de minutes à plusieurs heures. Vous pouvez vous absenter.

### Livrables par mode

| Mode | Répertoire | Journal clé | Livrable |
| --- | --- | --- | --- |
| Experiment loop | `research/<tag>/` (branche git) | `results.tsv` | Meilleur commit + rapport |
| Topic survey | `survey/<tag>/` | `sources.tsv` + `claims.tsv` | Synthèse `report.md` citée |
| Quant analysis | `analysis/<tag>/` | `analysis_log.tsv` | `scripts/` + `report.md` + `figures/` |
| Benchmark | `benchmark/<tag>/` | `matrix.tsv` | Classement + recommandation `report.md` |
| Root-cause | `investigation/<tag>/` | `hypotheses.tsv` + `baseline.md` | Cause racine + preuve du renversement bidirectionnel |
| Ablation | `ablation/<tag>/` | `ablation.tsv` | Classification des composants + rapport |

Les journaux sont en **TSV** (séparés par tabulation) avec en-tête. Les répertoires sont créés dans le répertoire courant ; `<tag>` prend par défaut la date du jour (ex. `jul7`).

### Forme du rapport final

Chaque mode se termine par un markdown compact (≤ 1 page) :

- **Contract** — ce que vous vouliez faire
- **Baseline vs final** — chiffres de départ vs d'arrivée
- **What worked** — 3 à 5 items avec preuve
- **What didn't** — impasses, crashes, contradictions. **C'est ici que se trouve le plus de signal.**
- **Open questions / next steps**
- **Where to look** — journaux, branche, artefacts

L'objectif : **permettre à un humain de vérifier le travail en 5 minutes et savoir où regarder ensuite**. Pas de storytelling.

---

## Structure des répertoires

```
super-research/
├── SKILL.md                     # frontmatter (déclenchement) + discipline partagée + tableau des modes
├── references/                  # un fichier par mode, chargé uniquement quand ce mode est choisi
│   ├── experiment-loop.md
│   ├── topic-survey.md
│   ├── quant-analysis.md
│   ├── benchmark-comparison.md
│   ├── root-cause.md
│   └── ablation-study.md
└── evals/                       # pour tester la skill elle-même
    ├── evals.json               # 8 cas de test avec assertions
    ├── toy_repo/                # fixture experiment-loop (script d'entraînement synthétique)
    ├── toy_dataset/             # fixture quant-analysis (données Simpson's paradox)
    ├── toy_bench/               # fixture benchmark (3 cleaners × 5 cas)
    ├── toy_regression/          # fixture root-cause (dépôt à 5 commits bisectable)
    └── toy_pipeline/            # fixture ablation (5 composants activables)
```

---

## Progressive disclosure (le design)

- **SKILL.md est toujours en contexte** — mais seulement la discipline partagée + le tableau des modes. Moins de 100 lignes.
- **`references/<mode>.md` est chargé à la demande** — une fois le mode choisi, seul ce fichier est lu.
- **evals/ n'entre jamais en contexte** — utilisé uniquement quand le harness d'évaluation de skill-creator tourne.

Donc quand la skill se déclenche, Claude ne lit que quelques centaines de lignes supplémentaires — pas le règlement complet des six modes.

---

## Tester / itérer la skill elle-même

`evals/evals.json` contient 8 cas couvrant les six modes plus deux tests de discipline (`handles-crash-gracefully`, `ambiguous-goal-must-clarify`). Chaque cas contient :

- `prompt` — l'instruction donnée à l'agent
- `files` — fixtures à placer dans le répertoire de travail
- `expectations` — assertions vérifiables par programme

Voie recommandée : utiliser la skill `skill-creator`. Elle lance deux subagents par cas (avec / sans skill), collecte les artefacts, exécute les assertions, produit un `benchmark.json` et une visionneuse HTML.

Toutes les fixtures sont autonomes et rapides (`toy_repo/run.py` utilise `time.sleep(0.5)` ; `toy_regression/setup.sh` sème un dépôt frais à chaque appel ; `toy_pipeline/pipeline.py` est purement synthétique).

---

## Quand **ne pas** l'utiliser

- Tâches ponctuelles qui se terminent en quelques minutes — une conversation normale suffit.
- Objectifs qui ne se laissent pas ramener à un seul nombre ou une seule question répondable — réfléchissez d'abord.
- Chaque étape a besoin d'un feu vert humain — c'est du pair programming, pas de la recherche autonome.

La valeur est **volume × discipline** : dix expériences bon marché exécutées au même standard battent une affirmation ingénieuse non testée. Sans expériences bon marché *et* un standard comparable, la discipline tourne à vide.
