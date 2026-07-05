---
name: html-to-video-pipeline
description: Reliable HTML-to-MP4 rendering via headless browser recording (Playwright/Puppeteer) + ffmpeg — the ordering, gotchas, and verification steps you MUST get right or the output silently rots. Trigger whenever the user is building or debugging any pipeline that turns an HTML/CSS/JS page (single-file, multi-composition, GSAP-driven, or `@keyframes`-driven) into a video file, including headless recording, screen capture of a web page, deterministic frame-by-frame capture, multi-scene concatenation, or engine-mixed video output. Also trigger when the symptom sounds like: font swap flashing in the opening frames (FOUT), the first few seconds of the video are frozen/dead, animations play during page load and get truncated, concatenated segments produce a video whose duration is wildly wrong (e.g., 8s becomes 35s), `file://` loaded HTML fails to fetch its sub-scenes, the exported video is soft/blurry compared to the browser, or playback stutters/looks choppy despite passing a high `-r` fps to ffmpeg. Use even for one-off scripts — the failure modes here are subtle enough that starting from scratch usually reintroduces them.
---

# HTML → Video: the pipeline that actually works

Turning a live HTML page into an MP4 sounds like a one-liner ("Playwright records, ffmpeg encodes") and the first draft always looks fine — until you play back the export and notice text flashing in a fallback font, three dead seconds at the start, or a "10-second" clip that clocks in at 35s. This skill captures the specific ordering, waits, and encoder flags that make the output trustworthy.

Think of the pipeline as five phases with a single invariant between them:

```
launch  →  hold @ frame 0  →  align capture start with animation start  →  record  →  trim & encode
```

The invariant: **no pixel of the animation should render before capture is ready, AND capture must not start before every asset that affects layout has loaded.** Every gotcha below is a violation of that invariant.

Quick checklist (each item is expanded below):

1. `viewport` must exactly equal `recordVideo.size` — mismatch silently rescales the output soft/blurry.
2. Freeze CSS animations via `addInitScript` **before** `goto()`.
3. `goto` with `domcontentloaded`, never `load`.
4. Pre-inline `data-composition-src` sub-scenes — `file://` blocks client-side `fetch`.
5. Font wait = stylesheet `<link>` load → `face.load()` per face → `fonts.ready` → 2 rAFs.
6. Probe duration with infinite-iteration / `repeat: -1` guards.
7. Unfreeze = t=0; trim `leadInMs − 120ms` with `-ss` *before* `-i`.
8. Concat: same engine → demuxer `-c copy`; mixed engines → concat *filter* + re-encode.
9. Verify with ffprobe duration + full decode + sampled frames. Always.

There are two capture modes, and picking the wrong one wastes a day:

- **Mode A — real-time `recordVideo`** (the phases below). Simple, wall-clock = clip length. But the screencast is best-effort variable frame rate (~25fps) and competes with the animation for CPU. Good enough for previews and ≤30fps deliverables on an idle machine.
- **Mode B — deterministic frame stepping** (pause everything, seek to `i / fps`, screenshot, encode the PNG sequence). Exact fps, every frame rendered, no lead-in trim, immune to machine load. Required when the output must be genuinely smooth ≥30fps or renders run on loaded CI. See "Deterministic frame stepping" below.

## Prerequisites — install these first

Two hard requirements: a headless browser driver (Playwright or Puppeteer) and `ffmpeg`. Everything below assumes both are installed and on `PATH`.

### 1. Headless browser driver

Playwright is the default in this skill (its `recordVideo` API is what the pipeline is written against). Puppeteer works too but you'll wire recording yourself via CDP screencast — pick Playwright unless you have a reason not to.

```bash
# Playwright (recommended) — npm / pnpm / bun all work
npm  install playwright
pnpm add playwright
bun  add playwright

# Then install the actual browser binaries (this is the step people forget):
npx playwright install chromium              # just Chromium — enough for this pipeline
npx playwright install --with-deps chromium  # Linux/CI: also install shared libs
```

Verify: `npx playwright --version` prints the driver version, and `node -e "require('playwright').chromium.launch().then(b => b.close())"` exits cleanly.

