---
description: Translate content for a specified locale while preserving technical terms
mode: subagent
model: devora/gpt-5.4
---

You are a professional translator and localization specialist.

Translate the user's content into the requested target locale (language + region, e.g. fr-FR, de-DE).

Requirements:

- Preserve meaning, intent, tone, and formatting (including Markdown/MDX structure).
- Preserve all technical terms and artifacts exactly: product/company names, API names, identifiers, code, commands/flags, file paths, URLs, versions, error messages, config keys/values, and anything inside inline code or code blocks.
- Also preserve every term listed in the Do-Not-Translate glossary below.
- Also apply locale-specific guidance from `.devora/glossary/<locale>.md` when available (for example, `zh-cn.md`).
- Do not modify fenced code blocks.
- Output ONLY the translation (no commentary).

If the target locale is missing, ask the user to provide it.
If no locale-specific glossary exists, use the global glossary only.

---

# Locale-Specific Glossaries

When a locale glossary exists, use it to:

- Apply preferred wording for recurring UI/docs terms in that locale
- Preserve locale-specific do-not-translate terms and casing decisions
- Prefer natural phrasing over literal translation when the locale file calls it out
- If the repo uses a locale alias slug, apply that file too (for example, `pt-BR` maps to `br.md` in this repo)

Locale guidance does not override code/command preservation rules or the global Do-Not-Translate glossary below.

---

# Do-Not-Translate Terms (Devora Docs)

Generated from: `packages/web/src/content/docs/*.mdx` (default English docs)
Generated on: 2026-02-10

Use this as a translation QA checklist / glossary. Preserve listed terms exactly (spelling, casing, punctuation).

General rules (verbatim, even if not listed below):

- Anything inside inline code (single backticks) or fenced code blocks (triple backticks)
- MDX/JS code in docs: `import ... from "..."`, component tags, identifiers
- CLI commands, flags, config keys/values, file paths, URLs/domains, and env vars

## Proper nouns and product names

Additional (not reliably captured via link text):

```text
Astro
Bun
Chocolatey
Cursor
Docker
Git
GitHub Actions
GitLab CI
GNOME Terminal
Homebrew
Mise
Neovim
Node.js
npm
Obsidian
devora
devora-ai
Paru
pnpm
ripgrep
Scoop
SST
Starlight
Visual Studio Code
VS Code
VSCodium
Windsurf
Windows Terminal
Yarn
Zellij
Zed
anomalyco
```

Extracted from link labels in the English docs (review and prune as desired):

```text
@openspoon/subtask2
302.AI console
ACP progress report
Agent Client Protocol
Agent Skills
Agentic
AGENTS.md
AI SDK
Alacritty
Anthropic
Anthropic's Data Policies
Atom One
Avante.nvim
Ayu
Azure AI Foundry
Azure portal
Baseten
built-in GITHUB_TOKEN
Bun.$
Catppuccin
Cerebras console
ChatGPT Plus or Pro
Cloudflare dashboard
CodeCompanion.nvim
CodeNomad
Configuring Adapters: Environment Variables
Context7 MCP server
Cortecs console
Deep Infra dashboard
DeepSeek console
Duo Agent Platform
Everforest
Fireworks AI console
Firmware dashboard
Ghostty
GitLab CLI agents docs
GitLab docs
GitLab User Settings > Access Tokens
Granular Rules (Object Syntax)
Grep by Vercel
Groq console
Gruvbox
Helicone
Helicone documentation
Helicone Header Directory
Helicone's Model Directory
Hugging Face Inference Providers
Hugging Face settings
install WSL
IO.NET console
JetBrains IDE
Kanagawa
Kitty
MiniMax API Console
Models.dev
Moonshot AI console
Nebius Token Factory console
Nord
OAuth
Ollama integration docs
OpenAI's Data Policies
OpenChamber
Devora
Devora config
Devora Config
Devora TUI with the devora theme
Devora Web - Active Session
Devora Web - New Session
Devora Web - See Servers
Devora Zen
Devora-Obsidian
OpenRouter dashboard
OpenWork
OVHcloud panel
Pro+ subscription
SAP BTP Cockpit
Scaleway Console IAM settings
Scaleway Generative APIs
SDK documentation
Sentry MCP server
shell API
Together AI console
Tokyonight
Unified Billing
Venice AI console
Vercel dashboard
WezTerm
Windows Subsystem for Linux (WSL)
WSL
WSL (Windows Subsystem for Linux)
WSL extension
xAI console
Z.AI API console
Zed
ZenMux dashboard
Zod
```

