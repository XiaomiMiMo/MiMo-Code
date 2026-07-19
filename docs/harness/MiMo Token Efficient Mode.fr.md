# MiMo Token Efficient Mode

**Résumé en une phrase** : utilise un pipeline de filtrage par regex générique + un pipeline de filtrage heuristique pour retirer les tokens redondants de la sortie Bash (fonctionnalité expérimentale, désactivée par défaut).

## 1. Contexte et objectifs

Le stdout/stderr de l'outil bash sont souvent « saturés » par le bruit suivant :

- Codes couleur ANSI, hyperliens OSC, séquences de contrôle terminal DCS

- Superposition multi-frame des barres de progression `\r`

- Clés d'API / JWT / certificats PEM imprimés par erreur

- Lignes ultra-longues comme JS minifié / JSON sur une seule ligne

- Informations inutiles de pytest / go test / ...

**Contrainte principale** : le nettoyage vise uniquement la vue LLM ; l'aperçu en direct du TUI et les archives sur disque conservent les octets bruts pour faciliter le debug humain.

## 2. Flux global

Le diagramme ci-dessous illustre le chemin de nettoyage de bout en bout de la sortie de l'outil bash, de la capture jusqu'à sa livraison au LLM. Il intègre le pipeline de filtrage générique (Chapitre 3), le pipeline de filtrage heuristique (Chapitre 4) et les contraintes de séparation en trois voies pour inline / disque / TUI (Chapitre 5).

Les trois contraintes principales et leur position dans le diagramme :

- **Nettoyer uniquement l'inline, pas le disque** — les deux voies les plus à gauche à l'entrée (archive disque / aperçu TUI) contournent entièrement le pipeline.

- **Garde-fou never-worse** — rollback unifié en queue de pipeline : toute étape qui augmenterait la taille est rejetée, retour au chemin Raw.

- **Un seul flag, désactivé par défaut** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` est le seul interrupteur pour entrer dans le pipeline de nettoyage, désactivé par défaut ; sinon la sortie passe directement en Raw.




## 3. Pipeline de filtrage générique



|**Couche**|**Rôle**|**Regex / algorithme clé**|**Contrainte d'ordre**|
|---|---|---|---|
|clean_progress_pipeline|Ligne par ligne, replie les barres de progression \r, ne garde que la dernière frame|Découper par lignes, prendre le segment après le dernier \r de chaque ligne|Doit s'exécuter avant clean_ansi_pipeline|
|clean_ansi_pipeline|Retire ANSI CSI/OSC/DCS, backspace overstrike, octets de contrôle|4 regex de séquences ESC + classe de caractères pour octets de contrôle|Après progress, avant les regex suivantes|
|clean_redact_pipeline|PEM, Bearer, JWT, clés AWS/GH/OpenAI/Anthropic/Slack|8 groupes de regex + substitution du bloc PEM multiligne|Doit s'exécuter avant la déduplication/troncature|
|clean_longline_pipeline|Compresse les lignes uniques de plus de 500 caractères en un début de 160 caractères + indice d'élision|Balayage ligne par ligne, décision par seuil de longueur|En dernier, comme filet de sécurité|
|garde never-worse|Si le nettoyage n'a pas réduit les octets, rollback vers le texte original|Si bytesOut ≥ bytesIn, retourne le texte original|Queue du pipeline|

### 3.1 Aide-mémoire regex par couche

Les constantes ci-dessous correspondent directement à l'implémentation dans `packages/opencode/src/tool/bash_token_efficient.ts`. L1 / L4 sont des algorithmes de balayage ligne par ligne sans regex isolée ; L0 / L3 définissent ensemble 14 regex (4 ESC + 1 octet de contrôle + 1 PEM multiligne + 8 secrets inline).

**L0 clean_ansi — 4 regex ESC + 1 classe d'octets de contrôle**

```ts
const ANSI_CSI   = /\x1b\[[0-?]*[ -/]*[@-~]/g              // séquence CSI  ESC[ ... terminateur
const ANSI_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g    // séquence OSC  ESC] ... BEL ou ESC\
const ANSI_DCS   = /\x1b[PX^_][\s\S]*?\x1b\\/g             // séquence DCS/SOS/PM/APC multiligne
const BACKSPACE  = /[^\n]\x08/g                            // backspace overstrike  boucle de remplacement jusqu'à absence de match
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g     // octets de contrôle  conserve \t \n \r
```

**L3 clean_redact — 1 bloc PEM multiligne + 8 patterns de secrets inline**

```ts
// Remplacement du bloc PEM multiligne → <redacted-pem-block>
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi,                          "$1 <redacted>"],
  // JWT  eyJ trois segments base64url (chacun ≥ 10 caractères)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,    "<redacted-jwt>"],
  // Clé d'accès AWS  préfixe AKIA / ASIA + 16 alphanumériques majuscules
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                        "<redacted-aws-key>"],
  // GitHub fine-grained / classic  gh[pousr]_ + ≥ 20 caractères
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                       "<redacted-gh-token>"],
  // OpenAI  sk- + ≥ 20 caractères
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g,                                           "<redacted-openai-key>"],
  // Anthropic  sk-ant- + ≥ 20 caractères
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,                                       "<redacted-anthropic-key>"],
  // Slack  xox[abprs]- + ≥ 10 caractères
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,                                    "<redacted-slack-token>"],
  // KEY=VALUE / "key": "value" générique  valeur ≥ 12 caractères
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]
```

**L1 clean_progress — Repliement ligne par ligne des barres de progression `\r`**

```ts
// Algorithme  pas de regex isolée
text.split("\n").map(line => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  const idx = stripped.lastIndexOf("\r")
  return idx === -1 ? stripped : stripped.slice(idx + 1)   // ne garde que la dernière frame
}).join("\n")
```

**L4 clean_longline — Compression des lignes ultra-longues**

```ts
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

