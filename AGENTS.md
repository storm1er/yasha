# Yasha — Agent workflows & guardrails

This file is for AI coding agents (and humans) working on Yasha. Read
[README.md](README.md) for the product overview and [CONTRIBUTING.md](CONTRIBUTING.md) for the
human contribution guide. For internal design details see [docs/architecture.md](docs/architecture.md).

## First run — set up your local file

Host-specific facts (Lemonade URL, dev/test users, device IDs, LAN addresses, port reservations)
live **only** in `AGENTS.local.md`, which is gitignored and never committed. If it doesn't exist:

1. Ask the developer for their values and create `AGENTS.local.md` from
   [AGENTS.local.md.example](AGENTS.local.md.example) — fill in only what applies to their setup.
2. Never write personal/host-specific values into tracked files (code, README, AGENTS,
   compose.yml, .env.example, messages/*).
3. Optional local-only working notes: some maintainers keep a private build plan (`PLAN.md`) and
   append-only work journal (`docs/BUILD-LOG.md`). Both are gitignored; reference them from
   `AGENTS.local.md` if (and only if) they exist on your machine.

### First stack setup (`.env` + compose)

If `.env` / `compose.override.yml` don't exist yet, set them up **with the developer** and record
the resulting topology in `AGENTS.local.md`:

1. `cp .env.example .env` and `cp compose.override.yml.example compose.override.yml` (compose.yml
   is the single stack file: yasha always on; lemonade & caddy at `replicas: 0`, no published
   ports — everything else is an opt-in block of the override), then ask the developer which
   backend topology they use:
   - **Bundled Lemonade**: uncomment `services.lemonade.deploy.replicas: 1` in the override;
     `LEMONADE_BASE_URL=http://lemonade:13305` (.env default); publish `13305` only if they want
     direct access from the host.
   - **External Lemonade / proxy of their own**: set `LEMONADE_BASE_URL` to their URL in `.env`;
     the bundled service stays at its default `replicas: 0` — never enable it.
2. Required in `.env`: `BETTER_AUTH_SECRET` (never a placeholder), `BETTER_AUTH_URL` +
   `BETTER_AUTH_TRUSTED_ORIGINS` matching the URL the developer will actually browse, and
   `BOOTSTRAP_ADMIN_*` for first boot (the only automatic way to get the first admin — plain
   signups get role `user`).
3. **An external Lemonade may be unreachable from the agent's network** (private host, allowlist,
   no DNS from containers). Never conclude "backend is down" from a failing `curl`: verify through
   the app itself (`/api/health`, `/api/lemonade/status`, the UI health badge) and ask the
   developer. Record reachability in `AGENTS.local.md`.

## Identity
**Yasha** (Yet Another Self Hosted Assistant): Gemini-style multi-user chat UI on top of a
Lemonade server.

## Hard rules (violation = stop and report, do not "work around")
1. **Lemonade**: base URL comes from `LEMONADE_BASE_URL` (see `.env` / `AGENTS.local.md`).
   - Allowed endpoints: `POST /v1/chat/completions`, `POST /v1/audio/transcriptions | /v1/audio/speech`, `WS GET /v1/realtime`, `GET /v1/models | /v1/health | /v1/stats | /v1/system-info | /v1/system-stats | /v1/registry/search | /v1/pull/variants | /v1/models/{id}/options`.
   - **Never execute mutating Lemonade calls** (`POST /v1/pull|load|unload|delete|install|uninstall`, `/v1/downloads/control`, alias writes, cloud auth) unless `ADMIN_ALLOW_MUTATIONS=true` is set locally in `.env`. Ignore `.env.example` value
   - Quirk: responses may carry `reasoning`/`reasoning_details` fields. **Render & persist only `message.content` / `delta.content`; ignore reasoning deltas.**
2. **Containers only.** Host node/npm are off-limits. Run tools via `docker|podman compose run --rm <service> <cmd>`;
   Allowed host tools: git, curl, docker|podman, adb, python3.
3. **Git**: agents must not commit/branch/tag/push unless the maintainer explicitly asks.
   - If asked to commit, ALWAYS include in the commit description "with the help of AI ($MODEL_NAME)".
4. **Secrets**: `.env` is gitignored — never print or commit it. `.env.example` gets generic placeholders only.
5. **i18n**: every UI string goes through next-intl keys present in BOTH `messages/en.json` and `messages/fr.json`. No hardcoded English in components. Base URLs shown in UI must be derived from the request/env — never a hardcoded host.
6. **Android device QA** (if `AGENTS.local.md` lists one): web QA uses the device's stock browser only.
   Installing/uninstalling **this project's own APK** (sideload, debug-signed) is allowed for app QA —
   nothing else: no settings changes, no other installs, no data wipes. Close tabs when done.
7. Test users: prefix `t<phase>_`. DB at `./data/yasha.db`; wipe only when your task says "fresh start".
8. **Definition of done**: `docker|podman compose run --rm yasha sh -c 'npx tsc --noEmit && npm run lint && npx vitest run --coverage && npm run build'` green — the vitest suite must pass with **100% coverage** of the server scope
   (`app/**/route.ts`, `lib/**/*.ts`, `instrumentation.ts`; thresholds are enforced in `vitest.config.mts`). Any new/changed server route or lib file ships with tests at 100%.
   Do not chase unreachable branches with pragmas: if a branch is provably dead, delete or simplify the code (see the tests workflow).
   Also: happy path verified interactively (Playwright desktop; adb+MCP when mobile is in scope).

## Workflows
### bring-up
Use `README.md` Development part; if `.env`/`compose.override.yml` are missing, follow §First
stack setup above (ask the developer about their Lemonade topology — bundled vs external
`replicas: 0` — and record the result, including whether the backend is reachable from the
agent's network, in `AGENTS.local.md`).

### db migrations
Run drizzle-kit inside the dev-stage `yasha` image (requires `compose.override.yml` — see bring-up):
- generate SQL migrations from the drizzle schema:
  `docker|podman compose run --rm yasha npx drizzle-kit generate`
- push schema straight to `./data/yasha.db` (dev shortcut, no migration files):
  `docker|podman compose run --rm yasha npx drizzle-kit push`

### tests (vitest) — harness & rules
The suite lives in `tests/` and runs **inside the yasha image** (host has no node):
- all: `docker|podman compose run --rm yasha sh -c 'npx vitest run'` (add `--coverage` for the DoD gate)
- one file: `... 'npx vitest run tests/<file>.test.ts'`
- **mid-phase coverage** (full run fails thresholds by design until the phase is done): scope it
  `... 'npx vitest run tests/<file>.test.ts --coverage --coverage.include="app/api/<area>/**/route.ts" --coverage.include="lib/<file>.ts" --coverage.reporter=json'`
  then parse `coverage/coverage-final.json` (`s`/`b`/`f` maps, zero hits = gap) for exact line/arm gaps.

Isolation & safety (set up by `tests/support/setup.ts`, do not weaken it):
- every test-file worker gets a **throwaway SQLite db** (`$YASHA_TEST_DB_DIR`/tmp, random name) — the real `./data/yasha.db` is never touched;
- `LEMONADE_BASE_URL` points at an unroutable host and **fetch is guarded**: an un-mocked Lemonade call fails the test. All Lemonade traffic goes through `mockLemonade()`.
- `NEXT_PHASE=phase-production-build` by default → the queue worker never self-starts (build guard);
  enqueued job rows stay visible for assertions. Worker tests `delete process.env.NEXT_PHASE` in
  `beforeEach` (restore after). The Settings→Memory checkbox (`memory.enabled`) is the sole admin
  kill-switch, gating **memory event types only** (opt-in `learnFromImports` inherits it via its
  fact-extraction jobs); `import.gemini` ingestion, titles, audio and debug keep their own gates.

Harness helpers (`tests/support/`):
- `app.ts`: `callRoute(handler, opts, ctx)` (real NextRequest in/out), `makeRequest` (takes `signal` for client-abort tests), `signUp`/`signIn`/`adminUser`/`sessionId`, `waitFor`, `jsonOf`.
- `db.ts`: `db` (drizzle), `rawSqlite`, `setSetting`/`setFastModel` (they invalidate the settings cache — raw `db.delete(settings)` leaks the 3 s stale cache; call `invalidateSettingsCache()` from `lib/settings` if you bypass).
- `lemonade.ts`: `mockLemonade()` (`route`/`fallback`/`bodies`/`lastCall`; **Responses are single-use — return fresh ones from callbacks**), `json`, `modelsResponse`, `sseCompletion`, `scriptedCompletions`, `streamResponse()`+`bindStream()` for controllable/erroring upstream streams (honours the request abort signal).

Rules & gotchas learned the hard way:
- **No v8-ignore pragmas, no dead-branch padding.** 100% means literal: if a branch is unreachable
  under current invariants (schema notNull/FK, exhaustive key sets, type guarantees), DELETE it and
  keep a code comment; if it guards a real production hazard (race, missing config), make it
  testable instead (e.g. explicit throw, seam to win a race via a one-shot `rawSqlite.prepare` hook).
- DB has `foreign_keys=ON`: seed users/threads before messages/jobs/memories/summaries.
- Job handlers (`lib/memory/*`, title gen) can be driven **directly** with a fake ctx
  `{ job, payload, cfg, signal, heartbeat, setCheckpoint, addCommit }` and apply `addCommit`
  callbacks inside `db.transaction((tx) => …)` — no need to run the worker.
- Module-level state (models cache, `BASE_URL`): isolate with `vi.resetModules()` + re-`import()`
  and fake timers (`vi.setSystemTime`) for TTL/expiry tests. `vi.unstubAllGlobals()` mid-test
  restores real fetch → call `mockLemonade()` again instead.
- SSE routes: drain the returned `Response` (`res.text()`) or pump `res.body` for partial reads;
  `getReader()` locks the body (no `res.text()` afterwards); `res.body.cancel()`/request-abort
  exercise the cancel/abort arms.
- V8 tier-up artifact: branch counters of very hot functions can stop recording late in a file —
  place the branch-critical test early in the file if coverage misreports.
- Env flips in tests must be restored in `afterEach`; usernames are alphanumeric/underscore only.

### Recommended harness setup
At least this MCP:
```json
"playwright": {
   "type": "local",
   "command": ["npx", "-y", "@playwright/mcp@latest", "--browser=firefox"],
   "enabled": true
}
```
And additionally a phone available through `adb` plus
[this MCP](https://github.com/danielealbano/android-remote-control-mcp):
```json
"android-phone": {
   "type": "remote",
   "url": "http://PHONE_IP:8080/mcp",
   "enabled": true,
   "headers": {
      "Authorization": "Bearer {file:~/.config/opencode/android-mcp-token}"
   }
}
```

### desktop QA (Playwright MCP)
Navigate to the dev URL from `AGENTS.local.md` (default `http://localhost`); use
`browser_snapshot` for structure/refs (prefer over screenshots; screenshot only for
visual-fidelity checks); flows: register → login → chat → reload (history) → logout.
Responsive checks: `browser_resize` 390x844 / 768x1024 / 1440x900.

### phone QA (device per AGENTS.local.md)
bash `adb devices` (connect address in `AGENTS.local.md` if wifi-adb); android MCP:
`open_uri "<LAN base URL from AGENTS.local.md>"` → `get_screen_state` (screenshot on page 1)
for layout → `find_nodes`/`tap`/`type_append_text` for flows → cleanup: back out of the tab,
`press_home`. If the browser turns the URL into a search, tap the address bar, retype the
full URL, press Enter.

### SSE verification
`curl -N` the app's streaming route: chunk timestamps must be spaced (~token cadence), not one buffered blob.

### android app (`android/`) — gotchas learned the hard way
- Build only via `cd android && docker compose run --rm gradle <task>`; `adb install -r` a debug
  APK keeps the assistant role only while the `gradle-android-home` keystore volume survives.
- Before device QA: verify `adb shell cmd role get-role-holders android.app.role.ASSISTANT`
  (the role can silently revert — OTA/signature/volume loss) and re-check `adb devices`
  (wifi-adb port drifts across reboots). Re-grant procedure: `android/README.md` §Assistant role.
- **ANR**: Compose 1.6+ `awaitEachGesture` restarts its block without suspending — any early
  `return` (e.g. `enabled` guard) before `awaitFirstDown` is a main-thread busy-loop.
- **Stream UI**: per-token state writes recomposing a full-screen surface ANRs older devices —
  coalesce deltas (~150 ms flush), hoist hot subtrees, animate via `withFrameNanos` shader
  uniforms (draw-phase), never recomposition.
- AGSL: framework `android.graphics.RuntimeShader` (API 33+) + `ShaderBrush` (the Compose-side
  RuntimeShader is not in our deps); shader errors are runtime-only — keep the static fallback.
- Floaty→MainActivity handoff must stay in-process (`PendingAskStore`, never Intent extras for
  data URLs) with the tick latched until the session probe flips signedIn (cold-start race).
- Every new floaty/feature string goes in BOTH `res/values/strings.xml` and `values-fr/`.

### handoff (optional maintainer workflow)
If the maintainer keeps local journals (see §First run): leave the app running (dev or prod, note
which), append the session report to the local `docs/BUILD-LOG.md`, and end with
`STATUS: green|green-minor|broken` + ≤10-line summary + test evidence.
