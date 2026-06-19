const HEAD_POPULAR_PROVIDERS = ["openai", "anthropic"] as const

const CHINA_POPULAR_BEFORE_ALIBABA = [
  "deepseek",
  "zai",
  "zhipuai",
  "moonshotai",
  "moonshotai-cn",
  "kimi-for-coding",
  "stepfun",
] as const

const MID_POPULAR_PROVIDERS = ["opencode", "openrouter"] as const

const CHINA_POPULAR_FROM_ALIBABA = [
  "alibaba",
  "alibaba-cn",
  "bytedance",
  "alibaba-coding-plan",
  "alibaba-coding-plan-cn",
  "zai-coding-plan",
  "zhipuai-coding-plan",
  "tencent-coding-plan",
  "minimax-coding-plan",
  "minimax-cn-coding-plan",
  "kuae-cloud-coding-plan",
] as const

const TAIL_POPULAR_PROVIDERS = ["opencode-go", "github-copilot", "google", "vercel"] as const

const POPULAR_PROVIDER_GROUPS = [
  HEAD_POPULAR_PROVIDERS,
  CHINA_POPULAR_BEFORE_ALIBABA,
  MID_POPULAR_PROVIDERS,
  CHINA_POPULAR_FROM_ALIBABA,
  TAIL_POPULAR_PROVIDERS,
] as const

export const PROVIDER_PRIORITY: Record<string, number> = Object.fromEntries(
  POPULAR_PROVIDER_GROUPS.flatMap((group, groupIndex, groups) => {
    const offset = groups.slice(0, groupIndex).reduce((sum, g) => sum + g.length, 0)
    return group.map((id, index) => [id, offset + index])
  }),
)

export function isPopularProvider(id: string) {
  return id in PROVIDER_PRIORITY
}