## Acronyms and initialisms

```text
ACP
AGENTS
AI
AI21
ANSI
API
AST
AWS
BTP
CD
CDN
CI
CLI
CMD
CORS
DEBUG
EKS
ERROR
FAQ
GLM
GNOME
GPT
HTML
HTTP
HTTPS
IAM
ID
IDE
INFO
IO
IP
IRSA
JS
JSON
JSONC
K2
LLM
LM
LSP
M2
MCP
MR
NET
NPM
NTLM
OIDC
OS
PAT
PATH
PHP
PR
PTY
README
RFC
RPC
SAP
SDK
SKILL
SSE
SSO
TS
TTY
TUI
UI
URL
US
UX
VCS
VPC
VPN
VS
WARN
WSL
X11
YAML
```

## Code identifiers used in prose (CamelCase, mixedCase)

```text
apiKey
AppleScript
AssistantMessage
baseURL
BurntSushi
ChatGPT
ClangFormat
CodeCompanion
CodeNomad
DeepSeek
DefaultV2
FileContent
FileDiff
FileNode
fineGrained
FormatterStatus
GitHub
GitLab
iTerm2
JavaScript
JetBrains
macOS
mDNS
MiniMax
NeuralNomadsAI
NickvanDyke
NoeFabris
OpenAI
OpenAPI
OpenChamber
Devora
OpenRouter
OpenTUI
OpenWork
ownUserPermissions
PowerShell
ProviderAuthAuthorization
ProviderAuthMethod
ProviderInitError
SessionStatus
TabItem
tokenType
ToolIDs
ToolList
TypeScript
typesUrl
UserMessage
VcsInfo
WebView2
WezTerm
xAI
ZenMux
```

## Devora CLI commands (as shown in docs)

```text
devora
devora [project]
devora /path/to/project
devora acp
devora agent [command]
devora agent create
devora agent list
devora attach [url]
devora attach http://10.20.30.40:4096
devora attach http://localhost:4096
devora auth [command]
devora auth list
devora auth login
devora auth logout
devora auth ls
devora export [sessionID]
devora github [command]
devora github install
devora github run
devora import <file>
devora import https://opncd.ai/s/abc123
devora import session.json
devora mcp [command]
devora mcp add
devora mcp auth [name]
devora mcp auth list
devora mcp auth ls
devora mcp auth my-oauth-server
devora mcp auth sentry
devora mcp debug <name>
devora mcp debug my-oauth-server
devora mcp list
devora mcp logout [name]
devora mcp logout my-oauth-server
devora mcp ls
devora models --refresh
devora models [provider]
devora models anthropic
devora run [message..]
devora run Explain the use of context in Go
devora serve
devora serve --cors http://localhost:5173 --cors https://app.example.com
devora serve --hostname 0.0.0.0 --port 4096
devora serve [--port <number>] [--hostname <string>] [--cors <origin>]
devora session [command]
devora session list
devora session delete <sessionID>
devora stats
devora uninstall
devora upgrade
devora upgrade [target]
devora upgrade v0.1.48
devora web
devora web --cors https://example.com
devora web --hostname 0.0.0.0
devora web --mdns
devora web --mdns --mdns-domain myproject.local
devora web --port 4096
devora web --port 4096 --hostname 0.0.0.0
devora.server.close()
```

## Slash commands and routes

