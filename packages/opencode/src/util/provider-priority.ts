const HEAD_POPULAR_PROVIDERS = ["openai", "anthropic"] as const

const CHINA_POPULAR_PROVIDERS = [
  "deepseek",
  "zai",
  "zhipuai",
  "moonshotai",
  "moonshotai-cn",
  "kimi-for-coding",
  "stepfun",
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

const WESTERN_POPULAR_PROVIDERS = ["opencode", "opencode-go", "github-copilot", "google"] as const

const EXTRA_POPULAR_PROVIDERS = ["openrouter", "vercel"] as const

export const PROVIDER_PRIORITY: Record<string, number> = Object.fromEntries([
  ...HEAD_POPULAR_PROVIDERS.map((id, index) => [id, index]),
  ...CHINA_POPULAR_PROVIDERS.map((id, index) => [id, HEAD_POPULAR_PROVIDERS.length + index]),
  ...WESTERN_POPULAR_PROVIDERS.map((id, index) => [
    id,
    HEAD_POPULAR_PROVIDERS.length + CHINA_POPULAR_PROVIDERS.length + index,
  ]),
  ...EXTRA_POPULAR_PROVIDERS.map((id, index) => [
    id,
    HEAD_POPULAR_PROVIDERS.length + CHINA_POPULAR_PROVIDERS.length + WESTERN_POPULAR_PROVIDERS.length + index,
  ]),
])

export function isPopularProvider(id: string) {
  return id in PROVIDER_PRIORITY
}
