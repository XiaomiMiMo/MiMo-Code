# MiMo Orchestrator Mode

**En une phrase** : un mode principal « coordinateur » — gérez toutes vos tâches depuis **une seule fenêtre, une seule session, en langage naturel pur** : il délègue le travail à des sessions enfants (child sessions) et se charge de la coordination, de l'intégration et du compte rendu, pour que vous n'ayez jamais à basculer entre plusieurs fenêtres/sessions (fonctionnalité expérimentale, désactivée par défaut).

## 1. Contexte et objectifs

Quand vous faites avancer plusieurs travaux à la fois, l'approche habituelle est d'ouvrir plusieurs fenêtres de terminal, d'y lancer une session de codage chacune, puis de basculer sans cesse entre elles : surveiller laquelle a fini, laquelle est bloquée en attente d'approbation, laquelle attend la prochaine instruction. La vraie charge n'est pas la puissance de calcul — c'est **votre attention et votre énergie** : le contexte fait des allers-retours entre les fenêtres et vous vous épuisez à vous « multiplexer ».

C'est exactement ce que résout le mode Orchestrator : **vous permettre de gérer toutes vos tâches depuis une fenêtre, une session, en langage naturel pur**. Vous confiez l'objectif à l'Orchestrator en langage naturel, et il découpe le travail, le distribue, surveille l'avancement, revient vers vous quand une décision est nécessaire, et résume une fois terminé — vous restez dans la même conversation tout du long, sans sauter d'une fenêtre à l'autre.

Pour cela, l'Orchestrator joue un rôle de « **leader / manager** » :

- il **décompose** votre objectif en unités de travail livrables (decomposition),
- **distribue une session enfant** pour chaque unité (tournant dans son propre mode, modèle, panneau de tâches et mémoire),
- puis **coordonne, intègre (git merge) et rend compte**.

Les modes de codage normaux (build / plan / compose) sont des « exécutants » : une session dans un répertoire, lisant/écrivant du code et lançant des commandes elle-même — pour avancer plusieurs choses en parallèle, il faudrait ouvrir plusieurs fenêtres. L'Orchestrator est le « manager » : les sessions enfants parallèles tournent en arrière-plan tandis que vous faites toujours face à **cette seule** session de coordination.

**Frontière fondamentale** : l'Orchestrator ne fait **aucun travail substantiel lui-même** — pas d'écriture de code, pas de planification d'implémentation concrète, pas de revue de qualité. Tout cela est délégué : une unité nécessitant de la planification va à `plan` (ou `compose`, dont le flux intègre des phases plan/review) ; le code va à `build`. « Décomposer en unités à distribuer » est son travail ; « comment une unité donnée est implémentée » et « la revue du résultat » sont des travaux qu'il délègue.

**Désactivé par défaut** : toute la capacité est protégée par un unique drapeau `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR` (voir §6). Désactivé, MiMoCode se comporte comme avant — pas de mode Orchestrator, pas d'outil `session`, pas de routage d'approbation, pas de changement d'espace de travail.

## 2. Modèle global

```
objectif utilisateur
   │  décomposition
   ▼
session Orchestrator (globalement unique, voir §5)
   │  session create ──► child A (build,  dir=repo1, --isolate)  ┐
   │  session create ──► child B (plan,   dir=repo2)             │  parallèle, en arrière-plan
   │  session create ──► child C (compose,dir=repo1, --isolate)  ┘
   │
   │  l'enfant finit → actor_notification revient à l'inbox → réveille l'Orchestrator
   ▼
coordonner / intégrer (git merge la branche mimocode/* de chaque enfant) / rendre compte
```

- Chaque enfant est une **session indépendante** (son propre session id, panneau de tâches, mémoire), tournant en **arrière-plan** avec `mode: "peer"`.
- L'Orchestrator **revient immédiatement** après la distribution et ne fait pas de polling ; un enfant le **réveille activement** via une notification d'inbox à sa fin.
- Un enfant est un peer, pas un subagent intra-session — vous pouvez vous **attacher entièrement** à n'importe quelle session enfant pour la consulter/reprendre, comme `mimo -c <id>`.

## 3. L'outil `session` (la capacité centrale de l'Orchestrator)

