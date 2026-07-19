# MiMo Token Efficient Mode

**Кратко в одном предложении**: использует общий пайплайн фильтрации на регулярных выражениях + эвристический пайплайн фильтрации для удаления избыточных токенов из вывода Bash (экспериментальная функция, по умолчанию отключена).

## 1. Предпосылки и цели

stdout/stderr инструмента bash часто «раздуваются» следующим шумом:

- ANSI цветовые коды, OSC гиперссылки, DCS управляющие последовательности терминала

- Наложение нескольких кадров прогресс-баров через `\r`

- Случайно выведенные API-ключи / JWT / PEM-сертификаты

- Сверхдлинные строки вроде minified JS / однострочного JSON

- Бесполезная информация из pytest / go test / ...

**Основное ограничение**: очистка предназначена только для LLM; предпросмотр в реальном времени в TUI и архив на диске сохраняют исходные байты для удобства ручной отладки.

## 2. Общий поток

Диаграмма ниже показывает сквозной путь очистки вывода инструмента bash от захвата до доставки в LLM. Она объединяет общий пайплайн фильтрации (Глава 3), эвристический пайплайн фильтрации (Глава 4) и ограничения трёхстороннего разделения inline / диск / TUI (Глава 5).

Три основных ограничения и их расположение на диаграмме:

- **Очищаем только inline, не диск** — две крайние левые ветви на входе (архив на диск / предпросмотр TUI) полностью обходят пайплайн.

- **Защитник never-worse** — единый откат в хвосте пайплайна: любой этап, увеличивший вывод, отбрасывается, возврат к пути Raw.

- **Один флаг, по умолчанию выключен** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` — единственный переключатель для входа в пайплайн очистки, по умолчанию отключён; иначе вывод идёт напрямую по пути Raw.




## 3. Общий пайплайн фильтрации



|**Слой**|**Обязанность**|**Ключевые regex / алгоритм**|**Порядковое ограничение**|
|---|---|---|---|
|clean_progress_pipeline|Построчно сворачивает прогресс-бары `\r`, оставляя только последний кадр|Разбить по строкам, взять сегмент после последнего `\r` в каждой строке|Должен выполняться до clean_ansi_pipeline|
|clean_ansi_pipeline|Удаляет ANSI CSI/OSC/DCS, backspace overstrike, управляющие байты|4 regex для ESC-последовательностей + класс символов для управляющих байтов|После progress, до последующих regex|
|clean_redact_pipeline|PEM, Bearer, JWT, ключи AWS/GH/OpenAI/Anthropic/Slack|8 групп regex + замена всего многострочного PEM-блока|Должен выполняться до дедупликации/усечения|
|clean_longline_pipeline|Сжимает одиночные строки длиннее 500 символов до заголовка в 160 символов + подсказка об элизии|Построчное сканирование, проверка по порогу длины|Ставится последним как страховка|
|защитник never-worse|Если очистка не уменьшила количество байтов, откат к исходному тексту|При bytesOut ≥ bytesIn возвращает исходный text|Хвост пайплайна|

### 3.1 Справочник regex по слоям

Приведённые ниже константы напрямую соответствуют реализации в `packages/opencode/src/tool/bash_token_efficient.ts`. L1 / L4 — это построчные алгоритмы сканирования без отдельных regex; L0 / L3 вместе определяют 14 regex (4 ESC + 1 управляющий байт + 1 многострочный PEM + 8 inline-секретов).

**L0 clean_ansi — 4 ESC regex + 1 класс управляющих байтов**

```ts
const ANSI_CSI   = /\x1b\[[0-?]*[ -/]*[@-~]/g              // CSI-последовательность  ESC[ ... терминатор
const ANSI_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g    // OSC-последовательность  ESC] ... BEL или ESC\
const ANSI_DCS   = /\x1b[PX^_][\s\S]*?\x1b\\/g             // DCS/SOS/PM/APC многострочная последовательность
const BACKSPACE  = /[^\n]\x08/g                            // Backspace overstrike  циклическая замена до отсутствия совпадений
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g     // Управляющие байты  сохраняются \t \n \r
```

**L3 clean_redact — 1 многострочный PEM-блок + 8 паттернов inline-секретов**

```ts
// Замена всего многострочного PEM-блока → <redacted-pem-block>
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi,                          "$1 <redacted>"],
  // JWT  eyJ, три сегмента base64url (каждый ≥10 символов)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,    "<redacted-jwt>"],
  // AWS access key  префикс AKIA / ASIA + 16 заглавных букв/цифр
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                        "<redacted-aws-key>"],
  // GitHub fine-grained / classic  gh[pousr]_ + ≥20 символов
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                       "<redacted-gh-token>"],
  // OpenAI  sk- + ≥20 символов
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g,                                           "<redacted-openai-key>"],
  // Anthropic  sk-ant- + ≥20 символов
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,                                       "<redacted-anthropic-key>"],
  // Slack  xox[abprs]- + ≥10 символов
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,                                    "<redacted-slack-token>"],
  // Универсальный KEY=VALUE / "key": "value"  значение ≥12 символов
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]
```

**L1 clean_progress — построчное сворачивание прогресс-баров `\r`**

```ts
// Алгоритм  без отдельного regex
text.split("\n").map(line => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  const idx = stripped.lastIndexOf("\r")
  return idx === -1 ? stripped : stripped.slice(idx + 1)   // оставляем только последний кадр
}).join("\n")
```

**L4 clean_longline — сжатие сверхдлинных одиночных строк**

```ts
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