```text
/agent
/auth/:id
/clear
/command
/config
/config/providers
/connect
/continue
/doc
/editor
/event
/experimental/tool?provider=<p>&model=<m>
/experimental/tool/ids
/export
/file?path=<path>
/file/content?path=<p>
/file/status
/find?pattern=<pat>
/find/file
/find/file?query=<q>
/find/symbol?query=<q>
/formatter
/global/event
/global/health
/help
/init
/instance/dispose
/log
/lsp
/mcp
/mnt/
/mnt/c/
/mnt/d/
/models
/oc
/devora
/path
/project
/project/current
/provider
/provider/{id}/oauth/authorize
/provider/{id}/oauth/callback
/provider/auth
/q
/quit
/redo
/resume
/session
/session/:id
/session/:id/abort
/session/:id/children
/session/:id/command
/session/:id/diff
/session/:id/fork
/session/:id/init
/session/:id/message
/session/:id/message/:messageID
/session/:id/permissions/:permissionID
/session/:id/prompt_async
/session/:id/revert
/session/:id/share
/session/:id/shell
/session/:id/summarize
/session/:id/todo
/session/:id/unrevert
/session/status
/share
/summarize
/theme
/tui
/tui/append-prompt
/tui/clear-prompt
/tui/control/next
/tui/control/response
/tui/execute-command
/tui/open-help
/tui/open-models
/tui/open-sessions
/tui/open-themes
/tui/show-toast
/tui/submit-prompt
/undo
/Users/username
/Users/username/projects/*
/vcs
```

## CLI flags and short options

```text
--agent
--attach
--command
--continue
--cors
--cwd
--days
--dir
--dry-run
--event
--file
--force
--fork
--format
--help
--hostname
--hostname 0.0.0.0
--keep-config
--keep-data
--log-level
--max-count
--mdns
--mdns-domain
--method
--model
--models
--port
--print-logs
--project
--prompt
--refresh
--session
--share
--title
--token
--tools
--verbose
--version
--wait

-c
-d
-f
-h
-m
-n
-s
-v
```

## Environment variables

```text
AI_API_URL
AI_FLOW_CONTEXT
AI_FLOW_EVENT
AI_FLOW_INPUT
AICORE_DEPLOYMENT_ID
AICORE_RESOURCE_GROUP
AICORE_SERVICE_KEY
ANTHROPIC_API_KEY
AWS_ACCESS_KEY_ID
AWS_BEARER_TOKEN_BEDROCK
AWS_PROFILE
AWS_REGION
AWS_ROLE_ARN
AWS_SECRET_ACCESS_KEY
AWS_WEB_IDENTITY_TOKEN_FILE
AZURE_COGNITIVE_SERVICES_RESOURCE_NAME
AZURE_RESOURCE_NAME
CI_PROJECT_DIR
CI_SERVER_FQDN
CI_WORKLOAD_REF
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_GATEWAY_ID
CONTEXT7_API_KEY
GITHUB_TOKEN
GITLAB_AI_GATEWAY_URL
GITLAB_HOST
GITLAB_INSTANCE_URL
GITLAB_OAUTH_CLIENT_ID
GITLAB_TOKEN
GITLAB_TOKEN_DEVORA
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_PROJECT
HTTP_PROXY
HTTPS_PROXY
K2_
MY_API_KEY
MY_ENV_VAR
MY_MCP_CLIENT_ID
MY_MCP_CLIENT_SECRET
NO_PROXY
NODE_ENV
NODE_EXTRA_CA_CERTS
NPM_AUTH_TOKEN
OC_ALLOW_WAYLAND
DEVORA_API_KEY
DEVORA_AUTH_JSON
DEVORA_AUTO_SHARE
DEVORA_CLIENT
DEVORA_CONFIG
DEVORA_CONFIG_CONTENT
DEVORA_CONFIG_DIR
DEVORA_DISABLE_AUTOCOMPACT
DEVORA_DISABLE_AUTOUPDATE
DEVORA_DISABLE_CLAUDE_CODE
DEVORA_DISABLE_CLAUDE_CODE_PROMPT
DEVORA_DISABLE_CLAUDE_CODE_SKILLS
DEVORA_DISABLE_DEFAULT_PLUGINS
DEVORA_DISABLE_LSP_DOWNLOAD
DEVORA_DISABLE_MODELS_FETCH
DEVORA_DISABLE_PRUNE
DEVORA_DISABLE_TERMINAL_TITLE
DEVORA_ENABLE_EXA
DEVORA_ENABLE_EXPERIMENTAL_MODELS
DEVORA_EXPERIMENTAL
DEVORA_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
DEVORA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
DEVORA_EXPERIMENTAL_DISABLE_FILEWATCHER
DEVORA_EXPERIMENTAL_EXA
DEVORA_EXPERIMENTAL_FILEWATCHER
DEVORA_EXPERIMENTAL_ICON_DISCOVERY
DEVORA_EXPERIMENTAL_LSP_TOOL
DEVORA_EXPERIMENTAL_LSP_TY
DEVORA_EXPERIMENTAL_MARKDOWN
DEVORA_EXPERIMENTAL_OUTPUT_TOKEN_MAX
DEVORA_EXPERIMENTAL_OXFMT
DEVORA_EXPERIMENTAL_PLAN_MODE
DEVORA_ENABLE_QUESTION_TOOL
DEVORA_FAKE_VCS
DEVORA_GIT_BASH_PATH
DEVORA_MODEL
DEVORA_MODELS_URL
DEVORA_PERMISSION
DEVORA_PORT
DEVORA_SERVER_PASSWORD
DEVORA_SERVER_USERNAME
PROJECT_ROOT
RESOURCE_NAME
RUST_LOG
VARIABLE_NAME
VERTEX_LOCATION
XDG_CONFIG_HOME
```