Seul le mode Orchestrator peut voir et appeler l'outil `session` (protégé par nom d'agent + par le drapeau). Il offre les formes d'appel JSON et shell (la syntaxe exacte est donnée par la description de l'outil). Huit verbes au total :

| verbe | rôle | paramètres clés |
|---|---|---|
| `create` | distribuer une nouvelle session enfant en arrière-plan | `task` (tâche du premier tour, requis) ; optionnel `mode` (build\|plan\|compose, défaut build), `model`, `title`, `dir` (répertoire où tourne l'enfant — tout projet/chemin, défaut : celui de l'Orchestrator), `isolate` (tourner dans un git worktree dédié de `dir` pour éviter les conflits d'écriture concurrents) |
| `switch` | déplacer le panneau frontal vers une session | `sessionID` (résoudre d'abord le langage naturel en id via `list`, puis switch) |
| `list` | lister les sessions enfants de cet Orchestrator (id / title / mode / status) | — |
| `cancel` | arrêter un enfant devenu inutile ; s'il était `--isolate`, supprimer aussi son worktree et sa branche | `sessionID` |
| `ask` | poser à une session une question latérale **en lecture seule, ponctuelle** (répondue depuis un instantané figé de son historique, sans interrompre son exécution) | `session_id` + `question` |
| `setmode` | changer le mode sous lequel un enfant tourne pour ses **tours suivants** (ex. un enfant plan, une fois la planification finie, passe à build pour exécuter dans la **même session**, sans nouvelle session) | `sessionID` + `mode` (build\|plan\|compose) |
| `approve` | approuver la requête de permission **actuellement en attente** d'un enfant (voir §4) | `sessionID` |
| `grant-approval` | pré-autoriser : approuver automatiquement les futures requêtes de permission (sans demander à chaque fois) | `target` (le sessionID d'un enfant, ou `all` pour tous les enfants) |

Implémentation : `packages/opencode/src/tool/session.ts` (liste des verbes `KNOWN_VERBS`).

### 3.1 Répertoire et isolation (`--dir` / `--isolate`)

L'Orchestrator est un coordinateur **généraliste** pouvant travailler à travers différents projets ; le répertoire et l'isolation de chaque enfant sont donc **décidés par tâche**, sans présumer du projet courant :

- `dir` — le répertoire où tourne l'enfant. Pointez-le vers le projet/sous-projet/répertoire de travail auquel appartient la tâche ; omettez-le pour utiliser celui de l'Orchestrator.
- `isolate` — activé, l'enfant tourne dans **son propre git worktree** du dépôt de `dir` (branche `mimocode/<tâche>`), afin que plusieurs enfants éditant le même dépôt n'entrent pas en collision entre eux ni avec l'Orchestrator. À utiliser pour « va éditer des fichiers, possiblement en concurrence » ; laissez désactivé pour le lecture seule/écrivain unique, ou un `dir` non-git (qui bascule alors sur une exécution directe dans `dir`).

Le worktree est créé/supprimé dans l'Instance du dépôt de `dir` (correct entre projets) ; un worktree enfant se trouve à `<data>/worktree/<projID>/<task-slug>`, sur la branche `mimocode/<task-slug>`.

### 3.2 Intégration et nettoyage

- Les commits d'un enfant isolé vivent sur sa propre branche `mimocode/<...>`. L'Orchestrator les intègre lui-même avec git (il a `bash`) : `git log <branch>` / `git diff <base>...<branch>` / `git merge-tree` pour prévisualiser les conflits → `git merge <branch>` (ou cherry-pick). Trouvez la branche d'un enfant via `git worktree list` / `git branch --list 'mimocode/*'`.
- **Ne `cancel` un enfant isolé qu'une fois son travail fusionné, ou la tâche abandonnée** — `cancel` supprime le worktree et la branche, donc le faire sur du travail **non fusionné** perd ce travail définitivement. Ne `cancel` pas un enfant simplement parce qu'il a « fini » (finir produit des commits sur sa branche encore à fusionner).

### 3.3 Cycle de vie (no-poll / interrupt / resume)

- **Pas de polling** : `create` revient immédiatement, l'enfant tourne en arrière-plan, et un message dans l'inbox réveille l'Orchestrator à sa fin. Après la distribution, revenez / répondez à l'utilisateur / terminez le tour — ne bouclez pas sur `list`/statut en gaspillant des tours.
- **Interruption** : interrompre l'Orchestrator n'**arrête pas** ses enfants — ils continuent en arrière-plan et notifient à la fin. Pour arrêter un enfant précis, `session cancel <id>`. Quand toute la session se termine, tous les enfants se terminent avec elle.
- **Tout reprendre** : `session list` énumère les enfants ; pour tout enfant dont le dernier résultat n'était pas un succès (annulé/échoué/jamais rapporté) ou qui a encore des tâches ouvertes, transférez-lui un message via l'action send de `actor` pour continuer. Pas de commande resume dédiée — pilotez la reprise avec list + relais.

## 4. Routage d'approbation des permissions des sessions enfants

**Problème** : un enfant en arrière-plan n'a pas de panneau interactif face à l'utilisateur. Par défaut, une session en arrière-plan qui atteint une porte de permission nécessitant un `ask` (ex. accéder à un répertoire hors de son espace de travail, lire `.env`) est **refusée d'emblée** (`interactive:false` → `DeniedError`) — l'utilisateur ne la voit pas et ne peut pas l'approuver.

Un enfant d'Orchestrator a bien un chemin vers un humain — sa session parente et l'utilisateur regardant la TUI. Donc pour un **enfant peer d'Orchestrator**, un `ask` de permission est **transféré pour approbation** plutôt que refusé en silence :

- **Décision** : `decideAskRouting` (`src/agent/config.ts`) se divise en trois : agents système (checkpoint-writer/dream/distill) → toujours auto-refus ; **peer d'Orchestrator** (background + `mode:peer` + a un parent) → transféré pour approbation ; autre arrière-plan (subagents compose, etc.) → toujours auto-refus.
- **Qui approuve** : une requête transférée peut être résolue par (a) l'**utilisateur directement** (basculer dans l'enfant, via l'UI de permission par session habituelle), ou (b) l'**Orchestrator en votre nom** — quand il détient une autorisation déléguée correspondante.
- **Autorisations déléguées** :
  - `session grant-approval <childSessionID>` — pré-autoriser les futurs asks d'un enfant donné à passer automatiquement ;
  - `session grant-approval all` — pré-autoriser **tous** les enfants de cet Orchestrator ;
  - `session approve <childSessionID>` — approuver ponctuellement la requête actuellement en attente de l'enfant.
- **Déduplication** : il n'existe qu'une seule copie de chaque requête de permission. Le chemin utilisateur direct (`Permission.reply`) et le chemin Orchestrator (`session approve`) convergent sur le même Deferred ; le second est un no-op idempotent. Dès que l'un approuve, la copie transférée de l'Orchestrator est abandonnée — pas de double traitement, pas de requête périmée.
- **Ne bloque jamais** : un ask transféré auquel personne ne répond est **auto-refusé** après `FORWARD_DENY_TIMEOUT_MS` (5 minutes, `src/permission/index.ts`), préservant la garantie « ne bloque jamais » de l'auto-refus d'origine ; l'abortSignal peut l'annuler à tout moment.
- **Notifications** : enregistrer une requête transférée **réveille l'Orchestrator** (note d'inbox avec l'id de l'enfant et comment approuver) et affiche un toast pour l'utilisateur ; la **fin** d'un enfant affiche aussi un toast pour l'utilisateur (pas seulement pour l'Orchestrator).

## 5. L'espace de travail Orchestrator globalement unique

Le mode Orchestrator utilise un **répertoire de travail global fixe** (`<data>/orchestrator`, via `orchestratorDir()` dans `src/global/index.ts`) :

- Peu importe le répertoire depuis lequel vous lancez MiMoCode, **basculer en mode Orchestrator** bascule le répertoire de travail de la TUI vers ce répertoire global et atterrit sur l'**unique** session Orchestrator racine (find-or-create).
- C'est donc toujours la même session Orchestrator quel que soit le point de lancement — les sessions enfants créées auparavant sont toujours visibles et accessibles. Sinon, un lancement depuis des répertoires différents donnerait des sessions Orchestrator différentes, et vous ne retrouveriez pas les enfants créés avant.

Le basculement réutilise la séquence de la boîte de dialogue worktree : `instance.dispose → switchDirectory → sync.bootstrap →` trouver/créer la session racine et naviguer. Le contrôle de confinement au cwd du serveur autorise ce répertoire global appartenant à l'app (uniquement quand la fonctionnalité est activée).

## 6. Drapeau, désactivé par défaut

Un unique drapeau protège toute la capacité, **désactivé par défaut**, opt-in explicite :

```
MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ORCHESTRATOR")
```

- Défaut **OFF** ; mettez `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` pour activer (le parapluie `MIMOCODE_EXPERIMENTAL=1` l'active aussi).
- **Deux portes porteuses** font disparaître complètement la fonctionnalité désactivée :
  1. **Enregistrement de l'agent** (`src/agent/agent.ts`) — l'agent orchestrator n'est enregistré que lorsque le drapeau est activé, via un spread conditionnel (comme pour le mode `max`). Désactivé, il n'est pas dans l'ensemble des agents, donc n'apparaît pas dans le cycle de modes de la TUI (Tab), la boîte de dialogue des agents, ni `defaultAgent`, et aucun peer ne peut être distribué.
  2. **Enregistrement de l'outil** (`src/tool/registry.ts`) — l'outil `session` n'est enregistré que lorsque le drapeau est activé. Désactivé, aucun agent ne peut l'obtenir.
- **Défense en profondeur** (code mort une fois désactivé, mais explicite) : l'effet de changement de répertoire à l'entrée Orchestrator de la TUI fait un early-return quand désactivé ; l'exception de répertoire global du middleware serveur ne s'applique que quand activé ; `decideAskRouting` avec `orchestratorEnabled:false` retombe sur l'auto-refus pour les peers.

Le drapeau est évalué une fois à l'import (lit `process.env`). Les tests le mettent à `true` tôt dans `test/preload.ts` (les suites Orchestrator exercent la fonctionnalité).

## 7. Démarrage rapide

1. Activez la fonctionnalité : `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` (ou `MIMOCODE_EXPERIMENTAL=1`).
2. Lancez MiMoCode et appuyez sur **Tab** pour cycler jusqu'au mode **Orchestrator** — le répertoire de travail bascule automatiquement vers l'espace de travail Orchestrator global et atterrit sur l'unique session Orchestrator.
3. Confiez-lui du travail, ex. : *« Crée un enfant en mode build pour ajouter une page de connexion à repo1, dir réglé sur /path/to/repo1, avec isolate activé ; et un enfant compose pour concevoir le schéma de facturation dans repo2. »*
4. Utilisez `/sessions` (ou faites faire `session list` à l'Orchestrator) pour voir les enfants étiquetés `↳` ; sélectionnez-en un pour vous y attacher entièrement afin de consulter/reprendre, et revenez avec le raccourci session-parent.
5. La fin d'un enfant réveille l'Orchestrator et vous affiche un toast ; les opérations nécessitant une approbation vous sont transférées (ou auto-approuvées selon votre `grant-approval`).
6. Une fois satisfait, faites fusionner/intégrer par l'Orchestrator la branche `mimocode/*` de chaque enfant isolé.

## 8. Sources associées

| Sujet | Emplacement |
|---|---|
| Définition de l'agent Orchestrator + porte du drapeau | `packages/opencode/src/agent/agent.ts` |
| Prompt système Orchestrator (identité de délégateur) | `packages/opencode/src/session/prompt/orchestrator.txt` |
| Outil `session` (8 verbes) | `packages/opencode/src/tool/session.ts` |
| Enregistrement de l'outil + porte du drapeau | `packages/opencode/src/tool/registry.ts` |
| Décision de routage d'approbation des permissions | `packages/opencode/src/agent/config.ts` (`decideAskRouting`) |
| Ref de transfert/autorisation + déduplication | `packages/opencode/src/permission/permission-forward-ref.ts`, `src/permission/index.ts` |
| Espace de travail Orchestrator global | `packages/opencode/src/global/index.ts` (`orchestratorDir`), `src/cli/cmd/tui/app.tsx` |
| Définition du drapeau | `packages/opencode/src/flag/flag.ts` (`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`) |
