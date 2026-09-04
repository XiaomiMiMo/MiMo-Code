---
name: mate
description: "Create custom desktop pet (Mate) characters with spritesheet and manifest. Use when the user asks to 'create a pet', 'make a desktop companion', 'design a mate character', 'generate a spritesheet for my pet', or wants to customize their desktop buddy. Generates a WebP spritesheet + manifest.json that can be loaded by MiMo Desktop's Mate system."
---

# Mate Pet Creator

Create animated desktop pet characters for MiMo Desktop's Mate (桌面伙伴) system.

## Output Structure

A valid custom pet lives in a folder with this structure:

```
<pet-id>/
├── manifest.json     # Required — animation metadata
└── spritesheet.webp  # Required — all animation frames in a grid
```

The user places this folder in their MiMo Desktop custom pets directory (`userData/pets/<pet-id>/`), then clicks "Refresh" in Settings → Mate to load it.

## Manifest Schema

```json
{
  "id": "my-pet",
  "name": "My Pet",
  "description": "A cute custom pet",
  "version": 1,
  "spritesheet": "spritesheet.webp",
  "frameWidth": 240,
  "frameHeight": 240,
  "columns": 8,
  "totalFrames": 16,
  "animations": {
    "idle": { "row": 0, "frames": 8, "fps": 8, "loop": true }
  }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (kebab-case) |
| `name` | string | Display name |
| `version` | number | Always `1` |
| `spritesheet` | string | Filename of the spritesheet image |
| `frameWidth` | number | Width of each frame in pixels |
| `frameHeight` | number | Height of each frame in pixels |
| `columns` | number | Number of columns in the spritesheet grid |
| `totalFrames` | number | Total number of frames across all animations |
| `animations` | object | At minimum must include `idle` |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Shown in settings UI |
| `anchorX` | number | Horizontal anchor (0–1, default 0.5) for centering |

### Animation Definition

Each animation entry:

| Field | Type | Description |
|-------|------|-------------|
| `row` | number | Row index in the spritesheet (0-based) |
| `frames` | number | Number of frames in this animation |
| `fps` | number | Playback speed (recommended: 6–12) |
| `loop` | boolean | Whether the animation loops |

The `idle` animation is **required** — it plays by default when the pet is loaded.

## Spritesheet Layout

- Frames are arranged left-to-right, top-to-bottom in a grid.
- Each row corresponds to one animation (matched by the `row` field in the animation definition).
- All frames must have identical dimensions (`frameWidth × frameHeight`).
- Transparent background (alpha channel) is required — the pet window has no background.
- Recommended frame size: 240×240 px (renders well at 1× scale on desktop).
- Format: WebP with transparency (lossless or near-lossless for crisp pixel art).

## Workflow

### Step 1: Understand the Character

Ask the user:
- What animal/creature/character?
- Art style preference (pixel art, cartoon, flat vector, kawaii)?
- Any specific colors or features?

### Step 2: Generate the Spritesheet

Use the `imagegen` skill to generate the spritesheet image. Construct the prompt with these guidelines:
- Request a **sprite sheet** with specific grid layout (e.g., "8 frames in a single horizontal row, each frame 240×240 pixels")
- Specify **transparent background** (alpha channel)
- Describe the **idle animation** motion: gentle breathing, blinking, tail wag, bobbing, etc.
- Keep the character **centered** in each frame with consistent sizing
- Style: match the user's preference; default to cute/kawaii if unspecified

If the generated image is already WebP, use it directly. If it is PNG or another format, convert to WebP:

```bash
# Convert to lossless WebP preserving transparency
cwebp -lossless -q 100 spritesheet.png -o spritesheet.webp
```

If `cwebp` is not available, check for `sips` (macOS Ventura+ supports WebP export):

```bash
sips -s format webp spritesheet.png --out spritesheet.webp
```

If neither tool is available, instruct the user to install one:

```
brew install webp   # provides cwebp
```

Do NOT silently rename a PNG to .webp — the file must have valid WebP encoding (RIFF/WEBP header). If conversion genuinely cannot be performed, fail explicitly and tell the user what tool to install.

If `imagegen` is unavailable (skill not enabled or image generation fails), fall back to generating pixel-art frames directly as SVG, then rasterize. Compute dimensions from the manifest:

```bash
# Calculate actual spritesheet dimensions from manifest
WIDTH=$((frameWidth * columns))
HEIGHT=$((frameHeight * rows))  # rows = max animation row index + 1

# Rasterize SVG to PNG, then convert to WebP
rsvg-convert -w $WIDTH -h $HEIGHT spritesheet.svg -o spritesheet.png
cwebp -lossless spritesheet.png -o spritesheet.webp
```

As a last resort, output the SVG file directly and instruct the user to convert it manually.

### Step 3: Write the Manifest

Generate `manifest.json` with correct dimensions matching the actual spritesheet output. Verify:
- `frameWidth × columns` = spritesheet total width
- `frameHeight × (max animation row index + 1)` = spritesheet total height
- `animations.idle` exists with valid `row`, `frames`, `fps`, `loop`
- Each animation's `frames` ≤ `columns` (frames per row cannot exceed grid columns)

### Step 4: Deliver

Write both files to the current working directory under a folder named with the pet ID. Tell the user to:
1. Copy the folder to their MiMo Desktop pets directory (Settings → Mate → click "Open Folder" to find it)
2. Click "Refresh" in Settings → Mate
3. Select their new pet from the list

## Constraints

- The `idle` animation MUST exist — the system falls back to it.
- Frame dimensions must be consistent across the entire spritesheet.
- Keep total file size under 2MB for smooth loading.
- Pet ID must be unique; if it conflicts with a preset (`koala`, `panda`), the preset wins.
- Do NOT reference or depend on any external URLs — all assets must be local files.
