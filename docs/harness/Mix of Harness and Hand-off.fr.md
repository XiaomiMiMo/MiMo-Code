# Mécanisme Mix of Harness && Hand-off

**En une phrase** : encapsuler **Codex CLI** et **Claude Code CLI** sous forme d'exécuteurs appelables via des skills, afin que MiMoCode puisse suspendre le turn courant lorsqu'il tombe dans une « boucle à faible rendement » et permettre à l'utilisateur de confier le travail en un clic à un autre harness. Le plan de contrôle reste dans la session MiMoCode, tandis que le plan d'exécution se trouve dans le harness sélectionné — les deux plans sont découplés.

Harness pris en charge : **Codex CLI** && **Claude Code CLI**.

---

## 1. Pourquoi Mix of Harness

Face à une tâche pour laquelle il est intrinsèquement peu adapté, un harness unique ne se rétablit presque jamais seul : Codex est plus optimiste et tend à annoncer la fin trop tôt ; Claude Code explore plus finement, mais peut réécrire en boucle des diff similaires sous des instructions explicites. Le véritable signal d'échec n'est pas qu'« une étape a échoué », mais que **continuer à consommer des tokens ne produit aucun progrès** : le même fichier est modifié à répétition, la même commande bash est réessayée sans changement, ou le rapport exploration/modification ne s'améliore pas.

Mix of Harness (MoH ci-après) résout ce problème en transformant chaque harness en exécuteur que MiMoCode peut lancer via un skill et exécuter comme sous-processus. Un **détecteur Try-Best** surveille la santé du turn courant ; dès qu'il détecte une boucle à faible rendement, il suspend le turn et laisse l'utilisateur choisir un harness plus approprié pour prendre le relais.

**Limite fondamentale** : MoH **ne change pas le provider/model de la session**. Après avoir choisi « confier à Codex CLI » ou « confier à Claude Code CLI », la session reste la session MiMoCode d'origine avec son modèle d'origine. Celui-ci doit simplement charger le skill correspondant et déléguer l'exécution au harness choisi. Le contexte, le panneau des tâches, la mémoire et le routage des approbations n'ont donc pas à être reconstruits.

---

## 2. Conception des SKILL

Codex et Claude Code sont chacun encapsulés dans un **built-in skill**, respectivement sous `<data>/builtin_skills/local/skills/codex/` et `<data>/builtin_skills/local/skills/claude-code/`. Chaque répertoire contient :

```
codex/
  SKILL.md                # Description du déclencheur + règles (headless privilégié, pas d'interaction hors --yolo)
  agents/openai.yaml
  references/
    recipes.md            # Patterns courants de codex exec
    windows.md            # Précautions distinctes pour PowerShell natif / WSL2

claude-code/
  SKILL.md
  references/
    config.md
    flags.md
    interactive-tmux.md
    platforms.md
    print-mode.md
```

SKILL.md est le point d'entrée ; son champ `description` détermine quand le skill router le déclenche. Le principe est de **fournir directement dans le skill des modèles de commandes CLI exécutables**. Par exemple, le skill Codex fournit immédiatement :

```bash
codex exec \
  -C /path/to/repo \
  --sandbox workspace-write \
  --ask-for-approval never \
  "<TASK>"
```

plutôt que de laisser le modèle rechercher lui-même la combinaison de flags. Les différences entre plateformes (macOS/Linux, Windows PowerShell et WSL2) sont couvertes par les documents de `references/`.

> **Pourquoi un skill distinct plutôt qu'un outil intégré ?** Les détails d'utilisation du harness restent dans le skill et sont injectés avec le prompt du modèle ; la couche outil n'expose que la capacité d'exécuter un sous-processus. Les mises à jour du skill, différences de plateforme et changements de flags se traitent en remplaçant le répertoire du skill, sans modifier le code.

---

## 3. Les cinq modes de MoH

Les tâches exigent des structures d'orchestration différentes. MoH prend actuellement en charge les cinq modes suivants. **Fallback est le mode par défaut de MiMoCode** : c'est le chemin qui active automatiquement la détection Try-Best et le Hand-off.

### 3.1 Single

```
Task → Codex → Validator
```

Un seul harness s'exécute directement, suivi d'un validator. Adapté lorsque le harness est entièrement fiable et que le périmètre est clair.

### 3.2 Fallback (par défaut)

```
Task → MiMoCode
          │ échec/blocage
          ▼
        Codex / Claude Code
```

MiMoCode essaie d'abord d'effectuer le travail lui-même. Après un signal d'échec/blocage, l'utilisateur choisit un autre harness. Règles courantes :

- N échecs consécutifs d'outils de même type
- Aucune modification de fichier pendant plus de X minutes
- Trop de compressions du contexte
- Aucune amélioration des résultats de tests successifs
- Coût supérieur à 80 % du budget
- Artifact requis absent de la sortie finale

