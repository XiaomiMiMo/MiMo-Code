# Conception de l'orchestration de workflow multi-skills pour l'Agent

**En une phrase :** Référencer plusieurs skills = l'utilisateur spécifie plusieurs SKILLs et une question, un SKILL-Reminder invite le modèle à créer un workflow multi-SKILL, puis les tâches sont décomposées et persistées sur disque pour résoudre le problème.

## 1. Point de départ de la conception

Dans un contexte multi-skills, la question n'est plus « faut-il l'utiliser » mais « comment les faire coopérer ».

❌ Problème de déclenchement classique
Le harness doit deviner à partir de la sémantique de la requête quels skills activer, ce qui conduit facilement à des déclenchements manqués ou erronés.

✅ `/skill` explicite comme solution
L'utilisateur écrit directement `/skill-a /skill-b` dans le champ de saisie — le déclenchement est précis à 100 %, sans ambiguïté sémantique.

🎯 Le défi restant
Comment orchestrer plusieurs skills : qui passe en premier, comment les données circulent, comment arbitrer les conflits.

## 2. Répartition des responsabilités en trois couches

| Couche | Responsabilité | Action clé | Repli en cas d'échec |
|--------|----------------|------------|----------------------|
| Couche utilisateur | Déclaration explicite d'intention via `/` | Écrire `/skill-a /skill-b` directement dans le champ de saisie | Non concernée |
| Couche harness | Vérification statique + injection du Reminder | Analyser le frontmatter, détecter les points de conflit, générer un prompt ciblé | Repli vers un Reminder générique |
| Couche modèle | Produire un workflow structuré | Lire SKILL.md → juger la relation de composition → définir le contrat → persister sur disque | La dérive d'exécution des tâches est atténuée par la persistance sur disque |

## 3. Emplacement et moment de l'injection

Décision centrale : le Reminder est un message injecté par le système, ajouté après le message utilisateur (alignement avec le modèle `long_conversation_reminder` d'Anthropic) — il ne réécrit pas le system prompt.

Pourquoi la couche message plutôt que la modification du system prompt

| Dimension | Modifier le system prompt | Ajouter après le message utilisateur (option retenue) |
|-----------|--------------------------|-------------------------------------------------------|
| Taux de suivi des instructions | Loin de la requête, taux de suivi plus faible | Proche de la requête, taux de suivi nettement supérieur |
| Taux de succès du cache de préfixe | Pollue le préfixe ; toute modification du contenu casse le cache | Le préfixe reste stable ; tout le contenu dynamique descend dans la couche message |
| Injection à la demande | Difficile à conditionner au niveau du tour | N'apparaît que sur les tours avec ≥ 2 `/skill` ; les autres tours n'en ont pas conscience |

Règles de déclenchement conditionnel

Ne pas injecter le Reminder pour un seul `/skill`.

Un scénario mono-skill n'a pas de problème d'orchestration ; forcer une planification ne fait qu'ajouter de la latence et induit une surplanification (rédiger un plan en trois parties pour une tâche triviale). La condition de déclenchement doit être précise :

- Nombre de `/` == 0 → ne pas injecter
- Nombre de `/` == 1 → ne pas injecter
- Nombre de `/` ≥ 2 → injecter le Reminder

## 4. Conception du contenu du Reminder

L'essentiel est que la planification produise quelque chose de structuré et vérifiable, et non un vague « je fais A puis B ».

### Modèle de Reminder

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

## 5. Synthèse des arbitrages de conception

| Point d'arbitrage | Choix | Alternative écartée et raison |
|-------------------|-------|-------------------------------|
| Mécanisme de déclenchement | `/skill` explicite | Écarté : correspondance sémantique automatique — peu fiable et sujette au sur-déclenchement |
| Emplacement d'injection du Reminder | Après le message utilisateur | Écarté : modifier le system prompt — casse le cache de préfixe, taux de suivi plus faible |
| Seuil de déclenchement | `/skill` ≥ 2 | Écarté : injection systématique — pour un seul skill, cela n'ajoute que de la latence et induit une surplanification |
| Contenu du Reminder | Contraindre la structure de sortie | Écarté : enseigner des procédures spécifiques — le contenu des skills évolue, le codage en dur est difficile à maintenir |
| Stockage du workflow | Persistance sur disque / Task | Écarté : conserver uniquement dans le message assistant — les tâches longues finissent inévitablement par le diluer et le perdre |
| Amélioration du harness | Pré-analyse statique des conflits | Écarté : laisser le modèle découvrir seul — la vérification statique est plus fiable à un coût quasi nul |
