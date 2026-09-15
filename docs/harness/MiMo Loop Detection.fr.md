# MiMo Loop Detection

**Résumé en une phrase** : deux détecteurs et un seul traitement. La répétition de la chaîne de raisonnement est détectée par des n-grammes à grande fenêtre et grand N ; les appels d'outils répétés sont détectés par des appels consécutifs identiques ou périodiques, sans vérification de progression ; le traitement réutilise l'escalade à trois niveaux déjà présente dans le code (rappel → replanification → arrêt). Aucun modèle supplémentaire ; tout s'exécute dans le runtime de l'agent (`packages/opencode/src/session/`).

Toutes les valeurs ci-dessous sont des points de départ à calibrer sur de vraies trajectoires.

## 1. Détection de la répétition de la chaîne de raisonnement

N'inspecter que le reasoning et le texte générés à l'étape courante. Ne jamais y mêler l'entrée utilisateur ni les sorties d'outils. Si le fournisseur n'expose qu'un résumé de la réflexion, seul ce résumé peut être vérifié.

### Paramètres

| Élément | Valeur |
| --- | --- |
| Fenêtre glissante | les 8192 derniers tokens du détecteur (sortie de `tokenizeForNgram` : mots séparés par des espaces, CJK caractère par caractère) |
| Longueur du n-gramme | 64 |
| Déclenchement | le même n-gramme apparaît ≥ 3 fois, compté à des positions non chevauchantes |
| Cadence | vérification tous les 256 nouveaux tokens ; en cas de détection, interrompre la génération et renvoyer `text-repeat` |

### Implémentation

Réutiliser le point d'accroche en flux de `TextNgramMonitor` (`checkTextNgram` dans `processor.ts`, et `max-mode.ts`). Remplacer le détecteur interne `detectConsecutiveRepeat` par `detectRepeatedNgram(tokens, 64, 3)`, déjà écrit, et porter la fenêtre de 500 à 8192. Le hachage glissant (remplaçant `slice().join()` pour un coût O(1) par token) est reporté ; l'implémentation actuelle amortit la vérification via `MIMOCODE_TEXT_NGRAM_CHECK_INTERVAL` (256 tokens par défaut).

Variables : `MIMOCODE_TEXT_NGRAM_N=64`, `MIMOCODE_TEXT_REPEAT_THRESHOLD=3`, `MIMOCODE_TEXT_WINDOW_TOKENS=8192`.

### Hors périmètre

Pas de MinHash/Jaccard, pas de taux de couverture, pas d'exclusion des blocs de code. Les reformulations peuvent échapper à la détection pour l'instant.

## 2. Détection des appels d'outils répétés

Conserver les signatures des 12 derniers appels d'outils terminés. Signature = nom de l'outil + arguments (clés JSON triées, réutiliser `stableStringify`). Ne pas compresser les espaces à l'intérieur des chaînes et ne supprimer aucun argument. Les arguments font partie de la comparaison : lire trois fichiers différents à la suite n'est pas une répétition.

| Type | Condition |
| --- | --- |
| Appels consécutifs identiques | les 3 dernières signatures sont identiques. Correspond au `REPEATED_STEP_THRESHOLD=3` existant |
| Appels périodiques | la séquence de signatures a une période p ∈ [2, 4] et les 3p derniers appels coïncident position par position. Exemple : lire A → grep B → lire A → grep B → lire A → grep B |

En cas de détection, ne pas vérifier si les fichiers ou les tests ont changé. Passer directement au traitement de la section 3.

### Exceptions : sondage et nouvelles tentatives (seuils assouplis, toujours journalisés)

> Pas encore implémenté. La version actuelle compte le sondage et les nouvelles tentatives comme tout autre appel ; cette section est un travail ultérieur.

- Commandes bash contenant `sleep`, `wait`, `watch`, `poll`, `status`, `tail -f`, ou outils d'attente/surveillance par nature : autoriser 10 occurrences de la même signature ou 10 minutes cumulées, puis traiter comme des appels consécutifs identiques.
- Le résultat précédent était une erreur réseau transitoire (`ETIMEDOUT`, `ECONNRESET`, HTTP 5xx / 429) : autoriser 3 nouvelles tentatives avec backoff, non comptabilisées comme répétition.

## 3. Traitement : escalade à trois niveaux

Réutiliser le mécanisme existant (`RECOVERY_PROMPT_MILD/STRONG`, `TEXT_NGRAM_RECOVERY_REMIND/REPLAN`). Les deux détecteurs partagent un seul compteur, plafonné à 2 récupérations par tour utilisateur.

| Détection n° | Action | Contenu injecté |
| --- | --- | --- |
| 1re | Rappel (remind) | Interrompre la génération ou suspendre le prochain appel ; ajouter un message utilisateur synthétique indiquant ce qui s'est répété (fragment de n-gramme / signature d'outil et nombre) et demandant une autre formulation ou une autre action |
| 2e | Replanification (replan) | Exiger l'abandon de l'approche courante, la rédaction d'un nouveau plan, et l'explication de ce qui était tenté, pourquoi cela a échoué et en quoi le nouveau plan diffère |
| 3e | Arrêt (terminate) | Publier `Session.Event.Error`, conserver les modifications existantes, rapporter les actions en boucle, les récupérations tentées et le blocage courant |

Sur une détection de chaîne de raisonnement, marquer l'étape assistant courante en erreur afin que `toModelMessages` l'ignore et que la queue répétée ne revienne jamais dans la requête suivante. Sur une détection d'outil, ne jamais rejouer ni annuler automatiquement du code.

## 4. Intégration et journalisation

- **Dans le flux de génération** : la détection n-gramme tourne de façon incrémentale ; sans flux, vérifier toute la sortie après la génération.
- **Après la fin d'une étape, avant la décision suivante** : mettre à jour la fenêtre de signatures et exécuter les contrôles consécutif/périodique. C'est l'emplacement du « repeated-step nudge » existant ; faire passer ce nudge par l'escalade à trois niveaux et le compter.

Journaliser `loop_detected` (type, signature ou fragment, nombre), `recovery_attempted` (niveau) et `loop_terminated`. Démarrer avec `MIMOCODE_LOOP_MODE=monitor` (journal seul), relire manuellement les trajectoires détectées, puis passer à `enforce`. `MIMOCODE_LOOP_MODE` vaut `monitor` par défaut et ne concerne que les deux détecteurs de ce document ; la garde existante sur les sorties identiques entre étapes n'est pas affectée.

> Ne pas remplacer ceci par `no_repeat_ngram_size` au décodage : il bloque le code, les chemins et tout contenu qui doit légitimement se répéter, et n'a rien à voir avec la détection de boucle à l'exécution.
