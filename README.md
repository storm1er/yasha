<div align="center">

# 🍋 Yasha

**Yet Another Self-Hosted Assistant** — a Gemini-style multi-user chat UI on top of
**your own model backends**: [Lemonade](https://lemonade-server.ai) (first-class, bundled)
plus any OpenAI-compatible server, managed by admins under Settings → Backend.

Self-hosted · Private · Multi-language (en/fr) · Web + Android

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/storm1er/yasha/ci.yml?branch=main)](https://github.com/storm1er/yasha/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/storm1er/yasha)](https://github.com/storm1er/yasha/releases)
[![Docker Image](https://img.shields.io/badge/ghcr.io-storm1er%2Fyasha-2496ED?logo=docker&logoColor=white)](https://github.com/storm1er/yasha/pkgs/container/yasha)

</div>

> **Why?** Like [Immich](https://immich.app) is to Google Photos, Yasha aims to be my Google
> Gemini: a Gemini-like assistant you host yourself and share with your household or family —
> streaming chat, voice, memory, per-user accounts and a companion Android app — without giving
> anyone's conversations to a big-tech app. Your data, your server, your family's assistant.

![Yasha — the "Meet Yasha" home screen with the chat composer](docs/images/hero-empty.png)

## Features

- 🔐 Multi-user accounts (username + email/password, sessions via better-auth)
- 💬 Gemini-style chat: streaming responses, thread history, regenerate, code blocks with copy
- 🌙 Light/dark theme, 🇬🇧/🇫🇷 i18n (English + French)
- 📱 Responsive: desktop rail sidebar + mobile drawer
- 🔑 Per-user API keys (`/settings`) for the OpenAI-compatible `/v1` endpoint
  (docs at `/docs/api`)
- 🧠 Multi-provider backends with Fast/Smart pickers over a synced model catalog; per-provider health badge
- 🎙️ Voice input sent natively to audio-capable models — no transcription service to deploy
- 🧩 Memory & Gemini import, background job queue
- 🔎 Agentic tools via MCP (builtin ketch search server, admin-managed, per-user opt-out)
- 🤖 Companion Android assistant app (overlay mic, circle-to-ask, per-user APK builds)
- 🍋 Bundled Lemonade server container — or register any number of OpenAI-compatible providers

## Screenshots

### Web

<table>
  <tr>
    <td><img src="docs/images/chat-light.png" width="440" alt="Web chat with a streaming answer, code blocks and copy buttons (light theme)"></td>
    <td><img src="docs/images/chat-dark.png" width="440" alt="Same conversation in dark theme"></td>
  </tr>
  <tr>
    <td><img src="docs/images/chat-fr.png" width="440" alt="French conversation with rich markdown — headings, lists, tables, code"></td>
    <td><img src="docs/images/settings.png" width="440" alt="Settings: MCP tools, personal Android app download, Gemini import"></td>
  </tr>
</table>

### Android companion app

<table>
  <tr>
    <td><img src="docs/images/android-home.png" width="210" alt="Android app home screen — personal greeting and ask bar"></td>
    <td><img src="docs/images/android-chat.png" width="210" alt="Android chat with a streamed answer, copy & share actions"></td>
    <td><img src="docs/images/android-drawer.png" width="210" alt="Android drawer — thread history synced with the web"></td>
    <td><img src="docs/images/android-assistant-draw.png" width="210" alt="Android assistant with a selected part of screen"></td>
    <td><img src="docs/images/android-assistant-response.png" width="210" alt="Android assistant awnsering to the selected screen part"></td>
  </tr>
</table>

## Quickstart

You need Docker (or podman) and three files: `compose.yml` (the whole stack),
`compose.override.yml.example` and `.env.example` (the Caddyfile is inlined in
`compose.yml`).

```bash
mkdir yasha && cd yasha
curl -fLO https://raw.githubusercontent.com/storm1er/yasha/HEAD/compose.yml
curl -fLO https://raw.githubusercontent.com/storm1er/yasha/HEAD/compose.override.yml.example
curl -fLO https://raw.githubusercontent.com/storm1er/yasha/HEAD/.env.example
cp .env.example .env                 # edit: BETTER_AUTH_SECRET (openssl rand -hex 32),
                                     # BETTER_AUTH_URL, BETTER_AUTH_TRUSTED_ORIGINS,
                                     # BOOTSTRAP_ADMIN_*, YASHA_IMAGE (pre-built image)
cp compose.override.yml.example compose.override.yml
                                     # uncomment what you need (see recipes at the top)
docker compose pull                  # pre-built image (skip if building from source)
docker compose up -d
```

`compose.yml` runs the **yasha** app only by default — the bundled **lemonade**
backend and the **caddy** front both start at `replicas: 0` and no port is
published. **<ins>Enable what you need by uncommenting lines in `compose.override.yml`:</ins>**

- **Plain HTTP on :80** → Caddy option A (also `:13305` for the backend with B).
- **HTTPS with your domain** → Caddy option C (automatic Let's Encrypt on
  80/443, domain in `.env`) — browse `https://your.domain.tld`.
- **Your own TLS proxy** → Yasha "open ports" block; the proxy forwards
  `https://<public-host>` → `http://127.0.0.1:3000` with `Host` +
  `X-Forwarded-Proto: https`.
- **Bundled LLM backend** → Lemonade block (`replicas: 1`, optional NVIDIA/AMD
  GPU lines). Prefer your own? Point `BACKEND_BASE_URL` at it in `.env` (more providers later
  in Settings → Backend).

The stack keeps all state in `./data` (SQLite DB — chat history & attachments
included —, import spool, APK artifacts) — that directory is your whole backup.
Caddy keeps its certificates in named volumes (`caddy_data`). More info about
upgrades, restores, and the proxy checklist: [docs/admin-guide.md](docs/admin-guide.md).

Voice input: tap the mic in chat and talk : the recording is sent natively to the
audio-capable fast model (capability flags in the synced catalog; see Settings → Backend) and gets a
readable caption from a background job. No transcription service to deploy.

No Text-to-Speech _yet_.

### Single `docker run` (not recommended)

If you run your own proxy/backend, one container suffices (the image also embeds
the Android toolchain for per-user APK builds, so expect ~1–2 GB):

```bash
docker run -d --name yasha \
  -p 127.0.0.1:3333:3000 \
  -v yasha-data:/data \
  --add-host=host.docker.internal:host-gateway \
  -e BACKEND_BASE_URL=http://host.docker.internal:13305 \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -e BETTER_AUTH_URL=https://<public-host> \
  -e BETTER_AUTH_TRUSTED_ORIGINS=https://<public-host> \
  -e BOOTSTRAP_ADMIN_USERNAME=admin -e BOOTSTRAP_ADMIN_PASSWORD=password \
  ghcr.io/storm1er/yasha:latest
```

On first boot an empty `/data` volume is automatically migrated and the bootstrap admin is
seeded. Your TLS proxy forwards `https://<public-host>` → `http://127.0.0.1:3333`
with `Host` + `X-Forwarded-Proto: https`.

Running from source instead? That's the contributor path — see [Development](#development) 
and [CONTRIBUTING.md](CONTRIBUTING.md).

## Tools (MCP)

Yasha can equip the assistant with external tools over the Model Context Protocol.

- **Admin** (`/settings` → Tools card): enable/disable tools instance-wide, seed-included
  `ketch` MCP server ships builtin (web search/scrape/docs, via stdio), add remote MCP
  servers by URL with optional headers, run health checks, and exclude individual tools
  per server (denylist).
- **Users** (`/settings` → Tools): opt out of tool use on their own account
  (override of the instance default).
- Behaviour: during a chat turn the model may call tools; each call surfaces as a status
  chip (web + Android) and its result is fed back, up to a bounded number of rounds.
  The OpenAI-compatible `/v1` endpoint injects the same server tools only when the client
  sends none, and passes client-supplied `tools` through untouched.
- Settings keys: `mcp.enabled` (instance kill-switch, default on),
  `mcp.maxToolRounds`, `mcp.toolTimeoutMs`, `mcp.toolResultMaxChars`. Env:
  `MCP_ALLOW_PRIVATE_URLS=true` permits remote servers on private/loopback addresses.

## Documentation

| Doc | What's in it |
| --- | --- |
| [Admin guide](docs/admin-guide.md) | Install options, first boot, TLS, backups, upgrades, troubleshooting |
| [Configuration reference](docs/configuration.md) | Every environment variable & settings layer |
| [Architecture](docs/architecture.md) | Components, request flows, data model, security model |
| [API docs](app/docs/api) | In-app OpenAI-compatible `/v1` reference (`/docs/api` once running) |
| [Android app](android/README.md) | Companion app build & install |
| [Contributing](CONTRIBUTING.md) | Dev setup (containers only), tests, definition of done |
| [AGENTS.md](AGENTS.md) | Guardrails & harness for AI coding agents |

## Development

Contributing? Run the app from the working tree with hot reload. The stack ships
`lemonade`/`caddy` at `replicas: 0` with no published ports, so the dev override
enables what you need (its header lists the recipes : uncomment the Lemonade
`replicas: 1` + ports to reach the backend on :13305, and Yasha dev mode +
ports to reach the app):

```bash
cp .env.example .env                                    # then edit as needed
cp compose.override.yml.example compose.override.yml    # then edit as needed
docker compose up     # yasha on http://localhost:3000 (+ lemonade on :13305)
```

Check quality gates (all must pass, see [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
docker compose run --rm yasha sh -c 'npx tsc --noEmit && npm run lint && npx vitest run --coverage && npm run build'
```

### Database migrations

One-off tools run inside the dev-stage `yasha` image (deps + source come from the override):

```bash
# generate SQL migrations from the drizzle/ schema
docker compose run --rm yasha npx drizzle-kit generate

# push the schema straight to ./data/yasha.db (dev shortcut, no migration files)
docker compose run --rm yasha npx drizzle-kit push
```

## Contributing

Using AI to contribute to this project is allowed. Just make sure to keep personal workflow,
setup and specifics to your setup into `AGENTS.local.md` (gitignored — start from
`AGENTS.local.md.example`) so you never commit sensible datas. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

Yasha is licensed under the [GNU AGPL-3.0](LICENSE).
