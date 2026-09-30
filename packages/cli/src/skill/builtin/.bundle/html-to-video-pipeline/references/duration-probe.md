# Duration probe — CSS + GSAP

Run this inside `page.evaluate()` after fonts are ready but before you start the recording clock. It returns the length in milliseconds that the animation actually needs. Take the maximum of this and the caller's requested duration (when `duration === 'auto'`); treat as a hard cap when the caller specified an explicit length.

```js
const animMs = await page.evaluate(() => {
  let maxMs = 0;

  // ---- CSS @keyframes ----
  // Walk every element and inspect computed animation-duration + delay.
  // Skip entries whose iteration-count is infinite (looping background anims).
  Array.from(document.querySelectorAll('*')).forEach((el) => {
    const s = getComputedStyle(el);
    const durs = (s.animationDuration || '').split(',');
    const dels = (s.animationDelay || '').split(',');
    const iters = (s.animationIterationCount || '').split(',');
    durs.forEach((d, i) => {
      if ((iters[i] || '').trim() === 'infinite') return;
      const total = ((parseFloat(d) || 0) + (parseFloat(dels[i] || '0') || 0)) * 1000;
      if (total > maxMs) maxMs = total;
    });
  });

  // ---- GSAP timelines ----
  // Do NOT use gsap.globalTimeline.totalDuration() — a single repeat: -1 tween
  // makes it ~1e10s. Walk the children and take the longest finite tween.
  const g = window.gsap;
  let gsapMs = 0;
  const children = g?.globalTimeline?.getChildren?.(true, true, true) ?? [];
  for (const c of children) {
    const repeat = typeof c.repeat === 'function' ? c.repeat() : (c.vars?.repeat ?? 0);
    if (repeat === -1) continue; // infinite loop — ignore
    const td = typeof c.totalDuration === 'function' ? c.totalDuration() : 0;
    if (Number.isFinite(td)) gsapMs = Math.max(gsapMs, td * 1000);
  }

  return Math.max(maxMs, gsapMs);
});

// +400ms settle so the final animation frame is captured; cap at 30s so a
// stray huge value can't stretch a frame arbitrarily.
const needed = Math.min(30, (animMs + 400) / 1000);
```

## Why the infinite-guard matters

Every real template has *something* that loops — a caret blinking, a background gradient sweeping, a subtle "breathing" scale on an accent. Any of these in a naive probe blows the number up. Two common failure shapes:

- **CSS: `animation-iteration-count: infinite`** — `animation-duration` might be 1.2s (one blink cycle). Multiplied out mentally, this is one second. In the probe it's just 1200ms. Fine on its own — but if you *don't* skip it and instead do something like `Math.max(duration, 1e9)` accidentally somewhere, you get a 30-year clip. The guard is: check `iteration-count === 'infinite'` and skip.
- **GSAP: `repeat: -1`** — `tween.totalDuration()` returns `Infinity` (or a huge finite number depending on GSAP version). `gsap.globalTimeline.totalDuration()` propagates that. Skip via `child.repeat() === -1`.

## When to extend vs when to cap

Two callers, two policies:

- **Single-frame preview / "auto" duration** — the caller doesn't know how long the animation is; extend to `max(requested, probed)`. Better an extra second of a still hold than a truncated ending.
- **Multi-frame export with explicit per-scene length** — each scene is contractually N seconds. Do **not** extend; that would push the total off and desync any audio. Instead, if the probed length is shorter than N, pad the tail in the encoder with `-vf tpad=stop_mode=clone:stop_duration=N`, so the last frame holds until N. If the probed length is longer than N, that's a template bug — surface a warning; do not silently clip.

Distinguish with a flag on the render config, e.g. `durationMode: 'auto' | 'explicit'`.

## What if the template has no discoverable animation?

The probe returns 0 and you fall back to the caller's requested duration. That's the right behavior — a static HTML page has no "natural" length. If the caller also passed 'auto', pick a sane default (5s in this codebase's convention).
