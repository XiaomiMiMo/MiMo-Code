# ffmpeg cheatsheet for HTML→video pipelines

All commands assume ffmpeg is on PATH. If it's not, install with `brew install ffmpeg` (macOS) or your platform equivalent.

## WebM → MP4 (single-scene encode)

Playwright's `recordVideo` writes a WebM. Convert it to a broadly-compatible MP4, trimming the dead lead-in (page load + font wait) and forcing an exact duration.

```
ffmpeg -y \
  -ss <leadInSec> \
  -i input.webm \
  -t <totalDurationSec> \
  -r <fps> \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart \
  out.mp4
```

- `-ss` **before `-i`** = fast input seek (drops the frozen lead-in entirely, doesn't re-encode it just to throw it away).
- `-t` = trim to exact length. `recordVideo` sometimes overshoots by however long `context.close()` takes.
- Trim back the seek by ~120ms (i.e. seek to `leadInMs - 120`) so recorder start jitter can't clip the first real animation frame. A couple of extra still frames at the head are invisible; a missing opening beat is obvious.
- `crf 20` is a good default: visibly indistinguishable from source, ~half the size of `crf 18`. Drop to `18` for archive-quality masters; raise to `23` for aggressive size.
- `+faststart` moves the moov atom to the front so the MP4 begins playing without a full download (matters for CDN delivery).

## Explicit-duration variant (multi-scene export)

When each scene must be *exactly* N seconds and the animation might have finished early, hold the last frame to fill:

```
ffmpeg -y \
  -ss <leadInSec> \
  -i input.webm \
  -vf tpad=stop_mode=clone:stop_duration=<N> \
  -t <N> \
  -r <fps> \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart \
  out.mp4
```

The `tpad` filter clones the final frame; `-t` then trims to the precise length.

## PNG sequence → MP4 (frame-stepping mode)

For Mode B captures (see `frame-stepping.md`), where each frame was screenshotted deterministically:

```
ffmpeg -y -framerate <fps> -i frames/f%05d.png \
  -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 \
  -movflags +faststart out.mp4
```

- `-framerate` must come **before** `-i` (it's an input option). An image sequence carries no timestamps; this option defines them. Output duration is exactly `frames / fps` — no `-ss` trim, no `-t` cap needed.
- Frame names must be zero-padded and contiguous (`f00000.png`, `f00001.png`, …); a gap makes ffmpeg stop early without error.
- If frames were captured at 2x (`deviceScaleFactor: 2` supersampling), add `-vf scale=1920:1080:flags=lanczos` to downscale with crisp text.

## Concat: same encoder (fast, lossless)

All segments came from the same rendering pipeline with matching codec/params. Use the concat demuxer with `-c copy` — this doesn't re-encode, it just concatenates the packet streams:

```
# list.txt:
#   file '/abs/path/seg1.mp4'
#   file '/abs/path/seg2.mp4'
#   file '/abs/path/seg3.mp4'

ffmpeg -y -f concat -safe 0 -i list.txt -c copy out.mp4
```

- `-safe 0` allows absolute paths in `list.txt`.
- Escape single quotes in filenames as `'\''` inside the list file.

## Concat: mixed sources (re-encode via filter)

Segments came from *different* rendering engines (e.g. Playwright-recorded scenes A + C, framework-rendered scene B). Timebase and PTS conventions differ across the sources. **The concat demuxer + `-c copy` will corrupt the timeline** — an 8-second output can silently become 35 seconds because PTS accumulate incorrectly. Even `-vsync cfr` won't save it; the bad PTS are already in the stream.

Use the concat **filter**, which rebuilds the timeline from scratch. This re-encodes, so it's slower and slightly lossy, but the duration is precise:

```
ffmpeg -y \
  -i seg1.mp4 -i seg2.mp4 -i seg3.mp4 \
  -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" \
  -map "[v]" \
  -c:v libx264 -pix_fmt yuv420p -r <fps> \
  -movflags +faststart \
  out.mp4
```

- `n=3` = number of inputs. If you generate this dynamically: `[0:v][1:v]...[N-1:v]concat=n=N:v=1:a=0[v]`.
- `v=1:a=0` = one video stream out, zero audio streams. If your segments have audio, use `v=1:a=1` and pair each input as `[0:v][0:a][1:v][1:a]...`.
- If you're not sure whether sources match, use this variant. The cost is one re-encode; the alternative is a silently corrupted output.

## Verification (always run at least the first two)

```
# Actual duration — must match expected within ~50ms.
ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4

# Full decode, no errors. A concat corruption often decodes fine but has the
# wrong length; a broken stream copy can throw here.
ffmpeg -v error -i out.mp4 -f null -

# Streams / codecs / resolution / fps.
ffprobe -v error -show_streams -of default=noprint_wrappers=1 out.mp4

# Sample frames to eyeball the opening (font correctness) and a mid-clip beat.
ffmpeg -ss 0.1 -i out.mp4 -frames:v 1 -y frame_early.png
ffmpeg -ss 0.5 -i out.mp4 -frames:v 1 -y frame_mid.png
```

If you have ImageMagick, this is a cheap "did anything render?" check:

```
# Rough non-background pixel percentage — 0% ≈ blank, 20%+ ≈ real content.
magick frame_early.png -threshold 50% -format '%[fx:100*mean]' info:
```

## Handling missing ffmpeg gracefully

Spawn detection is easier than checking with `which`:

```js
proc.on('error', (err) => {
  if (err.code === 'ENOENT') {
    throw new Error('ffmpeg not found on PATH. Install with `brew install ffmpeg` (macOS).');
  }
  throw err;
});
```

The `ENOENT` from `child_process.spawn` fires when the binary itself is missing, which is the only interesting distinction for a user-facing hint.