Puppeteer alternative (only if you already have it in the project):

```bash
npm install puppeteer            # bundles a matching Chromium automatically
# or, to reuse a system Chrome:
npm install puppeteer-core       # no bundled browser — you supply executablePath
```

### 2. ffmpeg

The encode/trim/concat/verify steps all shell out to `ffmpeg` (and `ffprobe`, which ships in the same package). It is **not** an npm dependency — install it at the OS level.

```bash
# macOS
brew install ffmpeg

# Debian / Ubuntu
sudo apt-get update && sudo apt-get install -y ffmpeg

# Fedora / RHEL
sudo dnf install ffmpeg          # requires RPM Fusion enabled

# Windows
winget install Gyan.FFmpeg       # or: choco install ffmpeg
```

Verify: `ffmpeg -version` and `ffprobe -version` both print. If a script spawns `ffmpeg` and gets `ENOENT`, the binary isn't on `PATH` — see the graceful-failure snippet in `references/ffmpeg-cheatsheet.md`.

Do **not** rely on the `ffmpeg-static` / `@ffmpeg-installer/ffmpeg` npm packages for production: their bundled builds skip codecs and encoder flags you'll hit sooner or later (e.g. `libx264` presets, `tpad`). A system ffmpeg is the durable choice.

### 3. Optional — ImageMagick (verification only)

Only needed if you want the "did anything render?" pixel-mean check from Phase 6. Skip it otherwise.

```bash
brew install imagemagick         # macOS
sudo apt-get install imagemagick # Debian/Ubuntu
```

Verify: `magick -version` (ImageMagick 7) or `convert -version` (ImageMagick 6).

## The pipeline

### Phase 1 — Launch and prepare the recorder

Use `playwright.chromium.launch({ headless: true })` and a context configured with `recordVideo: { dir, size: { width, height } }`. Two sizing rules:

- **`viewport` must exactly equal `recordVideo.size`.** When they differ, Playwright rescales the screencast to fit the recording size and the whole output goes soft. Derive both from the same constants.
- `recordVideo` captures at CSS-pixel resolution; `deviceScaleFactor` does **not** raise recording resolution. For a 1080p export use a 1920×1080 viewport, not 960×540 @ 2x.

Recording begins the instant the context exists — treat that timestamp as the WebM's t=0 and remember it (`tWebmStart = Date.now()`); you will need it in Phase 5 to trim the dead opening.

Know the recorder's ceiling: the screencast runs at a variable ~25fps and drops frames under CPU load. The `-r <fps>` flag in Phase 5 makes the container constant-frame-rate but only duplicates frames — it cannot add smoothness. If stutter matters, switch to frame stepping (Mode B) instead of fighting this.

### Phase 2 — Freeze animations BEFORE the page parses

This is the single most-missed step. Pure-CSS `@keyframes` animations begin the moment the element is styled — there is no JS trigger to hold. If you `goto()` the HTML and then start waiting for fonts (which takes seconds), the CSS timeline has *already been running the whole time*. The recording captures the fallback font swapping to the real face mid-clip, and the opening beats of the animation are lost to the font wait.

Fix: inject a global freeze **via `page.addInitScript()`**, which runs before any of the document's own scripts and before CSS is applied, so the timeline is paused at frame 0 the moment it exists:

```js
await page.addInitScript(() => {
  const style = document.createElement('style');
  style.id = '__freeze';
  style.textContent =
    '*, *::before, *::after { animation-play-state: paused !important;' +
    ' -webkit-animation-play-state: paused !important; }';
  const attach = () => (document.head || document.documentElement).appendChild(style);
  if (document.head || document.documentElement) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
  window.__unfreeze = () => document.getElementById('__freeze')?.remove();
});
```

This does not stop GSAP tweens driven by JS (see Phase 4 for those) — for GSAP-driven templates, register the master timeline paused and expose a `window.__playAll()` you call in Phase 4.

### Phase 3 — Load with `domcontentloaded`, not `load`

`waitUntil: 'load'` blocks on every external asset, including cross-origin videos with no CORS headers. Chromium will retry those for ~4s before giving up, and those 4s get burned into the recording as a frozen first scene. Use `waitUntil: 'domcontentloaded'` — the DOM + synchronous inline scripts (GSAP, your player) are ready, and you handle fonts explicitly next.

