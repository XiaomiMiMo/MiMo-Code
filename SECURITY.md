# Security

## IMPORTANT

Devora does not accept low-effort AI-generated security reports. Reports must
describe a concrete vulnerability, a realistic impact, and reproducible steps.
Purely automated reports without validation may be closed without review.

## Threat Model

### Overview

Devora is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### No Sandbox

Devora does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run Devora inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `DEVORA_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside Devora's trust boundary  |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

---

# Reporting Security Issues

Devora appreciates responsible disclosure and aims to acknowledge valid reports quickly.

To report a security issue, please use the GitHub Security Advisory ["Report a Vulnerability"](https://github.com/SheriAkhtamov/Devora/security/advisories/new) tab.

Sheri Akhtamov or a Devora maintainer will respond with the next steps. After the initial reply, the maintainer handling the report will keep you informed about progress toward a fix and may ask for additional information or guidance.

## Escalation

If you do not receive an acknowledgement of your report within 6 business days, please open a follow-up GitHub Security Advisory in this repository.
