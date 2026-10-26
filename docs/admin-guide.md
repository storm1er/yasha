# Administrator guide

Audience: whoever installs and operates a Yasha instance. For env-var details see
[configuration.md](configuration.md), for internals [architecture.md](architecture.md).

## Install options

One compose file, `compose.yml`, describes the whole stack (yasha, lemonade,
caddy) — only **yasha** runs by default; `lemonade` and `caddy` ship at
`replicas: 0` and nothing publishes a host port. Everything else is opt-in by
uncommenting lines in `compose.override.yml` (start from
`compose.override.yml.example`; recipes listed in its header):

| Option | When |
| --- | --- |
| **Pre-built image** (recommended) | Set `YASHA_IMAGE=ghcr.io/storm1er/yasha:<tag>` in `.env` + `docker compose pull`. No source checkout: three files (`compose.yml`, `compose.override.yml.example`, `.env.example`) are a full install. |
| **Bundled Caddy, plain HTTP** | Caddy option A: `replicas: 1` + `"80:80"` → `http://<host>`. Option B adds a plain-HTTP Lemonade front on `:13305` (`CADDY_LEMONADE_ADDRESS=":13305"` + published port, LAN-only!). |
| **Bundled Caddy, TLS** | Caddy option C: `replicas: 1` + ports `80`+`443` + `CADDY_ADDRESS=your.domain.tld` (and `CADDY_LEMONADE_ADDRESS=llm.…` for the backend too) in `.env` → automatic Let's Encrypt. No Caddyfile on disk — it is inlined in `compose.yml`. |
| **Your own TLS proxy** | Yasha "open ports" block in the override; forward `Host` + `X-Forwarded-Proto: https` to `127.0.0.1:3000`. No Caddy needed. |
| **Bundled vs external backend** | Lemonade block `replicas: 1` (optionally + NVIDIA/AMD GPU lines) keeps `BACKEND_BASE_URL=http://lemonade:13305`. External instance? leave it at 0, point `BACKEND_BASE_URL` at your URL (`BACKEND_TYPE=lemonade` or `openai_compatible`), consider `ADMIN_ALLOW_BACKEND_MUTATIONS=false`. More providers later in Settings → Backend. |
| **From source** | Contributors: `docker compose up` builds the image; the dev override adds hot reload (README Development). |

## First boot

1. Create a directory, drop `compose.yml` there, `cp` the two `.example` files
   to `.env` and `compose.override.yml`, and edit them: at minimum
   `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`,
   `BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD` (+ `YASHA_IMAGE` for the pre-built
   image) in `.env`, and your ports/front blocks in `compose.override.yml`.
2. `docker compose pull` (pre-built image) then `docker compose up -d`.
   Sanity-check the merged config with `docker compose config`.
3. On an empty database the app runs migrations and seeds the bootstrap admin, then log in at
   your URL. **Sign in as that admin first** — regular signups get role `user`.