If the template is multi-composition (scenes loaded via `data-composition-src` and client-side `fetch`), you must **pre-inline** those sub-files into the entry HTML on the Node side and write it to a sibling `.tmp.html`. Chromium blocks `file://` fetch, so client-side scene loaders that work in a browser tab will silently produce an empty shell in a headless recording. See `references/multi-composition.md`.

### Phase 4 — Wait for fonts properly, then release

`document.fonts.ready` alone is **not enough** and this is the second most-missed step. Under `domcontentloaded`, the Google Fonts (or any external) `<link rel="stylesheet">` has usually not returned yet. Until its CSS arrives, its `@font-face` rules are not in `document.fonts` at all — so `fonts.ready` sees an empty set and resolves *instantly*. Recording proceeds, the CSS lands mid-clip, faces download, and the swap happens on-camera.

The correct sequence, all inside a `page.evaluate()` with an 8s hard cap so a wedged CDN can't stall forever:

1. Wait for every `<link rel="stylesheet">` to `load` or `error` — that registers `@font-face` rules into `document.fonts`.
2. For each registered face, call `face.load()` explicitly. `font-display: swap` defers the download until something paints with that face — if your first frame doesn't happen to use the face, it never fetches without this.
3. `await fonts.ready`.
4. Two rAFs so layout settles on the real glyph metrics before frame 0.

Then, and only then:

5. Drive playback: for GSAP multi-composition templates, call `window.__playAll()` to start every registered (paused) master timeline from 0. For pure-CSS templates, this is a no-op.
6. Call `window.__unfreeze()` to remove the freeze style. **This is the true t=0 of the animation.** Record the wall-clock offset from `tWebmStart` (`leadInMs = Date.now() - tWebmStart`) — this is what you trim in Phase 5.

The full JS for Phase 4 is in `references/font-wait.md`.

### Phase 5 — Probe duration, record, then trim and encode

**Probe duration first** (skip this only if you know the exact intended length). The user's requested `duration` may be shorter than the animation, in which case you'd cut the animation mid-play. Take the maximum of:

- The longest **non-infinite** CSS animation (`animation-duration + animation-delay` for entries where `animation-iteration-count !== 'infinite'`).
- The longest **finite** GSAP tween. Do **not** use `gsap.globalTimeline.totalDuration()` — a `repeat: -1` tween (blinking cursor, looping background) makes it ~1e10s. Walk `globalTimeline.getChildren(true, true, true)` and skip anything with `repeat() === -1`.

Add a ~400ms settle so the last animation frame is captured, cap at 30s so a stray huge value can't run away. If your caller passed an *explicit* per-frame duration (e.g. "each scene is exactly 4s"), do **not** extend — treat it as a hard cap and pad the tail if the animation finished early (see below). If duration was 'auto', extend to the probed length.

**Record** for `totalDuration`, then `context.close()`. Playwright drops the WebM in `recordDir`.

**Encode with ffmpeg**, applying two corrections:

```
ffmpeg -y \
  [ -ss <(leadInMs - 120) / 1000> ]  # trim dead lead-in, back off 120ms so we don't clip frame 1
  -i input.webm \
  [ -vf tpad=stop_mode=clone:stop_duration=<totalDuration> ]  # pad tail only when duration is explicit
  -t <totalDuration> \                # trim to exact length (recordVideo sometimes overshoots)
  -r <fps> \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart \
  out.mp4
```

The `-ss` back-off matters: recorder start jitter and rounding can steal the first real frame if you trim to exactly `leadInMs`. A couple of extra still frames at the head are invisible; a missing opening beat is obvious.

## Deterministic frame stepping (Mode B)

When the deliverable must be genuinely smooth at an exact fps — or the render runs on a loaded CI box where real-time capture visibly stutters — don't record in real time at all. Keep Phases 1–4 (minus `recordVideo`), then: pause every timeline, seek to `i / fps`, `page.screenshot()` each frame, and encode the PNG sequence with `ffmpeg -framerate <fps>`. Duration is exact by construction, there is no lead-in to trim, and every single frame is fully rendered regardless of machine load.

