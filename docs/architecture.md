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
                 │ LEMONADE_BASE_URL (internal    │ optional outbound: remote MCP servers
                 │ docker network, or external)   │
                 ▼
        Lemonade server (bundled container or your own)
        /v1/chat/completions · /v1/audio/* · /v1/models · admin actions
```

- **One container, mostly stateless compute + one stateful file.** All persistent state lives in
  the SQLite database (`DATABASE_PATH`, default `/data/yasha.db`) plus uploaded media under the
  same `/data` volume. Back up the volume, nothing else.
- **Lemonade is the only model backend.** Yasha never talks to model providers directly; it
  consumes Lemonade's OpenAI-compatible surface (`chat/completions`, `audio/transcriptions`,
  `audio/speech`, `models`, admin endpoints). Reasoning fields in upstream responses are
  ignored — only `content` is rendered/persisted.
- **No Redis/message broker**: the background queue is a table (`jobs`) polled by an in-process
  worker started from `instrumentation.ts`; `NEXT_PHASE` guards prevent the worker from
  self-starting during builds. Handlers live in `lib/jobs/` and `lib/memory/`.

## Request flows

### Chat turn (web UI)
1. `POST /api/chat` — auth via better-auth session cookie; attachments (images/audio) are
   validated/stored beforehand under `/data`.
2. Model choice: user picks Fast/Smart; routing + per-model context/limits come from Lemonade's
   model list (cached; see `lib/chat-models-filter.ts`).
3. If tools are enabled (instance `mcp.enabled`, not per-user opted out), `lib/mcp/loop.ts` runs
   bounded tool rounds: Lemonade completion → tool calls → MCP clients (`lib/mcp/client.ts`,
   stdio or HTTP; `lib/mcp/oauth/` for OAuth'd remote servers) → results fed back.
4. Memory recall (FTS5 + optional summaries) is injected per `lib/memory/recall.ts`.
5. The Lemonade stream is re-emitted as SSE (first-token timeout guarded); token deltas are
   persisted at completion, then enqueued jobs may follow (title generation, audio transcription,
   memory extraction).

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
- Lemonade is trusted-but-contained: never published publicly; mutating admin actions require
  `ADMIN_ALLOW_MUTATIONS=true` and an admin role.
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
(un-mocked Lemonade calls fail), route-level tests through real `NextRequest`s. Server scope
enforced at 100% coverage (`vitest.config.mts`). Harness details: [AGENTS.md](../AGENTS.md).
