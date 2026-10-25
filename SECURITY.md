# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Older releases | ❌ |

Security fixes are applied to the latest release; there is no backport policy yet while the
project is pre-1.0.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues.**

- Preferred: report privately via GitHub — *Security → Report a vulnerability* on the repo
  (private, between reporter and maintainers).
- Fallback: email `storm1er-yasha@proton.me` (state whether the report may be published once fixed).

We aim to acknowledge within **5 business days** and ship a fix or mitigation within **30 days**
for confirmed issues of moderate or higher severity. You'll be credited in the release notes
unless you prefer anonymity.

## Hardening notes for operators

- **Never expose the Lemonade backend to the public internet.** It has no authentication by
  default; only the Yasha container should reach it (the bundled compose keeps it on the
  internal Docker network — do not publish port `13305` publicly).
- Terminate TLS at your reverse proxy and set `BETTER_AUTH_URL` / `BETTER_AUTH_TRUSTED_ORIGINS`
  to the exact public origin (see [docs/admin-guide.md](docs/admin-guide.md)).
- Keep `BETTER_AUTH_SECRET` secret and unique per instance; rotate it if leaked (sessions reset).
- `ADMIN_ALLOW_BACKEND_MUTATIONS=false` disables admin actions that mutate the backend (model
  pull/load/delete) — recommended on shared or remote Lemonade servers (OpenAI-compatible
  providers have no control plane at all; those routes answer 501).
- `auth.allowRegistration=false` (Settings → Security) closes self-service signup.
- Remote MCP servers can be restricted (`mcp.userServersEnabled`,
  `MCP_ALLOW_PRIVATE_URLS`) — treat tool servers as part of your trust boundary.

## Scope

Out of scope: issues requiring administrative access to a Yasha instance, vulnerabilities in
[Lemonade](https://lemonade-server.ai) or model backends themselves (report those upstream),
and attacks requiring physical access to the host.
