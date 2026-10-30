# Architecture

How Yasha works internally. Product-level description lives in the [README](../README.md).

## Big picture

```
 Browser / Android app
        │  HTTPS (your proxy or bundled Caddy)
        ▼
 ┌─────────────────────────────  web container (Next.js 16) ───────────────────────────┐
 │  UI (React, next-intl en/fr)         REST /api/*            OpenAI-compat /v1/*     │
 │  better-auth (sessions, CSRF)  ─────► route handlers ─────► SSE streaming           │
 │  in-process job worker  ◄─────────── SQLite (drizzle, WAL, FTS5)                    │
 │  MCP client layer (stdio + remote, OAuth)                                           │
 │  APK builder (spawns gradle in-image)                                               │
 └───────────────┬───────────────────────────────┬─────────────────────────────────────┘
                 │ providers table (lib/provider/) │ optional outbound: remote MCP servers
                 ▼
   n enabled providers: Lemonade (bundled container or your own —
   adds the management console) + any OpenAI-compatible server.
   /v1/chat/completions · /v1/audio/* · /v1/models (+ Lemonade admin actions)
```

- **One container, mostly stateless compute + one stateful file.** All persistent state lives in
  the SQLite database (`DATABASE_PATH`, default `/data/yasha.db`) plus uploaded media under the
  same `/data` volume. Back up the volume, nothing else.
- **Pluggable provider layer (`lib/provider/`).** 0..n providers from the `providers` table
  (env-seeded on first boot): the `lemonade` adapter (flagship — adds the admin control plane:
  models, pull/load/unload, registry, pin) and `openai_compatible` for any server exposing
  `POST /v1/chat/completions` + `GET /v1/models`. A synced `models` catalog table (TTL re-sync +
  admin capability overrides) drives chat validation and vision/audio flags. Everything
  user-facing speaks **canonical `provider:remote` model ids**; only outbound upstream bodies
  carry the provider's remote id. Reasoning fields in upstream responses are ignored — only
  `content` is rendered/persisted.
- **No Redis/message broker**: the background queue is a table (`jobs`) polled by an in-process
  worker started from `instrumentation.ts`; `NEXT_PHASE` guards prevent the worker from
  self-starting during builds. Handlers live in `lib/jobs/` and `lib/memory/`.

## Request flows

### Chat turn (web UI)
1. `POST /api/chat` — auth via better-auth session cookie; attachments (images/audio) are
   validated/stored beforehand under `/data`. The client is the AI SDK's `useChat`
   (`@ai-sdk/react`): the wire body carries only the new user turn + thread/model/attachments
   (history is rebuilt server-side), and the response is the AI SDK **UI-message stream
   ("protocol v2")** assembled by `lib/chat/stream.ts` — thread id via a `data-thread` part,
   tool chips via `data-tool`, terminal failures via `data-error {code}`.
2. Model choice: user picks Fast/Smart; routing + capability flags come from the synced
   provider catalog (`lib/provider/catalog.ts`, TTL 60 s, stale rows served on upstream failure).
3. If tools are enabled (instance `mcp.enabled`, not per-user opted out), the AI SDK loop runs
   bounded tool rounds (`streamText` + `stopWhen: stepCountIs(...)`): MCP tools are exposed as
   AI SDK tools (`lib/mcp/ai-tools.ts` over `lib/mcp/client.ts`, stdio or HTTP;
   `lib/mcp/oauth/` for OAuth'd remote servers) and chip events stream out as `data-tool` parts.
4. Memory recall (FTS5 + optional summaries) is injected per `lib/memory/recall.ts`.
5. Generation is AI SDK `streamText` against the provider's chat-completions endpoint
   (`lib/provider/language-model.ts`; first-token timeout guarded); reasoning deltas are dropped,
   text + tool records are persisted at completion (also on client abort), then enqueued jobs
   may follow (title generation, audio transcription, memory extraction). Background jobs run
   their completions through the same seam (`completeOnce`).

### OpenAI-compatible endpoint (`/v1`)
`POST /v1/chat/completions` + `GET /v1/models` authenticate with per-user API keys
(`Authorization: Bearer`, hashed at rest, `lib/api-keys.ts`). Server tools are injected only when
the client sends none; client-supplied `tools` pass through.

### In-container APK builds
The web image ships a full Android toolchain (`docker/Dockerfile` toolchain/prewarm stages).
`lib/apk-builder.ts` spawns gradle per request to build a per-user-configured APK
(`app/d/[token]` one-time download links) — no DinD.

## Data model (SQLite, drizzle)

| Group | Tables |
| --- | --- |
| Auth (better-auth) | `user`, `session`, `account`, `verification` |
| Chat | `threads`, `messages` |
| Config | `settings` (instance-level key/value), `userSettings` (per-user overrides) |
| Backends | `providers` (adapter rows; API key masked on read), `models` (synced catalog cache + capability overrides) |
| Tools | `mcpServers`, `mcpOauth` |
| Queue | `jobs`, `jobCheckpoints` |
| Memory | `memories`, `threadSummaries` |
| Imports | `importBatches`, `threadImports` (Gemini takeout) |
| Misc | `apiKeys`, `apkBuilds` |

Config is **three-layer**: env vars (deployment-level, see
[configuration.md](configuration.md)) → `settings` table (admin UI, cached ~3 s) →
`userSettings` (user overrides). Migrations are generated drizzle SQL in `drizzle/`; a fresh DB
is auto-migrated at boot (`lib/db/bootstrap.ts`).

## Security model

- Session auth (better-auth) for the app; hashed API keys for `/v1`; role flag `isAdmin` gates
  `/api/admin/*`. CSRF/origin checks via `BETTER_AUTH_TRUSTED_ORIGINS`; coarse in-app rate
  limiting (`lib/rate-limit.ts`) on top of proxy-level limits.
- Backends are trusted-but-contained: never published publicly; mutating control-plane actions
  require `ADMIN_ALLOW_BACKEND_MUTATIONS=true` and an admin role (plain OpenAI-compatible
  providers have no control plane — those routes answer 501). Provider API keys live in the DB
  (volume = secret boundary), masked on every read, never logged.
- MCP servers are a trust boundary: private/loopback URLs denied unless
  `MCP_ALLOW_PRIVATE_URLS=true`; admin denylists per server; users can only opt out.
- SSRF/attachment guards: image/audio size + count caps (settings), FTS only over a user's own
  threads.

## Frontend

Next.js App Router; `app/` routes (chat, settings, docs, admin), `components/` (UI, chat,
settings, docs), `i18n/` + `messages/{en,fr}.json` via next-intl, `next-themes` for light/dark.
The Android app (`android/`) is a separate Gradle project (Kotlin/Compose) talking the same
`/api` surface with the better-auth cookie + SSE — see [android/README.md](../android/README.md).

## Testing

Vitest suite in `tests/` running in the web image: throwaway SQLite per worker, guarded `fetch`
(un-mocked backend calls fail), route-level tests through real `NextRequest`s; shared adapter
contract suite per provider type. Server scope
enforced at 100% coverage (`vitest.config.mts`). Harness details: [AGENTS.md](../AGENTS.md).
