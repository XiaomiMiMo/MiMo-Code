# Multi-composition templates over `file://`

Some HTML templates are split into an entry file that pulls in sub-scenes at runtime via a placeholder pattern:

```html
<div data-composition-src="compositions/intro.html"></div>
<div data-composition-src="compositions/main.html"></div>
```

The entry's client-side player then `fetch()`es each sub-file and injects it. This works fine when the page is served over HTTP, but **Chromium blocks `fetch()` on `file://` URLs** — so the exact same page loaded over `file://` (as it is for a headless render) produces an empty shell where the scenes should be. The recording captures nothing.

## Fix: inline every sub-scene on the Node side, then load

Before `page.goto()`, read the entry HTML from disk, resolve every `data-composition-src` reference, inline them into a `window.__COMPOSITIONS__` map, and inject a small player that mounts each placeholder from that map. Write the result to a sibling `.tmp.html` so any relative asset paths in the compositions still resolve.

```js
async function prepareSourceHtml(sourcePath) {
  const raw = await readFile(sourcePath, 'utf8');
  const srcMatches = Array.from(raw.matchAll(/data-composition-src=["']([^"']+)["']/g));
  if (srcMatches.length === 0) return { loadPath: sourcePath }; // single-file: no-op

  const srcDir = dirname(sourcePath);
  const compMap = {};
  for (const m of srcMatches) {
    const rel = m[1];
    if (compMap[rel] !== undefined) continue;
    const p = join(srcDir, rel);
    if (existsSync(p)) compMap[rel] = await readFile(p, 'utf8');
  }
  if (Object.keys(compMap).length === 0) return { loadPath: sourcePath };

  // Escape `</` (and comment openers) so the JSON survives inside <script>.
  // Composition files contain their own </script> tags.
  const safeJson = JSON.stringify(compMap).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

  const head = `<script>window.__timelines=window.__timelines||{};` +
               `window.__COMPOSITIONS__=${safeJson};</script>`;
  let out = /<head[^>]*>/i.test(raw)
    ? raw.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`)
    : `${head}\n${raw}`;

  out = out.replace('</body>', `${PLAYER}\n</body>`);

  const loadPath = join(srcDir, `.tmp-${Date.now()}.html`);
  await writeFile(loadPath, out, 'utf8');
  return { loadPath, cleanup: () => rm(loadPath, { force: true }) };
}
```

## The player: re-executing cloned `<script>`

The player mounts each composition into its host div, then **re-executes its `<script>` tags**. This step is easy to miss: cloned `<script>` nodes never run on their own. You must create a fresh `<script>` element and copy the text content into it.

```html
<script>
(function () {
  function reexec(root) {
    root.querySelectorAll('script').forEach((old) => {
      if (old.src) { old.parentNode.removeChild(old); return; }
      const s = document.createElement('script');
      // Wrap each composition's inline script in a block so top-level
      // `const tl = …` locals don't collide across scenes; the
      // window.__timelines assignments still escape the block.
      s.textContent = '{\n' + old.textContent + '\n}';
      old.parentNode.replaceChild(s, old);
    });
  }
  function mountOne(host) {
    const src = host.getAttribute('data-composition-src');
    const text = (window.__COMPOSITIONS__ || {})[src];
    if (!text) return;
    const holder = document.createElement('div');
    holder.innerHTML = text;
    const tpl = holder.querySelector('template');
    host.appendChild(tpl ? tpl.content.cloneNode(true) : holder);
    reexec(host);
  }
  window.__playAll = function () {
    const tls = window.__timelines || {};
    Object.keys(tls).forEach((k) => {
      const tl = tls[k];
      if (tl && typeof tl.play === 'function') tl.play(0);
    });
  };
  function boot() {
    document.querySelectorAll('[data-composition-src]').forEach(mountOne);
    // Composition <script>s register their (paused) timelines synchronously as
    // they're injected, so they're on window.__timelines now. Leave paused —
    // the renderer probes their duration first, then calls __playAll() at the
    // exact moment recording starts so playback and capture are aligned. Fall
    // back to auto-play if no driver calls it (e.g. standalone browser view).
    setTimeout(() => { if (!window.__played) window.__playAll(); }, 250);
  }
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();
})();
</script>
```

## Two subtle bits

- **Wrap each composition's inline script in `{ … }`** — this scopes any top-level `const`/`let` so scenes can share variable names (`const tl = gsap.timeline()`) without collision. Assignments to `window.__timelines[…]` still escape the block.
- **`<template>` wrapper is optional** — some compositions ship as raw markup, some wrap it in `<template>...</template>` to prevent premature execution when opened standalone. Handle both by cloning `template.content` when present, else appending the holder div directly.

## Do NOT force `repeat(-1)` on the master timelines

It's tempting to loop everything so "the animation is always playing when we look." Don't. Composition timelines are usually finite, scene-by-scene narratives — looping them replays the intro over the outro, and worse, breaks duration probing: an infinite-repeat tween registers as `~1e10s` in `gsap.globalTimeline.totalDuration()`, which the duration probe correctly skips as "infinite background anim" — so a looped master timeline reads as **0s** and the whole clip gets truncated to whatever the default is (usually 5s).

Leave timelines finite. If a template needs a looping background element (blinking cursor, ambient particles), that specific tween can carry `repeat: -1` — the probe already ignores those.