## Package/module identifiers

```text
../../../config.mjs
@astrojs/starlight/components
@devora-ai/plugin
@devora-ai/sdk
path
shescape
zod

@
@ai-sdk/anthropic
@ai-sdk/cerebras
@ai-sdk/google
@ai-sdk/openai
@ai-sdk/openai-compatible
@File#L37-42
@modelcontextprotocol/server-everything
@devora
```

## GitHub owner/repo slugs referenced in docs

```text
24601/devora-zellij-namer
angristan/devora-wakatime
anomalyco/devora
apps/devora-agent
athal7/devora-devcontainers
awesome-devora/awesome-devora
backnotprop/plannotator
ben-vargas/ai-sdk-provider-devora-sdk
btriapitsyn/openchamber
BurntSushi/ripgrep
Cluster444/agentic
code-yeongyu/oh-my-devora
darrenhinde/devora-agents
different-ai/devora-scheduler
different-ai/openwork
features/copilot
folke/tokyonight.nvim
franlol/devora-md-table-formatter
ggml-org/llama.cpp
ghoulr/devora-websearch-cited.git
H2Shami/devora-helicone-session
hosenur/portal
jamesmurdza/daytona
jenslys/devora-gemini-auth
JRedeker/devora-morph-fast-apply
JRedeker/devora-shell-strategy
kdcokenny/ocx
kdcokenny/devora-background-agents
kdcokenny/devora-notify
kdcokenny/devora-workspace
kdcokenny/devora-worktree
login/device
mohak34/devora-notifier
morhetz/gruvbox
mtymek/devora-obsidian
NeuralNomadsAI/CodeNomad
nick-vi/devora-type-inject
NickvanDyke/devora.nvim
NoeFabris/devora-antigravity-auth
nordtheme/nord
numman-ali/devora-openai-codex-auth
olimorris/codecompanion.nvim
panta82/devora-notificator
rebelot/kanagawa.nvim
remorses/kimaki
sainnhe/everforest
shekohex/devora-google-antigravity-auth
shekohex/devora-pty.git
spoons-and-mirrors/subtask2
sudo-tee/devora.nvim
supermemoryai/devora-supermemory
Tarquinen/devora-dynamic-context-pruning
Th3Whit3Wolf/one-nvim
upstash/context7
vtemian/micode
vtemian/octto
yetone/avante.nvim
zenobi-us/devora-plugin-template
zenobi-us/devora-skillful
```

## Paths, filenames, globs, and URLs

