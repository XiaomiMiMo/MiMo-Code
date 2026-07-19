# super-research

[English](README.en.md) · [中文](README.md) · [日本語](README.ja.md) · [Français](README.fr.md) · [Español](README.es.md) · [Русский](README.ru.md)

**Skill de investigación autónoma** para Claude Code / Claude.ai. Deja que un agente corra un rato (minutos u toda una noche) y recibe **evidencia comparable, honesta y auditable** — no una respuesta puntual de caja negra.

Inspirado en el [autoresearch](https://github.com/karpathy/autoresearch) de Karpathy. Este skill generaliza esa metodología a seis modos de investigación.

---

## Qué es

Una disciplina de trabajo pensada para "si dejas al agente corriendo toda la noche, deberías poder confiar en el resultado a la mañana siguiente". El valor no está en el procedimiento específico — está en **la misma disciplina en cada modo**:

1. **Contrato antes de actuar** — anota el objetivo, la salida principal, la condición de parada; confirma una vez. Después, no más preguntas.
2. **Baseline primero** — cada modo tiene "la respuesta sin ninguno de mis cambios" (código sin modificar / primeros tres resultados de búsqueda / dataset crudo). Regístrala primero, si no "mejor" y "significativo" no significan nada.
3. **Cada paso en un log legible por máquina, incluidos los fallos** — TSV (no CSV; las descripciones llevan comas). Descartar en silencio los intentos fallidos es la vía más rápida al autoengaño.
4. **Sin consultas a mitad del bucle** — tras confirmar el contrato, el agente no se detiene a preguntar "¿sigo?". El humano puede estar durmiendo.
5. **Sin trampas** — no editar el código de evaluación, no descartar fuentes incómodas, no p-hacking, no cherry-picking de subconjuntos favorables.

---

## Seis modos

El skill elige el modo según la formulación del usuario. También puedes especificarlo explícitamente.

| Modo | Cuándo usarlo | Frases desencadenantes | Detalles |
| --- | --- | --- | --- |
| **Experiment loop** | Mejorar un sistema hacia un objetivo numérico | "optimize", "tune", "hill-climb", "correr experimentos toda la noche" | `references/experiment-loop.md` |
| **Topic survey / 主题调研** | Recopilar + sintetizar fuentes externas sobre una pregunta | "survey", "revisión bibliográfica", "estado del arte en X" | `references/topic-survey.md` |
| **Quantitative analysis / 量化分析** | Responder una pregunta cuantificable desde un dataset | "analizar este dataset", "¿X predice Y?" | `references/quant-analysis.md` |
| **Benchmark comparison / 对比评测** | Elegir entre N candidatos | "comparar X vs Y", "¿qué librería deberíamos usar?" | `references/benchmark-comparison.md` |
| **Root-cause investigation / 根因排查** | Diagnosticar una regresión / flake / caída de rendimiento | "¿por qué está roto X?", "depurar la regresión" | `references/root-cause.md` |
| **Ablation study / 消融实验** | Atribuir la contribución de los componentes de un sistema | "ablate", "qué partes de X importan" | `references/ablation-study.md` |

**Distinciones entre modos adyacentes** (el skill elige, pero puedes guiar):

- **Experiment loop vs Benchmark** — experiment mejora *un* sistema; benchmark elige entre *varios*. "Elegir entre" → benchmark; "empujar esta métrica" → experiment.
- **Experiment loop vs Ablation** — ambos editan y vuelven a medir. Experiment conserva las mejoras; ablation conserva *cada* resultado y nunca se detiene antes de tiempo — el objetivo es comprender, no optimizar.
- **Root-cause vs Experiment loop** — root-cause investiga una baseline *rota*; experiment escala desde una *que funciona*. El esquema del log y la regla de parada difieren.

---

## Cómo usarlo

### Frase desencadenante

El skill se carga automáticamente con las frases coincidentes. O especifica explícitamente:

```
Usa el modo <mode> de super-research. Corre toda la noche. Salida en <dir>/.
```

### Flujo típico

```
Tú     : Compara lib_a, lib_b, lib_c para limpieza de texto. Benchmark comparison,
         sin tuning por candidato. Cada uno de los 5 casos al menos dos veces.
Claude : [dispara skill → lee SKILL.md + references/benchmark-comparison.md]
         [redacta contrato: candidatos, matriz, métricas, presupuesto de equidad, dir]
         [pide una confirmación — tu última oportunidad de hablar]
Tú     : Confirmado
Claude : [bucle autónomo — smoke-test del harness → corre matriz → cada celda a
          matrix.tsv → agrega → drop-one-case → report.md]
         [informe final: ganador / ranking / estabilidad / notas de integración / logs]
```

Punto clave: **tras el contrato, Claude no vuelve a preguntar**. Puede correr durante decenas de minutos a horas. Puedes irte.

### Entregables por modo

| Modo | Directorio de trabajo | Log principal | Entregable |
| --- | --- | --- | --- |
| Experiment loop | `research/<tag>/` (rama de git) | `results.tsv` | Mejor commit + informe |
| Topic survey | `survey/<tag>/` | `sources.tsv` + `claims.tsv` | Survey `report.md` con citas |
| Quant analysis | `analysis/<tag>/` | `analysis_log.tsv` | `scripts/` + `report.md` + `figures/` |
| Benchmark | `benchmark/<tag>/` | `matrix.tsv` | Ranking + recomendación `report.md` |
| Root-cause | `investigation/<tag>/` | `hypotheses.tsv` + `baseline.md` | Causa raíz + demostración de reversión bidireccional |
| Ablation | `ablation/<tag>/` | `ablation.tsv` | Clasificación de componentes + informe |

Los logs son **TSV** (separado por tabulaciones) con encabezado. Los directorios se crean en el directorio de trabajo actual; `<tag>` toma por defecto la fecha del día (p. ej. `jul7`).

### Forma del informe final

Todos los modos terminan con un markdown compacto (≤ 1 página):

- **Contract** — qué te propusiste hacer
- **Baseline vs final** — números de partida vs finales
- **What worked** — 3–5 puntos con evidencia
- **What didn't** — callejones sin salida, crashes, contradicciones. **Aquí está la señal más alta.**
- **Open questions / next steps**
- **Where to look** — logs, rama, artefactos

La idea: **que un humano pueda verificar el trabajo en 5 minutos y sepa dónde mirar a continuación**. No storytelling.

---

## Estructura de directorios

```
super-research/
├── SKILL.md                     # frontmatter (disparo) + disciplina compartida + tabla de modos
├── references/                  # uno por modo; se carga solo cuando ese modo se elige
│   ├── experiment-loop.md
│   ├── topic-survey.md
│   ├── quant-analysis.md
│   ├── benchmark-comparison.md
│   ├── root-cause.md
│   └── ablation-study.md
└── evals/                       # para testear el propio skill
    ├── evals.json               # 8 casos de test con assertions
    ├── toy_repo/                # fixture experiment-loop (script de entrenamiento sintético)
    ├── toy_dataset/             # fixture quant-analysis (datos de Simpson's paradox)
    ├── toy_bench/               # fixture benchmark (3 cleaners × 5 casos)
    ├── toy_regression/          # fixture root-cause (repo de 5 commits bisectable)
    └── toy_pipeline/            # fixture ablation (5 componentes conmutables)
```

---

## Progressive disclosure (el diseño)

- **SKILL.md siempre en contexto** — pero solo la disciplina compartida + la tabla de modos. Menos de 100 líneas.
- **`references/<mode>.md` se carga bajo demanda** — tras elegir un modo, solo se lee ese archivo.
- **evals/ nunca entra en contexto** — se usa únicamente al correr el harness de evaluación de skill-creator.

Así que cuando el skill se dispara, Claude lee unos cientos de líneas extra en total, no el conjunto completo de reglas de los seis modos.

---

## Testear / iterar el skill mismo

`evals/evals.json` contiene 8 casos que cubren los seis modos más dos tests de disciplina (`handles-crash-gracefully`, `ambiguous-goal-must-clarify`). Cada caso tiene:

- `prompt` — la instrucción dada al agente
- `files` — fixtures a colocar en el directorio de trabajo
- `expectations` — assertions verificables programáticamente

Ruta recomendada: usar el skill `skill-creator`. Lanza dos subagentes por caso (con-skill vs baseline), recoge los artefactos, ejecuta las assertions y produce un `benchmark.json` y un visor HTML.

Todas las fixtures son autocontenidas y rápidas (`toy_repo/run.py` usa `time.sleep(0.5)`; `toy_regression/setup.sh` siembra un repo nuevo en cada llamada; `toy_pipeline/pipeline.py` es scoring puramente sintético).

---

## Cuándo **no** usarlo

- Tareas puntuales que terminan en minutos — bastan una conversación normal.
- Objetivos que no se pueden reducir a un solo número o una sola pregunta respondible — piénsalo primero.
- Cada paso necesita luz verde humana — eso es pair programming, no investigación autónoma.

El valor está en **volumen × disciplina**: diez experimentos baratos corridos al mismo estándar valen más que una afirmación ingeniosa sin verificar. Sin experimentos baratos *y* un estándar comparable, la disciplina gira en vacío.