Le détecteur Try-Best (voir §4) implémente les règles qui peuvent être évaluées en temps réel au sein d'un turn.

### 3.3 Pipeline

```
Recherche par Claude Code
       ↓ HandoffPacket
Implémentation par Codex
       ↓ Patch
Revue par MiMoCode
       ↓ Findings
Correction par Codex
```

Les étapes sont enchaînées, chacune utilisant le harness le plus adapté, avec des packets structurés pour transmettre le contexte. Ce mode convient aux tâches dont les étapes sont clairement séparées (comprendre avant de modifier, puis relire après l'implémentation).

### 3.4 Parallel Competition

```
               ┌→ Claude Code → Patch A ┐
Task → Fork ───┤                        ├→ Evaluator
               └→ Codex        → Patch B ┘
```

Plusieurs harness effectuent séparément la même tâche, puis un evaluator choisit le résultat. Adapté lorsque les limites sont floues, que plusieurs approches sont possibles et qu'un pari probabiliste est utile. **Son coût est plus élevé**, il n'est donc pas utilisé par défaut.

### 3.5 Debate / Review

```
Codex Implementer → Claude Reviewer → Codex Repairer
```

Un harness propose une solution, un autre la critique, puis le premier la corrige. Adapté aux changements sensibles à la sécurité ou à l'exactitude qui nécessitent une vérification croisée.

---

## 4. Mécanisme Hand-off (Try-Best HandOff)

Try-Best HandOff automatise le mode Fallback : il **surveille en temps réel dans le turn** les boucles à faible rendement et, dès qu'une règle est satisfaite, suspend le turn, enregistre les preuves et rend le choix à l'utilisateur.

### 4.1 Qu'est-ce qu'une « boucle à faible rendement » ?

Les modes d'échec d'un agent de codage ont des formes observables dans sa trajectoire. Try-Best retient les signaux les plus forts :

- **Boucles et répétitions**. Même fichier modifié à répétition, diff sémantiquement proches qui se succèdent, même commande bash réessayée à l'identique après plusieurs échecs. C'est le précurseur d'échec le plus fort : une fois dans une boucle, l'agent n'en sort presque jamais seul et continuer à brûler des tokens est inutile. Une **déduplication par fenêtre glissante** des N derniers tool calls suffit, sans embedding.
- **Découplage entre progrès et consommation**. Un signal de progress grossier (évolution du nombre de tests réussis, proportion des fichiers cités dans l'issue couverts par le diff) est comparé au token burn rate. Si 40 % du budget sont consommés sans progrès, le harness est probablement inadapté ; changer coûte bien moins cher que d'attendre.
- **Mode d'égarement**. Lire des fichiers durant l'exploration est normal, mais poursuivre de larges grep tardivement, relire les mêmes gros fichiers ou ouvrir des répertoires sans rapport avec l'issue montre que l'agent n'a pas construit de modèle de travail du repo. On le quantifie par le rapport opérations apportant de nouvelles informations / opérations de modification sur les K dernières étapes ; dans une trajectoire saine, ce rapport doit décroître avec le temps.
- **Déclaration de fin prématurée**. Le harness se dit done sans avoir exécuté les tests, ou sans avoir examiné leurs résultats. **Ne faites pas confiance à une fin autodéclarée** ; Codex est plus optimiste que Claude Code sur ce point.

### 4.2 Détection (trois motifs de déclenchement)

L'implémentation actuelle dans `packages/opencode/src/session/try-best-detector.ts` détecte les deux premières catégories au moyen de trois règles :

| Reason | Description | Seuil par défaut |
|---|---|---|
| `edit_repeat` | Modifications proches du **même fichier** : transformer le diff en ensemble de 3-shingles et comparer les 12 derniers événements edit avec la **similarité de Jaccard** ; une similarité > 0,8 compte comme une correspondance | Déclenchement après ≥ 2 correspondances cumulées (« troisième modification proche ») |
| `bash_retry` | Une commande bash normalisée **échoue consécutivement** sans changement de la sortie d'échec | 3 fois de suite |
| `action_streak` | Des actions consécutives du même type (`edit` ou `verify`) n'apportent aucune amélioration observable | 4 fois de suite |

Les commandes et résultats sont normalisés afin d'éviter les faux positifs dus aux horodatages, chemins temporaires ou seeds aléatoires :

- Commande : `/tmp/...` → `<TMP>`, nombres purs d'au moins 6 chiffres → `<NUM>`, `--seed=xxx` → `<SEED>`
- Résultat : suppression supplémentaire des durées `Ns / Nms / N seconds` ; au-delà de 2 000 caractères, conservation de la moitié au début et à la fin, avec `<TRUNCATED>` au milieu

Les commandes `verify` (bun/npm/pnpm/yarn test/typecheck/lint/build, pytest, cargo test, go test, make test, tsc, etc.) participent à `bash_retry` et sont aussi comptées dans `action_streak`.

### 4.3 Suspension et persistance

Lorsqu'un reason est déclenché, `SessionProcessor.detectTryBest` :

1. **reset le monitor** pour éviter plusieurs déclenchements dans le même turn ;
2. **définit `ctx.blocked = true`** afin que le processor return `stop` pour les sorties suivantes et que la prompt loop quitte immédiatement le turn ;
3. **écrit un `TextPart` synthetic** : `text` contient une explication lisible (« Try-best loop detected; this turn was paused. … ») et `metadata.origin` contient `kind: "try_best"`, les `providerID / modelID` courants et l'`incident` complet (reason + evidence). **Le part est la source de vérité** : même si un abonné aux événements se déconnecte, la session peut être restaurée en parcourant les parts ;
4. **publie l'événement `session.try_best.detected`** : la TUI s'y abonne et ouvre immédiatement un dialog. L'événement fournit la faible latence, le part sert de repli ;
5. **publie l'événement metrics** `Metrics.TryBestDetected` pour mesurer la fréquence par modèle/reason.

### 4.4 Choix utilisateur (trois options dans le dialog TUI)

Après la suspension, la TUI ouvre le dialog « Try-best loop detected — turn paused », dont la description contient les preuves (par exemple « Near-identical edits repeated 3 times in packages/opencode/src/foo.ts »). Trois options sont proposées :

1. **Continuer avec Codex CLI** (`Hand off to Codex CLI`)
2. **Continuer avec Claude Code CLI** (`Hand off to Claude Code CLI`)
3. **Conserver le modèle actuel mais changer de stratégie** (`Continue with <model>`) — lui faire abandonner son approach et replanifier

Les cibles candidates **excluent la famille du modèle courant** (`handoffTargets` dans `packages/opencode/src/cli/cmd/tui/util/handoff.ts`) :

- provider courant `openai` ou nom du modèle contenant `gpt / codex` → seulement « Claude Code CLI »
- nom contenant `anthropic / claude` → seulement « Codex CLI »
- autres → les deux

La TUI vérifie également que le skill correspondant (`codex` / `claude-code`) est enregistré dans `sync.data.command` ; une option non enregistrée est désactivée.

### 4.5 Protocole d'exécution (handoff orchestré)

Après sélection du harness, la TUI **ne change ni de session ni de modèle**. Elle appelle `promptAsync` sur le sessionID d'origine et transmet un `<system-reminder>` comme entrée du turn suivant (modèle dans `formatHarnessReminder`) :

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

Points essentiels :

- **Plan de contrôle = session d'origine** : panneau des tâches, routage des approbations, contexte et mémoire restent dans MiMoCode ; le harness n'est qu'un sous-processus lancé.
- **Plan d'exécution = harness sélectionné** : recherche, implémentation, correction et validation doivent avoir lieu dans ce sous-processus. Le system-reminder interdit explicitement de n'utiliser le harness « que comme référence » ou de return juste après son launch.
- **Le modèle d'origine reste présent** : il charge le skill, prépare le travail pour le harness, le supervise jusqu'à la fin et rapporte le résultat. Il ne cède pas le contrôle, mais devient le superviseur d'exécution du harness.

Choisir « conserver le modèle actuel mais changer de stratégie » n'envoie aucun reminder ; seul `ctx.blocked` est levé pour que le modèle replanifie au turn suivant.

---

## 5. Configuration

### 5.1 Interrupteur principal

- **Variable d'environnement `MIMOCODE_ENABLE_TRY_BEST_HANDOFF`** (`true` par défaut)
  - `false` ou `0` → désactive la détection de boucle, la suspension du turn et le dialog de handoff.
  - Définie dans `packages/opencode/src/flag/flag.ts`.

### 5.2 Seuils (`experimental.try_best`)

Chaque seuil peut être remplacé dans `mimocode.json` / config :

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

Signification :

| Key | Défaut | Description |
|---|---|---|
| `edit_window` | 12 | Nombre d'événements edit récents comparés |
| `edit_similarity` | 0.8 | Seuil de similarité de Jaccard (0–1) ; le dépasser compte comme une correspondance |
| `edit_matches` | 2 | Nombre cumulé de correspondances requis (déclenchement à la modification N+1) |
| `action_streak` | 4 | Nombre consécutif de `edit`/`verify` sans progrès |

Le nombre d'échecs consécutifs de `bash_retry` est actuellement fixé à 3 (`TRY_BEST_BASH_RETRIES`), sans option de config.

### 5.3 État d'enregistrement des skills

Les deux options de harness du dialog Hand-off exigent que les skills `codex` et `claude-code` soient enregistrés dans `sync.data.command`. Une option non enregistrée est masquée afin d'éviter de sélectionner un harness impossible à lancer.