4. Once the admin exists, you may want to clear `BOOTSTRAP_ADMIN_*` from `.env` and restart
   (they're inert while users exist, but keeping them out of `.env` is tidier).
5. Check the health badge in the UI or `GET /api/health`; per-provider connection status is at
   `GET /api/backend/status` (the badge shows the worst status across enabled providers).

## Users & access control

- **Self-service registration** can be disabled in Settings → Admin (`auth.allowRegistration`);
  empty instances always allow it so the bootstrap can't lock itself out.
- **Admins** manage users (Settings → Admin → Users), instance settings, the **Backend** tab
  (provider CRUD, the synced model catalog with capability overrides, and the management console
  when a Lemonade provider is selected — pull/load/unload when `ADMIN_ALLOW_BACKEND_MUTATIONS=true`),
  background jobs, and MCP servers.
- **API keys** (Settings → API keys): per-user keys for the OpenAI-compatible endpoint, shown
  once, stored hashed; revoke anytime. Example:

  ```bash
  curl -N https://yasha.example.com/v1/chat/completions \
    -H "Authorization: Bearer yasha_…key…" -H "Content-Type: application/json" \
    -d '{"model":"default:gemma-3n-e4b-it","messages":[{"role":"user","content":"hello"}],"stream":true}'
  ```

  `GET /v1/models` lists routable models as canonical `provider:remote` ids (`owned_by` is the
  provider id) — use those ids verbatim as `model`.

## TLS / reverse proxy

Terminate TLS yourself and forward to `127.0.0.1:${PORT:-3000}` (Yasha "open
ports" override block) with `Host` + `X-Forwarded-Proto: https` — or enable the
bundled Caddy (options A/B/C in `compose.override.yml.example`): no TLS on 80
(+13305), or automatic Let's Encrypt on 80/443 by setting `CADDY_ADDRESS` to
your domain in `.env`.
`BETTER_AUTH_URL`/`BETTER_AUTH_TRUSTED_ORIGINS` must match the **public origin exactly** — auth
rejects other origins. Never publish the Lemonade port publicly (it has no auth); by default
nothing is published at all, and the opt-in Lemonade/Caddy-B front blocks are LAN-only.

## Backup & restore

Everything lives in one place: the **`./data` directory** bind-mounted at
`/data` (compose.yml). It contains the SQLite DB (`DATABASE_PATH`) — **including
chat history and image/audio attachments, which are stored in the database
itself, not as loose files** — plus the import spool, APK build artifacts, and
the gradle home used for APK builds. There are no separate upload/attachment
volumes to back up.

```bash
# Stop the app, snapshot ./data, restart
docker compose stop yasha
cp -a data data.backup-$(date +%F)
docker compose start yasha
```

Restore = put the files back into `./data` and start. No other state exists
(settings and API keys are all in the DB). Caddy keeps its certificates and
aggregated config in the `caddy_data`/`caddy_config` named volumes (re-issuable,
no need to back up); Lemonade model downloads are separate volumes —
re-pullable, no need to back up.

## Upgrades

```bash
# 1. Back up ./data (see above).
# 2. Point YASHA_IMAGE in .env at the new version tag (see CHANGELOG for breaking notes).
docker compose pull yasha
docker compose up -d
```

Pending DB migrations run automatically at boot. Roll back = previous tag + restore the
pre-upgrade backup (migrations may not be reversible).

## Tools (MCP)

- The builtin `ketch` server (web search/scrape/docs) ships enabled; toggle in
  Settings → Admin → Tools, add remote servers (URL + headers, health check, per-tool denylist).
- Users can opt out of tool use on their own account.
- Private/loopback remote servers require `MCP_ALLOW_PRIVATE_URLS=true` (or the matching
  admin setting for user servers) — treat MCP servers as part of your trust boundary.

## Memory & background jobs

Memory (facts/summaries/"dreaming") is **off by default**; enable per feature in
Settings → Admin → Memory. Everything runs through the in-DB job queue — inspect queue health in
Settings → Admin → Jobs (retries, stale leases, retention).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login fails / "untrusted origin" | `BETTER_AUTH_URL` & `BETTER_AUTH_TRUSTED_ORIGINS` vs the URL you browse; proxy forwards `Host` + `X-Forwarded-Proto`. |
| Health badge red / no completions | `GET /api/backend/status` (per-provider); each provider's base URL reachable from the app container (`docker compose exec yasha wget -qO- <base>/v1/health`). |
| Admin model actions → 503 | Expected when `ADMIN_ALLOW_BACKEND_MUTATIONS=false` (intentional on shared backends); → 501 on providers without a management console (plain OpenAI-compatible). |
| 429 responses | In-app limiter (`*_PER_MIN` env knobs) or your proxy's limits. |
| Android build links fail | APK builder needs the toolchain image (not a slim variant) and disk space under `/data`. |
| Logs | `docker compose logs -f yasha` / `… logs lemonade caddy`. |
