import { describe, expect, test } from "bun:test"
import {
  envGitHubToken,
  mapPullsResponse,
  noBranch,
  notGitHub,
  parseGitHubRepo,
  requestError,
} from "../../src/project/github-repo"

describe("parseGitHubRepo", () => {
  test("parses ssh remote", () => {
    expect(parseGitHubRepo("git@github.com:AAAclc/2027RC.git")).toEqual({ owner: "AAAclc", repo: "2027RC" })
  })

  test("parses ssh remote without .git", () => {
    expect(parseGitHubRepo("git@github.com:XiaomiMiMo/MiMo-Code")).toEqual({
      owner: "XiaomiMiMo",
      repo: "MiMo-Code",
    })
  })

  test("parses https remote", () => {
    expect(parseGitHubRepo("https://github.com/XiaomiMiMo/MiMo-Code.git")).toEqual({
      owner: "XiaomiMiMo",
      repo: "MiMo-Code",
    })
  })

  test("parses https remote with credentials host", () => {
    expect(parseGitHubRepo("https://token@github.com/naecoo/MiMo-Code.git")).toEqual({
      owner: "naecoo",
      repo: "MiMo-Code",
    })
  })

  test("parses ssh:// remote", () => {
    expect(parseGitHubRepo("ssh://git@github.com/AAAclc/2027RC.git")).toEqual({
      owner: "AAAclc",
      repo: "2027RC",
    })
  })

  test("parses git protocol remote", () => {
    expect(parseGitHubRepo("git://github.com/XiaomiMiMo/MiMo-Code.git")).toEqual({
      owner: "XiaomiMiMo",
      repo: "MiMo-Code",
    })
  })

  test("rejects non-github remotes", () => {
    expect(parseGitHubRepo("git@gitlab.com:group/project.git")).toBeUndefined()
    expect(parseGitHubRepo("https://gitlab.com/group/project.git")).toBeUndefined()
    expect(parseGitHubRepo(undefined)).toBeUndefined()
    expect(parseGitHubRepo("")).toBeUndefined()
  })
})

describe("envGitHubToken", () => {
  test("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    expect(envGitHubToken({ GITHUB_TOKEN: "from-github", GH_TOKEN: "from-gh" })).toBe("from-github")
  })

  test("falls back to GH_TOKEN", () => {
    expect(envGitHubToken({ GH_TOKEN: "from-gh" })).toBe("from-gh")
  })

  test("ignores blank tokens", () => {
    expect(envGitHubToken({ GITHUB_TOKEN: "  ", GH_TOKEN: "" })).toBeUndefined()
  })
})

describe("mapPullsResponse", () => {
  const base = {
    authenticated: true,
    owner: "AAAclc",
    repo: "2027RC",
    branch: "main",
  }

  test("maps empty 200 to none", () => {
    const result = mapPullsResponse({ ...base, status: 200, body: [] })
    expect(result.status).toBe("none")
    expect(result.authenticated).toBe(true)
    expect(result.message).toBe("当前分支暂无拉取请求")
  })

  test("maps 200 with pull to ok", () => {
    const result = mapPullsResponse({
      ...base,
      status: 200,
      body: [
        {
          number: 42,
          state: "open",
          title: "fix: private repo pr status",
          html_url: "https://github.com/AAAclc/2027RC/pull/42",
          merged_at: null,
        },
      ],
    })
    expect(result.status).toBe("ok")
    expect(result.pull).toEqual({
      number: 42,
      state: "open",
      title: "fix: private repo pr status",
      url: "https://github.com/AAAclc/2027RC/pull/42",
    })
  })

  test("maps merged pull state", () => {
    const result = mapPullsResponse({
      ...base,
      status: 200,
      body: [{ number: 7, state: "closed", title: "merged", html_url: "u", merged_at: "2026-01-01T00:00:00Z" }],
    })
    expect(result.status).toBe("ok")
    expect(result.pull?.state).toBe("merged")
  })

  test("maps unauthenticated 404 to unauthorized with login hint", () => {
    const result = mapPullsResponse({ ...base, authenticated: false, status: 404, body: { message: "Not Found" } })
    expect(result.status).toBe("unauthorized")
    expect(result.message).toBe("需要登录 GitHub 才能查看私有仓库 PR")
  })

  test("maps authenticated 404 to unauthorized with access hint", () => {
    const result = mapPullsResponse({ ...base, status: 404, body: { message: "Not Found" } })
    expect(result.status).toBe("unauthorized")
    expect(result.message).toBe("仓库不存在，或当前凭证无权访问")
  })

  test("maps 401 to unauthorized", () => {
    const result = mapPullsResponse({ ...base, status: 401, body: { message: "Bad credentials" } })
    expect(result.status).toBe("unauthorized")
  })

  test("maps 403 and 429 to rate_limited", () => {
    expect(mapPullsResponse({ ...base, status: 403, body: {} }).status).toBe("rate_limited")
    expect(mapPullsResponse({ ...base, status: 429, body: {} }).status).toBe("rate_limited")
  })

  test("maps unexpected status to error", () => {
    const result = mapPullsResponse({ ...base, status: 500, body: {} })
    expect(result.status).toBe("error")
  })
})

describe("status helpers", () => {
  test("notGitHub", () => {
    expect(notGitHub("main")).toMatchObject({ status: "not_github", branch: "main", authenticated: false })
  })

  test("noBranch", () => {
    expect(noBranch()).toMatchObject({ status: "no_branch", authenticated: false })
  })

  test("requestError", () => {
    expect(requestError(true)).toMatchObject({ status: "error", authenticated: true })
    expect(requestError(false).message).toBe("无法获取拉取请求状态")
  })
})
