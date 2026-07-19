# Mode B — Deterministic frame stepping

Alternative to Playwright's `recordVideo`: pause every timeline, seek to `i / fps`, screenshot each frame, encode the PNG sequence. Use it when real-time capture can't deliver.

## Choosing stepping over real-time recording

|                                      | Mode A: real-time `recordVideo`         | Mode B: frame stepping                    |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| Smoothness                           | variable ~25fps, drops frames under load | exact fps, every frame fully rendered     |
| Duration accuracy                    | `-ss` trim + `-t`, ±1 frame              | exact by construction (`frames / fps`)    |
| Wall-clock cost                      | = clip length                            | ~2–10 captured fps; slower for long clips |
| `<video>` / timers / rAF physics     | works                                    | does NOT work (needs virtual clock)       |
| Lead-in trim needed                  | yes (Phase 5)                            | no                                        |
| Sensitive to machine load            | yes — stutter bakes into the file        | no                                        |

Phases 1–4 of the main pipeline still apply, with two changes: drop `recordVideo` from the context options, and never call `window.__unfreeze()` — the freeze style stays on for the whole capture (a paused animation still renders when you set its `currentTime`).

## The loop

```js
const fps = 30;
const totalFrames = Math.ceil(durationS * fps); // durationS from the duration probe

// After the Phase 4 font wait: pin every seekable timeline at 0.
await page.evaluate(() => {
  document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; });
  window.gsap?.globalTimeline.pause().time(0, true);
});

for (let i = 0; i < totalFrames; i++) {
  const tMs = (i / fps) * 1000;
  await page.evaluate((t) => {
    document.getAnimations().forEach((a) => { a.currentTime = t; });
    // suppressEvents=false: we only ever step forward, so DOM-mutating
    // onStart/onComplete callbacks fire exactly as they would in playback.
    window.gsap?.globalTimeline.time(t / 1000, false);
  }, tMs);
  await page.screenshot({ path: join(framesDir, `f${String(i).padStart(5, '0')}.png`) });
}
```

Then encode (also in `ffmpeg-cheatsheet.md`):

```
ffmpeg -y -framerate <fps> -i frames/f%05d.png \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart out.mp4
```

`-framerate` must come **before** `-i` — an image sequence carries no timestamps, this option defines them.

## Gotchas

- **Animations created later by JS are invisible to the seek.** `document.getAnimations()` returns what exists *now*. If a script adds a class or spawns tweens at t=3s via `setTimeout`, the seek loop never touches them and those scenes render frozen. Sanity-check that `getAnimations().length` (plus GSAP children) covers what you expect; if the page choreographs with timers, fall back to Mode A or a virtual clock.
- **Step monotonically forward, never backwards.** With `suppressEvents=false`, scrubbing backwards re-fires callbacks and can corrupt DOM state that a callback already mutated. If you must re-render a frame, reload the page and step forward again.
- **GSAP `suppressEvents`.** `time(t, true)` skips callbacks between the old and new time — fine for the initial pin at 0, wrong for the capture loop when timelines use `onStart`/`onComplete` to mutate the DOM. Pass `false` while stepping.
- **Infinite animations are fine.** Setting `currentTime` past one cycle of an `infinite` CSS animation resolves modulo the cycle — no guard needed here (the guards matter in the duration probe, not the seek).
- **Do not pass `animations: 'disabled'` to `page.screenshot()`.** That Playwright option fast-forwards/rewinds animations and would fight the seek. Leave it at the default.
- **Throughput.** `page.screenshot()` round-trips the protocol at roughly 50–200ms/frame at 1080p — a 10s @ 30fps clip is ~300 frames ≈ 1–2 minutes. Acceptable for exports; budget for it in CI timeouts.

## Optional: 2x supersampling for crisper text

Real-time recording is stuck at CSS-pixel resolution, but screenshots honor `deviceScaleFactor`. Launch the context with `deviceScaleFactor: 2` (viewport still 1920×1080 → 3840×2160 PNGs) and downscale at encode time:

```
ffmpeg -y -framerate <fps> -i frames/f%05d.png \
  -vf scale=1920:1080:flags=lanczos \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart out.mp4
```

Noticeably sharper glyph edges and hairline strokes; ~4x the screenshot time. Reserve it for final masters.

## Advanced: virtual clock for timer-driven pages

If the page choreographs scenes with `setTimeout`/`requestAnimationFrame`/`Date.now()`, the seek loop can't reach that logic. CDP's `Emulation.setVirtualTimePolicy` can pause virtual time and grant it in per-frame budgets, making timers deterministic:

```js
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
// per frame: grant exactly one frame of time, then screenshot
await cdp.send('Emulation.setVirtualTimePolicy', {
  policy: 'pauseIfNetworkFetchesPending',
  budget: 1000 / fps,
});
```

This is heavyweight and interacts badly with in-flight network fetches — only reach for it when the template genuinely can't be expressed as seekable timelines, and verify the output frame-by-frame.