text.split("\n").map(line => {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
}).join("\n")
```

**Защитник never-worse — откат в хвосте пайплайна**

```ts
const bytesOut = Buffer.byteLength(out, "utf-8")
if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
  return { text, bytesIn, bytesOut: bytesIn, degraded: true }   // экономии нет  возвращаем исходный текст
}
```

## 4. Эвристический пайплайн фильтрации

### 4.1 Двухканальное распознавание формы

Нельзя полагаться только на имя команды (пользователи часто вкладывают пайпы: `bash -c "cd x && pytest"`) или только на начало вывода (первые 30 строк могут быть сплошным ANSI-шумом). Два канала выполняются последовательно:

```ts
// Канал имени команды
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

// Канал отпечатка содержимого (запасной вариант, если имя команды не совпало)
const BODY_FINGERPRINTS: Array<[RegExp, ShapeID]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m,                          "gitdiff"],
  [/^Traceback \(most recent call last\)/m,  "stacktrace"],
  [/^\s*at .+:\d+:\d+/m,                     "stacktrace"],
  [/^error\[E\d+\]:/m,                       "stacktrace"],
]
```

### 4.2 Справочник стратегий по формам

|**Совпадение команды**|**Основное правило усечения**|**Ожидаемое сокращение**|
|---|---|---|
|git diff / git show|Полное подавление блоков по allowlist для lockfile / min.js / dist путей; ограничение 100 строк на hunk; в конце файла добавляется +added -removed|85%|
|pytest|Автомат из 4 состояний Header → TestProgress → Failures → Summary, сохраняет collected / строки E / file:line: / FAILED / short summary|90%|
|npm/pnpm/yarn install|Сворачивает подряд идущие «npm warn deprecated» в [×N deprecation warnings: top: A, B, C], сохраняет сводку added/vuln/funding|65%|
|make / cmake / automake|Удаляет Entering/Leaving directory, «голые» команды компиляции, каретки; сохраняет file:line:col: error: и note: под ним|53%|
|Traceback / at ...:N:N / error[E...]|Сворачивает кадры site-packages / .venv / node_modules / stdlib; ≥2 подряд объединяются в [N dependency frame(s) suppressed]|69%|
|tsc|Группировка по коду ошибки Top-5 в одну строку; группировка по файлу Top-8; по одному образцу на группу|80%|
|kubectl get pods|Trailer предлагает `-o json`; на клиенте сворачиваются только подряд идущие «все Running/0 restart», колонки не переписываются|70%|
|Вывод, начинающийся с { или [|Два режима: по умолчанию обрезаются большие поля embedding/raw_html/body/content/base64; в режиме schema-only выводятся ключи с типами|95%|
|gh pr view / gh issue view|Очищает HTML-комментарии, строки бейджей, чисто-графические строки, декоративные ---, множественные пустые строки|~50%|
|go test ... -json|Потоковая агрегация NDJSON: накопление pass/fail/skip по pkg; при fail использует накопленный output как причину|90%|

### 4.2 Passthrough уровня команды

Пропускаем вывод без очистки, если пользователь уже сам делает проекцию:

- Команда содержит `--json` / `--format json` / `-o json` / `--no-color`

- Хвост команды содержит `| tee` / `| xxd` / `| hexdump`

- Команда содержит `# nofilter` / `# raw` (уже реализовано)

### 4.5 Контракт расширения

Для добавления новой формы достаточно реализовать интерфейс `Shape { match, apply }`, основной вход остаётся без изменений:

```TypeScript
export interface Shape {
  id: string
  match: (command: string, head4k: string, tail4k: string) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

const SHAPES = [S_gitdiff, S_pytest, S_npm, S_make, S_stacktrace,
                S_tsc, S_kubectl, S_json, S_md, S_gostest]
```



## 5. Прочие детали

**Очистка только inline, диск не трогаем** — как только вывод достигает файла усечения (либо ранний overflow потока, либо финальный `trunc.write(raw)`), очистка пропускается. Архив на диске хранит исходные байты для удобства ручного grep; в пайплайн очистки попадает только inline-вывод, и экономия байт тратится на самый часто читаемый путь.

**Предпросмотр TUI не изменяется** — `metadata.output` — это поле живого предпросмотра TUI, оно хранится как исходный потоковый снимок; через очистку проходит только финальный `output`. Это позволяет избежать побочных эффектов очистки, мешающих человеку читать оригинальный вывод терминала.

**Один флаг, по умолчанию выключен** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` — независимый флаг-переключатель, по умолчанию отключён, не выводится из `MIMOCODE_EXPERIMENTAL=1`. Явный opt-in избавляет от тихого изменения поведения по умолчанию.

