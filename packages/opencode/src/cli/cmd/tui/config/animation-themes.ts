import type { RGBA } from "@opentui/core"

export type AnimationTheme = {
  name: string
  description: string
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  particles: boolean
  transitions: boolean
  effects: boolean
  intensity: "low" | "medium" | "high"
}

export const animationThemes: Record<string, AnimationTheme> = {
  minimal: {
    name: "Minimal",
    description: "Clean and simple animations",
    primary: RGBA.fromInts(100, 100, 100),
    secondary: RGBA.fromInts(150, 150, 150),
    accent: RGBA.fromInts(200, 200, 200),
    particles: false,
    transitions: true,
    effects: false,
    intensity: "low",
  },
  subtle: {
    name: "Subtle",
    description: "Gentle animations with minimal distraction",
    primary: RGBA.fromInts(100, 150, 200),
    secondary: RGBA.fromInts(150, 180, 210),
    accent: RGBA.fromInts(200, 220, 240),
    particles: false,
    transitions: true,
    effects: true,
    intensity: "low",
  },
  balanced: {
    name: "Balanced",
    description: "Moderate animations for a pleasant experience",
    primary: RGBA.fromInts(100, 180, 255),
    secondary: RGBA.fromInts(150, 200, 255),
    accent: RGBA.fromInts(200, 230, 255),
    particles: true,
    transitions: true,
    effects: true,
    intensity: "medium",
  },
  vibrant: {
    name: "Vibrant",
    description: "Energetic animations with more visual flair",
    primary: RGBA.fromInts(255, 100, 100),
    secondary: RGBA.fromInts(100, 255, 100),
    accent: RGBA.fromInts(100, 100, 255),
    particles: true,
    transitions: true,
    effects: true,
    intensity: "high",
  },
  cyberpunk: {
    name: "Cyberpunk",
    description: "Futuristic neon-inspired animations",
    primary: RGBA.fromInts(0, 255, 255),
    secondary: RGBA.fromInts(255, 0, 255),
    accent: RGBA.fromInts(255, 255, 0),
    particles: true,
    transitions: true,
    effects: true,
    intensity: "high",
  },
  nature: {
    name: "Nature",
    description: "Organic, flowing animations",
    primary: RGBA.fromInts(34, 139, 34),
    secondary: RGBA.fromInts(107, 142, 35),
    accent: RGBA.fromInts(255, 215, 0),
    particles: true,
    transitions: true,
    effects: true,
    intensity: "medium",
  },
}

export function getAnimationTheme(name: string): AnimationTheme {
  return animationThemes[name] ?? animationThemes.balanced
}

export function getAnimationThemes(): AnimationTheme[] {
  return Object.values(animationThemes)
}

export function getThemeNames(): string[] {
  return Object.keys(animationThemes)
}
