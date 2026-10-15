# Administrator guide

Audience: whoever installs and operates a Yasha instance. For env-var details see
[configuration.md](configuration.md), for internals [architecture.md](architecture.md).

## Install options

| Option | When |
| --- | --- |
| **Pre-built image + `compose.prod.yml` (recommended)** | Standard self-hosting. No source checkout: pull the CI-built image from GHCR, run web + bundled Lemonade, TLS at your proxy. |
| **… + `compose.prod.caddy.yml`** | Same, plus bundled Caddy with automatic Let's Encrypt on ports 80/443 (set `CADDY_ADDRESS=your.domain.tld`; no Caddyfile needed — it's inlined in the overlay). |
| **External Lemonade / your own proxy** | Any of the above with `LEMONADE_BASE_URL` pointed at your instance; scale the bundled backend to `replicas: 0` in a local override, and consider `ADMIN_ALLOW_MUTATIONS=false`. Or run the bare image with `docker run` (README). |
| **From source** (`compose.yml` + override) | **Contributors**: builds images from the working tree for development. Not the supported path for production hosting. |

The production files (README Quickstart has the exact `curl` commands):

- `compose.prod.yml` — web (image pinned via `YASHA_IMAGE` in `.env`) + bundled Lemonade,
  `web` published on **loopback only** (`127.0.0.1:${PORT:-3000}`), Lemonade internal-only.
- `compose.prod.caddy.yml` — optional TLS front on 80/443.

## First boot

1. Create a directory, drop `compose.prod.yml` (+ overlay if used) and `.env` in it.
   In `.env` set at minimum: `YASHA_IMAGE`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `BETTER_AUTH_TRUSTED_ORIGINS`, and `BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD`.
2. `docker compose -f compose.prod.yml up -d` (add `-f compose.prod.caddy.yml` for the bundled
   proxy).
3. On an empty database the app runs migrations and seeds the bootstrap admin, then log in at
   your URL. **Sign in as that admin first** — regular signups get role `user`.
4. Once the admin exists, you may want to clear `BOOTSTRAP_ADMIN_*` from `.env` and restart
   (they're inert while users exist, but keeping them out of `.env` is tidier).
5. Check the health badge in the UI or `GET /api/health`; the Lemonade connection status is at
   `GET /api/lemonade/status`.

## Users & access control

- **Self-service registration** can be disabled in Settings → Admin (`auth.allowRegistration`);
  empty instances always allow it so the bootstrap can't lock itself out.
- **Admins** manage users (Settings → Admin → Users), instance settings, the Lemonade backend
  (models, pull/load/unload when `ADMIN_ALLOW_MUTATIONS=true`), background jobs, and MCP servers.
- **API keys** (Settings → API keys): per-user keys for the OpenAI-compatible endpoint, shown
  once, stored hashed; revoke anytime. Example:

  ```bash
  curl -N https://yasha.example.com/v1/chat/completions \
    -H "Authorization: Bearer yasha_…key…" -H "Content-Type: application/json" \
    -d '{"model":"smart","messages":[{"role":"user","content":"hello"}],"stream":true}'
  ```

  `GET /v1/models` lists routable models (`fast`, `smart`, or explicit Lemonade ids).

## TLS / reverse proxy

Terminate TLS yourself and forward to `${PORT:-3000}` with `Host` + `X-Forwarded-Proto: https`.
`BETTER_AUTH_URL`/`BETTER_AUTH_TRUSTED_ORIGINS` must match the **public origin exactly** — auth
rejects other origins. Never publish the Lemonade port publicly (it has no auth); the bundled
compose keeps it internal.

## Backup & restore

Everything lives in one place: the **`yasha_data` volume** (compose.prod.yml) / `/data` volume.
It contains the SQLite DB (`DATABASE_PATH`) — **including chat history and image/audio
attachments, which are stored in the database itself, not as loose files** — plus the import
spool, APK build artifacts, and the gradle home used for APK builds. There are no separate
upload/attachment volumes to back up.

```bash
# Named volume (compose.prod.yml): snapshot/copy the volume itself
docker compose -f compose.prod.yml stop web
docker run --rm -v yasha_yasha_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/yasha-data-$(date +%F).tar.gz -C /data .
docker compose -f compose.prod.yml start web
```

(Running from source with the `./data` bind-mount instead? A plain `cp -a data data.backup`
works.) Restore = put the files back into a fresh volume/ directory and start. No other state
exists (settings and API keys are all in the DB). Lemonade model downloads are separate
volumes — re-pullable, no need to back up.

## Upgrades

```bash
# 1. Back up the data volume (see above).
# 2. Point YASHA_IMAGE in .env at the new version tag (see CHANGELOG for breaking notes).
docker compose -f compose.prod.yml pull web
docker compose -f compose.prod.yml up -d
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
| Health badge red / no completions | `GET /api/lemonade/status`; `LEMONADE_BASE_URL` reachable from the web container (`docker compose exec web wget -qO- $LEMONADE_BASE_URL/v1/health`). |
| Admin model actions → 503 | Expected when `ADMIN_ALLOW_MUTATIONS=false` (intentional on shared backends). |
| 429 responses | In-app limiter (`*_PER_MIN` env knobs) or your proxy's limits. |
| Android build links fail | APK builder needs the toolchain image (not a slim variant) and disk space under `/data`. |
| Logs | `docker compose logs -f web` / `… logs lemonade`. |
