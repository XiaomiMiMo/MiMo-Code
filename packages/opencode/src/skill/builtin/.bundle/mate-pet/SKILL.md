---
name: mate-pet
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

Use the **image generation** tool (invoke the `image-gen` skill or use any available image generation capability) to create the spritesheet.

Prompt construction guidelines for the image generator:
- Request a **sprite sheet** with specific grid layout (e.g., "8 frames in a row, 240×240 each")
- Specify **transparent background**
- Describe the **idle animation** motion: gentle breathing, blinking, tail wag, etc.
- Keep the character **centered** in each frame with consistent sizing
- Style: match the user's preference; default to cute/kawaii if unspecified

If image generation is unavailable, create the spritesheet using SVG-to-WebP conversion:
1. Generate an SVG with all animation frames arranged in the grid layout
2. Use a script to convert the SVG to WebP format

### Step 3: Write the Manifest

Generate `manifest.json` with correct dimensions matching the actual spritesheet output.

### Step 4: Deliver

Write both files to the current working directory under a folder named with the pet ID. Tell the user to:
1. Copy the folder to their MiMo Desktop pets directory
2. Open Settings → Mate → click Refresh
3. Select their new pet from the list

## Constraints

- The `idle` animation MUST exist — the system falls back to it.
- Frame dimensions must be consistent across the entire spritesheet.
- Keep total file size under 2MB for smooth loading.
- Pet ID must be unique; if it conflicts with a preset (`koala`, `panda`), the preset wins.
- Do NOT reference or depend on any external URLs — all assets must be local files.
