# Configuration reference

Two layers configure Yasha:

1. **Environment variables** (this page) — deployment-level, set in `.env` (compose) or `-e`
   flags (single `docker run`). See [`.env.example`](../.env.example) for the canonical, always
   up-to-date list with inline comments.
2. **Runtime settings** — instance settings in **Settings → Admin** (stored in the `settings`
   table) and per-user preferences (stored in `userSettings`): model routing, memory, MCP tool
   limits, registration toggle, upload limits, etc. Changing them needs no restart.

## Environment variables

### Required

| Variable | Default | Description |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | — | Session/CSRF signing secret. Generate: `openssl rand -hex 32`. The app refuses to boot without it. |
| `BETTER_AUTH_URL` | — | Canonical app URL, no trailing slash (e.g. `https://yasha.example.com`). |
| `BETTER_AUTH_TRUSTED_ORIGINS` | — | Comma-separated origins allowed to call auth endpoints. Must include every origin users browse from (proxy, LAN IP). |

### Backend (model providers)

Providers live in the `providers` table — admins manage them in **Settings → Backend**
(add/remove any Lemonade or OpenAI-compatible server, enable/disable, API keys). The env
vars below only **seed the initial `default` provider on first boot, while the table is
empty**; after that the table is the source of truth and these vars are inert.

| Variable | Default | Description |
| --- | --- | --- |
| `BACKEND_TYPE` | `lemonade` | Provider type to seed: `lemonade` or `openai_compatible`. |
| `BACKEND_BASE_URL` | `http://lemonade:13305` | Base URL of the backend to seed. The bundled Lemonade container ships at `replicas: 0` (enable it in `compose.override.yml`); point this at your own instance otherwise. |
| `BACKEND_API_KEY` | empty | Optional Bearer token for the seeded provider. |
| `ADMIN_ALLOW_BACKEND_MUTATIONS` | `true` | Gate for admin-only **mutating** control-plane calls (pull/load/unload/delete) against Lemonade providers in `/api/admin/actions`. Set `false` for shared/remote backends — routes answer `503 mutations_disabled`. |

### First boot

| Variable | Default | Description |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | empty | Seeded as admin **only while the users table is empty** — the only automatic way to get the first admin (role defaults to `user` on signup; promotion afterwards is done by an existing admin in Settings → Admin). |

### Networking & runtime

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Nominal host port of the app (container always listens on 3000). compose.yml publishes **nothing** by default; with the "open ports" override block it is the host side of the mapping. Your TLS proxy points there. Unneeded when Caddy fronts the app. |
| `DATABASE_PATH` | `/data/yasha.db` | SQLite file location (inside the `./data` bind-mount). |
| `TZ` | `UTC` | Container timezone (affects cron/scheduler jobs). |
| `NEXT_TELEMETRY_DISABLED` | — | Set to `1` to silence Next.js telemetry prompts. |
| `ALLOWED_DEV_ORIGINS` | empty | **Dev only**: extra hostnames allowed to load `/_next` assets (LAN-IP development, HMR). Leave empty in production. |
| `APP_NAME` | `Yasha` | Display-name override (rarely needed). |

### Web front (optional bundled Caddy)

The `caddy` service ships at `replicas: 0` with no published port; enable it by
uncommenting a block in `compose.override.yml` (options A/B/C). Its Caddyfile is
inlined in `compose.yml` (env placeholders expanded by Caddy at boot).

| Variable | Default | Description |
| --- | --- | --- |
| `CADDY_ADDRESS` | `:80` | Yasha site address. Plain `:80` = HTTP; `your.domain.tld` = automatic Let's Encrypt HTTPS on 80+443 (also set `BETTER_AUTH_URL`/`_TRUSTED_ORIGINS` accordingly). |
| `CADDY_LEMONADE_ADDRESS` | `127.0.0.1:13305` | Lemonade site address. The loopback default is unreachable from outside the container (inactive). `:13305` = plain HTTP front (publish the port in the override, LAN-only); `llm.your.domain.tld` = automatic HTTPS. |

### Image selection

| Variable | Default | Description |
| --- | --- | --- |
| `YASHA_IMAGE` | `yasha:local` (built from source) | Set to the pre-built GHCR image (e.g. `ghcr.io/storm1er/yasha:latest`) to run without building; CI publishes `:latest` and a `vX.Y.Z` version tag on every merge to main (semver from Conventional Commits). |

### Rate limiting (coarse in-app backstop)

Per-identity fixed 1-minute windows, in-memory per process. Harden at your reverse proxy for
serious deployments; `YASHA_RATE_LIMIT=off` disables the limiter entirely.

| Variable | Default | Applies to |
| --- | --- | --- |
| `RATE_LIMIT_API_PER_MIN` | `300` | Authed reads/settings |
| `RATE_LIMIT_AUTH_PER_MIN` | `30` | Auth-sensitive (users, API keys, APK links) |
| `RATE_LIMIT_WRITE_PER_MIN` | `60` | Threads/memory/prefs mutations |
| `RATE_LIMIT_HEAVY_PER_MIN` / `RATE_LIMIT_HEAVY_WINDOW_MS` | `30` / `60000` | Chat, `/v1` completions, speech |

### Advanced / less-used

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_ALLOW_PRIVATE_URLS` | `false` | Allow remote MCP servers on private/loopback addresses (admin-configured servers only; user servers have their own `mcp.userPrivateUrls` setting). |
| `YASHA_IMPORT_DIR` | under `/data` | Spool directory for Gemini takeout uploads. |
| `YASHA_APK_BUILD_DIR` / `YASHA_APK_SOURCE_DIR` / `YASHA_APK_BUILD_TIMEOUT_MS` | defaults under `/data` + baked sources | APK builder knobs (only relevant if you disable in-image builds or relocate the source tree). |

Internal (do not set): `NEXT_PHASE`, `NEXT_RUNTIME`, `GRADLE_USER_HOME`.

## i18n

`DEFAULT_LOCALE=en` sets the fallback locale; users switch per-account (web + Android), both
`en` and `fr` ship builtin. Adding a language = new `messages/<lang>.json` (see
[CONTRIBUTING.md](../CONTRIBUTING.md)).

## Settings keys (admin UI)

Runtime settings are keyed in the `settings` table (`lib/settings.ts`) — namespaces: `fast_model`,
`smart_model`, `chat.*`, `api.*`, `memory.*`, `mcp.*`, `import.*`, `auth.allowRegistration`, `debug.echo`.
`fast_model`/`smart_model` (and thread model pins) hold **canonical `provider:remote` ids** from the
synced catalog, e.g. `default:gemma-3n-e4b-it`. They are documented in-place in the admin UI; env
vars always win for deployment-level concerns.
