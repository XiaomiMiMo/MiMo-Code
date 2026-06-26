import type { Component } from "solid-js"
import { StarryBackground } from "./starry-background"
import { MatrixBackground } from "./matrix-bg"
import { WavesBackground } from "./waves-bg"
import { FireBg, SnowBg, RainBg, AuroraBg, PlasmaBg, BubblesBg, ConfettiBg, RippleBg, PulseBg, DriftBg, TwinkleBg } from "./bg-effects"

export type BgEntry = {
  value: string
  i18nKey: string
  component: Component
}

export const BUILTIN_BGS: BgEntry[] = [
  { value: "__bg_starry__", i18nKey: "tui.dialog.image.starry", component: () => <StarryBackground /> },
  { value: "__bg_matrix__", i18nKey: "tui.dialog.image.matrix", component: MatrixBackground },
  { value: "__bg_waves__", i18nKey: "tui.dialog.image.waves", component: WavesBackground },
  { value: "__bg_fire__", i18nKey: "tui.dialog.image.fire", component: FireBg },
  { value: "__bg_snow__", i18nKey: "tui.dialog.image.snow", component: SnowBg },
  { value: "__bg_rain__", i18nKey: "tui.dialog.image.rain", component: RainBg },
  { value: "__bg_aurora__", i18nKey: "tui.dialog.image.aurora", component: AuroraBg },
  { value: "__bg_plasma__", i18nKey: "tui.dialog.image.plasma", component: PlasmaBg },
  { value: "__bg_bubbles__", i18nKey: "tui.dialog.image.bubbles", component: BubblesBg },
  { value: "__bg_confetti__", i18nKey: "tui.dialog.image.confetti", component: ConfettiBg },
  { value: "__bg_ripple__", i18nKey: "tui.dialog.image.ripple", component: RippleBg },
  { value: "__bg_pulse__", i18nKey: "tui.dialog.image.pulse", component: PulseBg },
  { value: "__bg_drift__", i18nKey: "tui.dialog.image.drift", component: DriftBg },
  { value: "__bg_twinkle__", i18nKey: "tui.dialog.image.twinkle", component: TwinkleBg },
]

export const BGS_BY_VALUE = Object.fromEntries(BUILTIN_BGS.map((b) => [b.value, b]))
export const EFFECT_VALUES = new Set(BUILTIN_BGS.map((b) => b.value))
