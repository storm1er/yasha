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

### Lemonade backend

| Variable | Default | Description |
| --- | --- | --- |
| `LEMONADE_BASE_URL` | `http://lemonade:13305` | Base URL of the Lemonade server. Bundled container keeps it on the internal network; point elsewhere for an external instance (then scale the bundled one to `replicas: 0` in your override). |
| `LEMONADE_API_KEY` | empty | Optional Bearer token if your Lemonade requires one. |
| `ADMIN_ALLOW_MUTATIONS` | `true` | Gate for admin-only **mutating** Lemonade calls (pull/load/unload/delete) in `/api/admin/actions`. Set `false` for shared/remote backends — routes answer `503 mutations_disabled`. |

### First boot

| Variable | Default | Description |
| --- | --- | --- |
| `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | empty | Seeded as admin **only while the users table is empty** — the only automatic way to get the first admin (role defaults to `user` on signup; promotion afterwards is done by an existing admin in Settings → Admin). |

### Networking & runtime

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Host port published by compose (container always listens on 3000). Your TLS proxy points here. |
| `DATABASE_PATH` | `/data/yasha.db` | SQLite file location (inside the `/data` volume). |
| `TZ` | `UTC` | Container timezone (affects cron/scheduler jobs). |
| `NEXT_TELEMETRY_DISABLED` | — | Set to `1` to silence Next.js telemetry prompts. |
| `ALLOWED_DEV_ORIGINS` | empty | **Dev only**: extra hostnames allowed to load `/_next` assets (LAN-IP development, HMR). Leave empty in production. |
| `APP_NAME` | `Yasha` | Display-name override (rarely needed). |

### TLS front (optional bundled Caddy)

| Variable | Default | Description |
| --- | --- | --- |
| `CADDY_ADDRESS` | `:80` | Only used with the Caddy overlay (`compose.prod.caddy.yml` for the pre-built stack, `compose.caddy.yml` for source runs). Set to a domain for automatic Let's Encrypt HTTPS (ports 80+443 must reach the container). |

### Image selection (pre-built stack only)

| Variable | Default | Description |
| --- | --- | --- |
| `YASHA_IMAGE` | `ghcr.io/storm1er/yasha:latest` | Image used by `compose.prod.yml`. CI publishes `:latest` and a `vX.Y.Z` version tag on every merge to main (semver from Conventional Commits). Unused by the source-based `compose.yml`, which builds locally. |

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
`chat.*`, `api.*`, `memory.*`, `mcp.*`, `import.*`, `auth.allowRegistration`, `debug.echo`. They
are documented in-place in the admin UI; env vars always win for deployment-level concerns.
