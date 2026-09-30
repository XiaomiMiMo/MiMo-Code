export type GitHubRepo = {
  readonly owner: string
  readonly repo: string
}

export type GitHubPull = {
  readonly number: number
  readonly state: string
  readonly title?: string
  readonly url?: string
}

export type PullRequestStatus =
  | "ok"
  | "none"
  | "unauthorized"
  | "not_github"
  | "rate_limited"
  | "no_branch"
  | "error"

export type PullRequest = {
  readonly status: PullRequestStatus
  readonly authenticated: boolean
  readonly owner?: string
  readonly repo?: string
  readonly branch?: string
  readonly pull?: GitHubPull
  readonly message?: string
}

export function parseGitHubRepo(remote: string | undefined): GitHubRepo | undefined {
  if (!remote) return
  const value = remote.trim()
  if (!value) return

  const ssh = value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: stripGitSuffix(ssh[2]) }

  const git = value.match(/^git:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i)
  if (git?.[1] && git[2]) return { owner: git[1], repo: stripGitSuffix(git[2]) }

  const https = value.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i)
  if (https?.[1] && https[2]) return { owner: https[1], repo: stripGitSuffix(https[2]) }

  return
}

function stripGitSuffix(repo: string) {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo
}

export function envGitHubToken(env: Record<string, string | undefined>): string | undefined {
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  return token || undefined
}

type PullsItem = {
  number?: unknown
  state?: unknown
  title?: unknown
  html_url?: unknown
  merged_at?: unknown
}

export function mapPullsResponse(input: {
  status: number
  body: unknown
  authenticated: boolean
  owner: string
  repo: string
  branch: string
}): PullRequest {
  const base = {
    authenticated: input.authenticated,
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
  } as const

  if (input.status === 401) {
    return {
      ...base,
      status: "unauthorized",
      message: "GitHub 凭证无效或已过期",
    }
  }

  if (input.status === 403 || input.status === 429) {
    return {
      ...base,
      status: "rate_limited",
      message: "GitHub API 访问受限或触发限流",
    }
  }

  if (input.status === 404) {
    return {
      ...base,
      status: "unauthorized",
      message: input.authenticated
        ? "仓库不存在，或当前凭证无权访问"
        : "需要登录 GitHub 才能查看私有仓库 PR",
    }
  }

  if (input.status !== 200) {
    return {
      ...base,
      status: "error",
      message: `GitHub API 返回状态 ${input.status}`,
    }
  }

  const list = Array.isArray(input.body) ? (input.body as PullsItem[]) : []
  const first = list[0]
  if (!first || typeof first.number !== "number") {
    return {
      ...base,
      status: "none",
      message: "当前分支暂无拉取请求",
    }
  }

  const state =
    first.merged_at != null ? "merged" : typeof first.state === "string" ? first.state : "unknown"

  return {
    ...base,
    status: "ok",
    pull: {
      number: first.number,
      state,
      title: typeof first.title === "string" ? first.title : undefined,
      url: typeof first.html_url === "string" ? first.html_url : undefined,
    },
  }
}

export function notGitHub(branch: string | undefined): PullRequest {
  return {
    status: "not_github",
    authenticated: false,
    branch,
    message: "当前仓库不是 GitHub 远程仓库",
  }
}

export function noBranch(): PullRequest {
  return {
    status: "no_branch",
    authenticated: false,
    message: "当前不在 git 分支上",
  }
}

export function requestError(authenticated: boolean, message = "无法获取拉取请求状态"): PullRequest {
  return {
    status: "error",
    authenticated,
    message,
  }
}
