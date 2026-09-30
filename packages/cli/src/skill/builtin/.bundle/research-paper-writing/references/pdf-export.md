# Converting the Paper to PDF

Route by source format, compile, then always verify the output PDF before reporting success.

## LaTeX project → PDF

### 1. Pick the engine

| Situation | Engine |
|---|---|
| Standard venue template (CVPR/ICCV/NeurIPS/ICLR/ACL) | `pdflatex` — templates assume it; do not switch engines |
| Paper contains CJK text, or needs system fonts (`fontspec`) | `xelatex` (or `lualatex`) |
| Unsure | Check the template's comments / `% !TEX program =` line; default to `pdflatex` |

### 2. Compile with latexmk (preferred)

`latexmk` handles the multi-pass dance (LaTeX → bibliography → LaTeX ×2) automatically:

```bash
latexmk -pdf main.tex                 # pdflatex engine
latexmk -xelatex main.tex             # xelatex engine
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex   # CI / unattended
```

If `latexmk` is unavailable, run the passes manually:

```bash
pdflatex main.tex
bibtex main          # or: biber main  (check \usepackage[backend=...]{biblatex})
pdflatex main.tex
pdflatex main.tex    # second pass resolves cross-references
```

Use `bibtex` when the paper loads `natbib` / plain `\bibliography{...}`; use `biber` only when `biblatex` with `backend=biber` is declared.

### 3. Find the main file

The entry point is the `.tex` file containing `\documentclass`:

```bash
grep -l "\\\\documentclass" *.tex
```

Always compile from the directory containing the main file so relative `\input`, figure, and `.bib` paths resolve.

### 4. Common failures

| Symptom | Fix |
|---|---|
| `! LaTeX Error: File 'xxx.sty' not found` | `tlmgr install xxx` (TeX Live) or install the package via the distro's manager. Tell the user which package was missing. |
| `Undefined control sequence` | Usually a missing `\usepackage` or an engine mismatch (e.g. `fontspec` under pdflatex). |
| Citations show as `[?]` / refs as `??` | Bibliography pass didn't run or failed — rerun the full sequence; check the `.blg` log for bad `.bib` entries. |
| Compile hangs waiting for input | Add `-interaction=nonstopmode`; then read the `.log` for the first `!` error. |
| Stale/corrupt aux state after fixing errors | `latexmk -C` to clean, then recompile. |
| No TeX installed | macOS: `brew install --cask mactex-no-gui` (large) or `basictex` + `tlmgr` per-package. Linux: `apt install texlive-latex-extra texlive-fonts-recommended`. Or offer the pandoc/Typst route below. |

Never "fix" a compile error by deleting content, commenting out `\cite`/`\ref`, or removing packages the paper uses — find the root cause or report it.

## Markdown / plain-text draft → PDF

Use pandoc when the draft is `.md`:

```bash
pandoc draft.md -o draft.pdf --pdf-engine=xelatex \
  -V geometry:margin=1in -V fontsize=11pt
```

- CJK content: add `-V CJKmainfont="Songti SC"` (macOS) or another installed CJK font.
- Citations in the draft (`[@key]` + `.bib`): add `--citeproc --bibliography=refs.bib`.
- No TeX installed and installing is not an option: `pandoc draft.md -o draft.html` then print to PDF via headless Chrome (`chrome --headless --print-to-pdf=draft.pdf draft.html`), and say the typography is approximate.

This route is for previews and internal drafts. For an actual submission, the paper must be compiled from the venue's LaTeX template — offer to set that up instead of shipping a pandoc PDF.

## Verify before reporting success

A zero exit code is not enough. Check:

1. **PDF exists and opens** — e.g. `pdfinfo main.pdf` (page count sane, not 0 bytes).
2. **No unresolved references** — `grep -c "??"` on extracted text, or grep the `.log` for `LaTeX Warning: Reference .* undefined` and `Citation .* undefined`. Report the exact undefined keys.
3. **Page limit** — compare page count against the venue limit if known; flag overflow.
4. **Camera-ready extras** (only when the user says camera-ready): fonts embedded (`pdffonts main.pdf` — every row should say "yes" under emb), and file size within the venue's cap.

Report the result as: output path, page count, and any warnings that need the user's attention (undefined refs, overfull hboxes worth fixing, page overflow).
