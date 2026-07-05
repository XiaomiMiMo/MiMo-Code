# Phase 4 — Font-wait routine

This is the full `page.evaluate()` body for waiting until all display fonts have loaded and painted. Copy verbatim; the ordering is load-bearing.

```js
await page.evaluate(() => new Promise((resolve) => {
  const doc = document;
  const fonts = doc.fonts;
  if (!fonts || typeof fonts.ready?.then !== 'function') { resolve(); return; }

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    // One more frame so the relayout on the real face is painted.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  };
  // Hard cap: a blocked CDN must never stall the render.
  const cap = setTimeout(finish, 8000);

  // 1. Wait for stylesheet <link>s to load — this registers @font-face rules
  //    into document.fonts. Without this step, fonts.ready sees an empty set
  //    and resolves instantly.
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const linkDone = links.map((link) => {
    // An already-loaded sheet exposes cssRules without throwing.
    try { if (link.sheet && link.sheet.cssRules) return Promise.resolve(); }
    catch { /* not ready yet — fall through to event wait */ }
    return new Promise((r) => {
      const done = () => r();
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
      // Per-link safety so one wedged link can't hold the batch.
      setTimeout(done, 6000);
    });
  });

  Promise.all(linkDone)
    .then(() => {
      // 2. Force every registered face to actually download. Under `display: swap`
      //    the browser defers the fetch until something paints with the face —
      //    off-screen or pre-animation text may not have triggered that yet.
      const loads = [];
      fonts.forEach((face) => {
        try { loads.push(face.load().catch(() => undefined)); }
        catch { /* some faces reject load() pre-paint — ignore */ }
      });
      return Promise.all(loads);
    })
    // 3. Now ready() reflects the real face set.
    .then(() => fonts.ready)
    .then(() => { clearTimeout(cap); finish(); })
    .catch(() => { clearTimeout(cap); finish(); });
})).catch(() => {});
```

## Why each step is there

1. **Wait for stylesheet `<link>`s** — under `waitUntil: 'domcontentloaded'`, `<link rel="stylesheet">` requests are still in flight. Their `@font-face` rules only enter `document.fonts` after the sheet loads. `fonts.ready` on an empty set resolves immediately, which is the bug.
2. **`face.load()` per face** — `font-display: swap` (Google Fonts' default) tells the browser to paint fallback immediately and defer the real face fetch until it's needed. If your first frame has no text in that face (e.g. an intro card that fades in), the face never downloads and the swap happens later, on camera.
3. **`fonts.ready`** — resolves when every currently pending face has settled (loaded or errored).
4. **Two rAFs** — layout may relayout on the real glyph metrics; give the browser one frame to paint, and one more to be safe.

## Failure modes this prevents

- Text renders in system font for the first N frames, then snaps to the intended face (FOUT visible in export).
- Layout shifts a few pixels between frames as the real face's advance widths take effect.
- A `<link>` that fails to load blocks the recording forever (per-link 6s cap + overall 8s cap).
