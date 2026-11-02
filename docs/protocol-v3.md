# Protocol v3 — the stock AI SDK chat contract

Status: **implemented (issue #21, P0–P4 + interactive P2/P3)** — supersedes decision **D1**
(server-authoritative request body) of the M0–M5 migration. Greenfield cutover: no dual protocol,
no migration. This document is the normative contract; `tests/fixtures/protocol-v3.jsonl` is the
wire-conformance fixture (gated by `tests/protocol-v3.test.ts` on the web side; the Android parser
tests use the same fixtures).

### Implementation status

| Slice | State | Notes |
|---|---|---|
| P0 spec + fixtures | shipped | this file + `tests/fixtures/protocol-v3.jsonl` |
| P1 request contract (parse, reconcile, id idempotency, `interactive`) | shipped | `lib/chat/request-v3.ts` |
| P2 pending-actions gate | shipped | `pending_actions` table, `lib/chat/interactive.ts` |
| P3 interactive tools (`ask_choice`/`confirm_action`) + resume | shipped | web renders + answers; Android sends `interactive: false` |
| Tier-1 generative UI `render_ui` (issue #28) | shipped | `data-card` chunk + `meta.cards`; web-only (gated by `interactive`), see §Response |
| P3 resume-stream reattach | **not built** | optional; see "Resume streams" below |
| MCP-tool **approvals** (`tool-approval-request` / `experimental_toolApprovalSecret`) | **deferred** | the gate + overlay machinery here is the substrate; `pending_actions.kind` is reserved. The SDK's per-request message-sequence approval contract doesn't compose with the DB-hydration loop yet — tracked as a follow-up on #21 |


## Principles

1. **Client history is transport, not truth.** The request carries the conversation the client
   displays (the standard `useChat` body). The server persists **only what it produced** (its own
   stream → `messages.meta_json`, as today) and rebuilds model input from **its own DB window**.
   The sent history is used for (a) the new user turn, (b) id reconciliation, and (c) P2/P3 tool
   outputs — nothing else. Content mismatches in old messages are ignored (stored rows are
   authoritative); **unknown user-role message ids are rejected with `409
   invalid_history`** (stale or hostile clients reload instead of silently
   branching). Assistant-role echoes are ignored outright — they only exist
   because a turn's client-side copy outlived its (never-persisted) failure.
2. **Server stays authoritative on policy**: windowing, memory injection, token caps, tool-round
   budget, noToolSupport degradation — all applied to model messages after conversion, never
   influenced by client-sent text.
3. **Surface flag, not negotiation**: `interactive: boolean` in the body (default `true`) states
   whether *this surface* can answer cards today (floaty: `false`). The server simply omits
   interactive tools when false. Not a version handshake; there is exactly one protocol version.
4. **Client message ids are persisted** on user turns (idempotent retry: re-POSTing the same tail
   user id after a failed turn replaces the same turn, mirroring today's same-turn dedupe).

## Request (v3)

`POST /api/chat` — JSON body:

```jsonc
{
  "id": "new" | "<threadId>",         // thread the conversation belongs to
  "messages": [ /* UIMessage[], full client window, last = user role */ ],
  "model": "provider:remote",          // optional override (unchanged validation)
  "attachments": { "images": [..], "audio": ".." }, // optional, trailing user turn only (unchanged caps)
  "interactive": true                  // optional, default true
}
```

Rules:

- `messages` is a non-empty array; the **last element has role `user`** ("send") — or role
  `assistant` carrying ≥1 tool part in `output-available` state ("resume", shipped with P2/P3:
  the payload is the validated tool outputs, no new user row). Every id is a string ≤ 64 chars;
  the trailing (send) id is new (persisted with this request) or matches the failed tail turn
  (retry, replaces it).
- All **non-trailing user-role ids must exist in the thread** — else `409
  invalid_history`. Their content is ignored (hydrated from the DB).
  Assistant-role echoes are **tolerated ghosts** (a failed turn keeps its
  assistant message client-side but persists no row): shape-checked, then
  dropped — the server never persists assistant turns from the transport.
- New-thread flow: `id: "new"`, `messages` ends with the single user message; the server creates
  the thread and answers with the `data-thread` custom part as today (client adopts the id).
- Attachments, model validation, busy gate, audio gates, rate limits: **unchanged**.

## Response (unchanged UI-message stream + v3 additions)

The response remains the AI SDK UI-message stream (`createUIMessageStreamResponse`):
`start`, `data-thread`, `start-step` (step boundary — keeps answered tool parts out of the
resumed turn's step), `text-start/delta/end`, `data-tool` (chip state machine, optional
`card` per issue #16), `data-error {code}`, `[DONE]`. Clients must ignore unknown chunk types.

**Tier-1 generative UI (issue #28, web surface only)** — the `render_ui` tool (offered when
`interactive: true`) executes server-side: the model's component tree is validated
(`lib/chat/render-ui.ts`: closed vocabulary, depth/node/string caps) and, if valid, streamed as
the custom part `data-card {id, root}` and persisted flat on `meta.cards` (interleaved into the
turn via `{type:"card"}` entries in `meta.parts`). The model receives a short receipt; invalid
input is fed back as the tool result to self-correct. No answer flows back: no pending row, no
resume — display-only. The vocabulary (v1): `text`, `metric`, `badge`, `progress`, `list`,
`chart` (bar/line/area/donut), `table`, `card`, `grid`, `slides`.

**P2/P3 additions (standard chunks, not custom parts)** — interactive tools stream as real SDK
tool chunks so `useChat` exposes typed tool parts natively:

- `tool-input-start` / `tool-input-delta` / `tool-input-available` for the tool call
  (e.g. `ask_choice`, `confirm_action`) → the client renders the question and calls
  `addToolOutput(...)`.
- Approvals: `tool-approval-request` → `addToolApprovalResponse(...)`
  (`experimental_toolApprovalSecret` signs/verifies).
- The answer arrives on the **next request**: the trailing assistant message now carries the tool
  part in `output-available` state (or an approval response). Trigger "resume": the last client
  message is an assistant whose tool calls match server-created **pending actions**.

### Pending actions (P2)

Server table `pending_actions { id (=toolCallId), threadId, userId, messageId, kind, tool,
argsJson, createdAt, expiresAt, consumedAt }`, written when the asking assistant row is persisted
(`kind: "tool"` today; `"approval"` reserved — see status above):

- On the next request, every tool output in the trailing assistant message must match an
  unconsumed, unexpired row **for this user + thread** → consumed, and the answer is overlaid
  onto the stored assistant turn's `meta.tools` record (`answered: true`) so history converges
  for later turns.
- Expired → row closes and the model sees `[no answer — the request expired]`; already consumed
  or unknown/foreign rows are ignored (a replay can never clobber a stored answer). A resume
  where **nothing** matches is `409 invalid_history` (no generation is spent on it).
- `interactive: false` never offers the ask tools nor creates pending rows; answers to rows that
  exist (created while interactive) still gate normally.

## Resume streams (P3, optional)

In-process buffer (`consumeSseStream`) keyed by thread; a client reconnect with no new turn
reattaches and replays. **Single-instance constraint** (matches the compose topology) — documented,
not solved as a distributed system.

## Error codes

Unchanged (`invalid_message`, `invalid_model`, `busy`, `no_model_configured`, `not_found`,
`upstream_*`, `timeout`, `empty_response`, …) plus new: `invalid_history` (409, reconciliation),
`expired` / `invalid` (tool results, not HTTP).

## Rollout (greenfield)

Single cutover per phase, ordered server → web → android; until the Android app lands on v3 its
requests 400/409 — acceptable on the dev instance during the stack (issue #21 sequencing).
