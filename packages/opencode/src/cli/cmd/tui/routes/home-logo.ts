import { logos, type LogoKey } from "@/cli/logo"

export function resolveHomeLogoKey(value: unknown): LogoKey {
  if (typeof value === "string" && value in logos) return value as LogoKey
  return "classic"
}

export function homeLogoShape(value: unknown) {
  return logos[resolveHomeLogoKey(value)]
}
