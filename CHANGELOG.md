# Changelog

All notable changes to this project are documented here. This file is
generated automatically by CI from Conventional Commits landing on `main`
([Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)).

## [0.2.15] - 2026-11-03

### Bug Fixes
- **chat:** Reflow render_ui card grids on phones instead of squeezing them (13631d8)

## [0.2.13] - 2026-11-03

### Features
- **app-update:** Generic releases, background checks, admin toggle (#34 Phase C) (27d0f49)

## [0.2.12] - 2026-11-03

### Features
- **app-update:** In-app self-update install flow (issue #34, Phase B) (f8a9c8c)

## [0.2.11] - 2026-11-02

### Features
- **android:** Mirror admin attachment caps via /api/attachment-limits (issue #15) (c640978)
- **android:** Version awareness for self-updates (#34, Phase A) (de607f1)

## [0.2.10] - 2026-11-02

### Features
- **mcp:** User-approved MCP tool calls (issue #32) (3885af1)
- **chat:** Resume-stream reattach — detached generation + replay hub (issue #33) (863fdde)

### Bug Fixes
- **chat:** Mark stored text parts done — resume auto-send fires after reload (e51ce35)

## [0.2.9] - 2026-11-02

### Features
- Protocol v3 request contract — server + web cutover (issue #21, P1) (3ece92f)
- **android:** Protocol v3 request shape — closes the app/server skew (issue #21, P4-lite) (707bad6)
- **chat:** Interactive tools + pending_actions gate (#21, P2+P3) (87c6d8b)
- **chat:** Tier-1 generative UI — render_ui declarative component cards (#28) (61f8d79)
- **protocol:** Cards request flag — render_ui independent of interactive (issue #30) (0d2a0e2)
- **android:** Render tier-1 generative UI cards (issue #30) (b42e805)

### Bug Fixes
- **chat:** Emit start-step frame so answered asks do not auto-resend (#21) (235712e)

## [0.2.8] - 2026-11-01

### Features
- Generative UI Milestone 1 — display-only tool cards (issue #16) (219c981)

### Other
- Never clear the stored session on a transport failure (fixes #14) (e5c2aa9)
- Settings parity phase 1 + admin field parity (issue #15) (371d15d)

## [0.2.7] - 2026-10-30

### Features
- **provider:** AI SDK language-model seam on every adapter (M1) (3797334)
- **chat:** /api/chat on AI SDK streamText with UI-message protocol v2 (M2) (fcca144)
- **jobs:** CompleteOnce on AI SDK streamText (M3) (10565bb)

### Other
- Chat client on useChat + protocol v2 (89d506a)
- Architecture docs for the AI SDK pipeline (b239936)
- Android client speaks protocol v2 (0e31498)

## [0.2.5] - 2026-10-27

### Bug Fixes
- Surface and warn on tool-output truncation (issue #8) (7adeb4e)

## [0.2.4] - 2026-10-26

### Bug Fixes
- **chat:** Keep tool chips at their execution position across multi-round turns (b5e207e)

## [0.2.3] - 2026-10-26

### Features
- **provider:** Multi-provider backend layer (Lemonade + OpenAI-compatible) (c414c14)

## [0.2.2] - 2026-10-21

### Bug Fixes
- **settings:** Deep-link settings tabs, model-setup notice targets Lemonade (c210ae3)

## [0.2.1] - 2026-10-20

### Bug Fixes
- **docker:** Retry bounded loops around gradle/npm-ci downloads (637c7b0)

### Refactoring
- **compose:** Single compose.yml + fully-commented opt-in override example (e872015)

## [0.2.0] - 2026-10-19

### Features
- **mcp:** Add ability to see mcp content and allow arguments for mcp (f562eeb)

## [0.1.4] - 2026-10-19

### Bug Fixes
- **chat:** Keep failed turns retryable + android tool/loader UI (0b64ec3)

## [0.1.3] - 2026-10-17

### Bug Fixes
- **docs:** Auto changelog should be more complete now (d87e66e)

## [0.1.2] - 2026-10-17

### Bug Fixes
- Settings > General > Phone > assistant btn now redirect to defaultApp system menu first. (39bbd2d)

## [0.1.0] - 2026-10-16

### Features
- **init:** Initial commit. (1ac13ba)