```text
./.devora/themes/*.json
./<project-slug>/storage/
./config/#custom-directory
./global/storage/
.agents/skills/*/SKILL.md
.agents/skills/<name>/SKILL.md
.clang-format
.claude
.claude/skills
.claude/skills/*/SKILL.md
.claude/skills/<name>/SKILL.md
.env
.github/workflows/devora.yml
.gitignore
.gitlab-ci.yml
.ignore
.NET SDK
.npmrc
.ocamlformat
.devora
.devora/
.devora/agents/
.devora/commands/
.devora/commands/test.md
.devora/modes/
.devora/plans/*.md
.devora/plugins/
.devora/skills/<name>/SKILL.md
.devora/skills/git-release/SKILL.md
.devora/tools/
.well-known/devora
{ type: "raw" \| "patch", content: string }
{file:path/to/file}
**/*.js
%USERPROFILE%/intelephense/license.txt
%USERPROFILE%\.cache\devora
%USERPROFILE%\.config\devora\devora.jsonc
%USERPROFILE%\.config\devora\plugins
%USERPROFILE%\.local\share\devora
%USERPROFILE%\.local\share\devora\log
<project-root>/.devora/themes/*.json
<providerId>/<modelId>
<your-project>/.devora/plugins/
~
~/...
~/.agents/skills/*/SKILL.md
~/.agents/skills/<name>/SKILL.md
~/.aws/credentials
~/.bashrc
~/.cache/devora
~/.cache/devora/node_modules/
~/.claude/CLAUDE.md
~/.claude/skills/
~/.claude/skills/*/SKILL.md
~/.claude/skills/<name>/SKILL.md
~/.config/devora
~/.config/devora/AGENTS.md
~/.config/devora/agents/
~/.config/devora/commands/
~/.config/devora/modes/
~/.config/devora/devora.json
~/.config/devora/devora.jsonc
~/.config/devora/plugins/
~/.config/devora/skills/*/SKILL.md
~/.config/devora/skills/<name>/SKILL.md
~/.config/devora/themes/*.json
~/.config/devora/tools/
~/.config/zed/settings.json
~/.local/share
~/.local/share/devora/
~/.local/share/devora/auth.json
~/.local/share/devora/log/
~/.local/share/devora/mcp-auth.json
~/.local/share/devora/devora.jsonc
~/.npmrc
~/.zshrc
~/code/
~/Library/Application Support
~/projects/*
~/projects/personal/
${config.github}/blob/dev/packages/sdk/js/src/gen/types.gen.ts
$HOME/intelephense/license.txt
$HOME/projects/*
$XDG_CONFIG_HOME/devora/themes/*.json
agent/
agents/
build/
commands/
dist/
http://<wsl-ip>:4096
http://127.0.0.1:8080/callback
http://localhost:<port>
http://localhost:4096
http://localhost:4096/doc
https://app.example.com
https://AZURE_COGNITIVE_SERVICES_RESOURCE_NAME.cognitiveservices.azure.com/
https://devora.ai/zen/v1/chat/completions
https://devora.ai/zen/v1/messages
https://devora.ai/zen/v1/models/gemini-3-flash
https://devora.ai/zen/v1/models/gemini-3-pro
https://devora.ai/zen/v1/responses
https://RESOURCE_NAME.openai.azure.com/
laravel/pint
log/
model: "anthropic/claude-sonnet-4-5"
modes/
node_modules/
openai/gpt-4.1
devora.ai/config.json
devora/<model-id>
devora/gpt-5.1-codex
devora/gpt-5.2-codex
devora/kimi-k2
openrouter/google/gemini-2.5-flash
opncd.ai/s/<share-id>
packages/*/AGENTS.md
plugins/
project/
provider_id/model_id
provider/model
provider/model-id
rm -rf ~/.cache/devora
skills/
skills/*/SKILL.md
src/**/*.ts
themes/
tools/
```

## Keybind strings

```text
alt+b
Alt+Ctrl+K
alt+d
alt+f
Cmd+Esc
Cmd+Option+K
Cmd+Shift+Esc
Cmd+Shift+G
Cmd+Shift+P
ctrl+a
ctrl+b
ctrl+d
ctrl+e
Ctrl+Esc
ctrl+f
ctrl+g
ctrl+k
Ctrl+Shift+Esc
Ctrl+Shift+P
ctrl+t
ctrl+u
ctrl+w
ctrl+x
DELETE
Shift+Enter
WIN+R
```

## Model ID strings referenced

```text
{env:DEVORA_MODEL}
anthropic/claude-3-5-sonnet-20241022
anthropic/claude-haiku-4-20250514
anthropic/claude-haiku-4-5
anthropic/claude-sonnet-4-20250514
anthropic/claude-sonnet-4-5
gitlab/duo-chat-haiku-4-5
lmstudio/google/gemma-3n-e4b
openai/gpt-4.1
openai/gpt-5
devora/gpt-5.1-codex
devora/gpt-5.2-codex
devora/kimi-k2
openrouter/google/gemini-2.5-flash
```