text.split("\n").map(line => {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
}).join("\n")
```

**garde never-worse — Rollback en queue de pipeline**

```ts
const bytesOut = Buffer.byteLength(out, "utf-8")
if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
  return { text, bytesIn, bytesOut: bytesIn, degraded: true }   // aucune économie  retourne l'original
}
```

## 4. Pipeline de filtrage heuristique

### 4.1 Détection de forme à deux canaux

On ne peut pas se fier uniquement au nom de la commande (les utilisateurs imbriquent souvent des pipes : `bash -c "cd x && pytest"`), ni uniquement au début de la sortie (les 30 premières lignes peuvent n'être que du bruit ANSI). Deux canaux exécutés en série :

```ts
// Canal nom-de-commande
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

// Canal empreinte-contenu (fallback quand le nom de commande ne matche pas)
const BODY_FINGERPRINTS: Array<[RegExp, ShapeID]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m,                          "gitdiff"],
  [/^Traceback \(most recent call last\)/m,  "stacktrace"],
  [/^\s*at .+:\d+:\d+/m,                     "stacktrace"],
  [/^error\[E\d+\]:/m,                       "stacktrace"],
]
```

### 4.2 Aide-mémoire des stratégies par forme

|**Commande détectée**|**Règle principale de trimming**|**Réduction attendue**|
|---|---|---|
|git diff / git show|Suppression complète des blocs par allowlist lockfile / min.js / chemins dist ; cap de 100 lignes par hunk ; append +added -removed en queue de fichier|85%|
|pytest|Machine à 4 états Header → TestProgress → Failures → Summary, conserve collected / lignes E / file:line: / FAILED / short summary|90%|
|npm/pnpm/yarn install|Replie les "npm warn deprecated" consécutifs en [×N deprecation warnings: top: A, B, C], conserve le résumé added/vuln/funding|65%|
|make / cmake / automake|Supprime Entering/Leaving directory, commandes de compilation nues, carets ; conserve file:line:col: error: et le note: en dessous|53%|
|Traceback / at ...:N:N / error[E...]|Replie les frames site-packages / .venv / node_modules / stdlib ; ≥ 2 consécutives fusionnées en [N dependency frame(s) suppressed]|69%|
|tsc|Groupe par code d'erreur Top-5 en résumé une ligne ; groupe par fichier Top-8 ; garde 1 échantillon par groupe|80%|
|kubectl get pods|Trailer suggère -o json ; côté client replie uniquement les lignes consécutives "tous Running/0 restart", ne réécrit pas les colonnes|70%|
|Sortie commençant par { ou [|Deux modes : par défaut trim les champs volumineux embedding/raw_html/body/content/base64 ; mode schema-only infère les clés avec types|95%|
|gh pr view / gh issue view|Nettoie commentaires HTML, lignes de badges, lignes image pure, --- décoratifs, lignes vides multiples|~50%|
|go test ... -json|Agrégation flux NDJSON : accumule pass/fail/skip par pkg ; en cas de fail utilise la sortie accumulée comme cause|90%|

### 4.2 Passthrough au niveau commande

Laisse passer la sortie sans nettoyage quand l'utilisateur fait déjà de la projection :

- La commande contient `--json` / `--format json` / `-o json` / `--no-color`

- La queue de commande contient `| tee` / `| xxd` / `| hexdump`

- La commande contient `# nofilter` / `# raw` (déjà implémenté)

### 4.5 Contrat d'extension

L'ajout d'une nouvelle forme nécessite juste l'implémentation de l'interface `Shape { match, apply }`, sans intrusion au point d'entrée principal :

```TypeScript
export interface Shape {
  id: string
  match: (command: string, head4k: string, tail4k: string) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

const SHAPES = [S_gitdiff, S_pytest, S_npm, S_make, S_stacktrace,
                S_tsc, S_kubectl, S_json, S_md, S_gostest]
```



## 5. Autres détails

**Nettoyage inline uniquement, pas sur disque** — dès que la sortie atteint le fichier de troncature (soit débordement précoce du flux, soit `trunc.write(raw)` final), le nettoyage est ignoré. Les archives disque préservent les octets bruts pour un grep humain ; seule la sortie inline entre dans le pipeline de nettoyage, dépensant les économies d'octets sur le chemin le plus lu.

**Aperçu TUI intact** — `metadata.output` est le champ d'aperçu live du TUI, conservé comme snapshot streaming brut ; seul le `output` final passe par le nettoyage. Cela évite que les effets de bord du nettoyage n'interfèrent avec la lecture humaine de la sortie terminal originale.

**Un seul flag, désactivé par défaut** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` est un flag autonome qui contrôle l'interrupteur, désactivé par défaut, non dérivé de `MIMOCODE_EXPERIMENTAL=1`. L'opt-in explicite évite de modifier silencieusement la sortie par défaut.