It works when the page's motion is declaratively seekable — CSS `@keyframes` (via `document.getAnimations()` + `currentTime`), WAAPI, and GSAP (`gsap.globalTimeline.time(t)`). It does **not** work for `<video>` elements, `setTimeout`-choreographed scenes, or rAF-driven physics; those need real-time recording or a CDP virtual clock. Step time monotonically forward, never backwards.

Full loop, the seek/suppressEvents subtleties, the "animations created later by JS are invisible to the seek" trap, and optional 2x supersampling are in `references/frame-stepping.md`.

## Multi-segment concatenation

When you have N per-scene MP4s and need one output, the correct ffmpeg strategy depends on whether the inputs share a codec/timebase.

**Same encoder, same params (typical: all scenes rendered by the same adapter)** — use `concat` demuxer with stream copy. Fast, lossless:

```
ffmpeg -y -f concat -safe 0 -i list.txt -c copy out.mp4
```

where `list.txt` is `file 'seg1.mp4'\nfile 'seg2.mp4'\n...`.

**Mixed sources (e.g. scene A recorded by headless Chromium, scene B rendered by a React/Remotion pipeline)** — the concat demuxer's `-c copy` path assumes compatible timebases and PTS. When timebases differ, PTS accumulate incorrectly and an 8-second output can become 35 seconds. **Even `-vsync cfr` won't save you** — the bad PTS have already been fed in. You must re-encode via the concat **filter**, which rebuilds the timeline:

```
ffmpeg -y -i seg1.mp4 -i seg2.mp4 -i seg3.mp4 \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -pix_fmt yuv420p -r 60 \
  -movflags +faststart out.mp4
```

Decision rule in code: pass a `reencode: boolean` down to your concat helper. Set it to `true` whenever any segment came from a different rendering engine than the others, or when you're not sure.

## Verify — always

You cannot trust "the file was written" as success. The failure modes above (wrong duration, FOUT, dead lead-in) all produce a playable MP4. Before declaring success:

- `ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4` — actual duration matches expected within ~50ms?
- `ffmpeg -v error -i out.mp4 -f null -` — full decode, no errors? A "silently corrupted" output from a bad concat will decode fine but be the wrong length; conversely, a broken concat demuxer output can throw here.
- Sample a frame near t=0.1s and t=0.5s (`ffmpeg -ss 0.1 -i out.mp4 -frames:v 1 -y f1.png`) — text renders in the intended font? If your test rig has ImageMagick, `magick f1.png -threshold 50% -format '%[fx:100*mean]' info:` gives a rough non-background pixel percentage that catches "recording is completely blank" regressions.

For fonts specifically: **studio-style live iframe previews will not reproduce FOUT** because the browser tab caches faces. Only cold-headless rendering (i.e. the actual export path) reproduces it. Verify on the exported MP4, not the preview.

## When to depart from this template

- **Non-animated single-frame PNG export.** Skip Phases 2, 4-5-recording; goto → `fonts.ready` → `page.screenshot()` is enough. FOUT still applies for the screenshot.
- **You own the animation timeline in JS end-to-end** (e.g. Motion Canvas / Remotion generator style). The freeze/unfreeze dance is unnecessary because *you* drive frame-by-frame rendering — use the framework's own frame API and skip Playwright recording entirely. The concat rules still apply if you're mixing engines.
- **Interactive-page capture** (recording a real user session). Duration probing is meaningless; use manual start/stop signals and skip lead-in trim.

## Reference files

- `references/font-wait.md` — full JS for the Phase 4 font-wait routine, with per-link timeout and rAF-based settle.
- `references/frame-stepping.md` — the Mode B deterministic capture loop: seek-per-frame, screenshot, PNG-sequence encode, supersampling, and its limits.
- `references/multi-composition.md` — inlining `data-composition-src` scenes for `file://` recording, including re-executing cloned `<script>` nodes.
- `references/duration-probe.md` — CSS + GSAP probe with the infinite-iteration guards.
- `references/ffmpeg-cheatsheet.md` — the encode/concat/verify commands in one place.
