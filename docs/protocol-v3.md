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
| Tier-1 generative UI `render_ui` (issue #28) | shipped | `data-card` chunk + `meta.cards`; gated by `interactive ∥ cards` (issue #30), see §Response |
| P3 resume-stream reattach (issue #33) | shipped | detached generation + replay hub (`lib/chat/replay.ts`), `GET /api/chat/[threadId]/stream`, `POST /api/chat/stop`, thread `generating` flag — see §Resume streams |
| MCP-tool **approvals** (issue #32) | shipped | own contract (not the SDK's `tool-approval-request`): `kind:"approval"` rows + synthetic `mcp_approval` tool part + setting `mcp.requireToolApprovals` — see §Pending actions |


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
   interactive tools when false. `cards: boolean` (default = `interactive`, issue #30) gates the
   display-only `render_ui` tool separately — Android runs `interactive: false, cards: true`.
   Not a version handshake; there is exactly one protocol version.
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
- Body: `{ id, messages, model?, attachments?, interactive?, cards? }` (`cards` defaults to
  `interactive`, issue #30).
- Attachments, model validation, busy gate, audio gates, rate limits: **unchanged**.

## Response (unchanged UI-message stream + v3 additions)

The response remains the AI SDK UI-message stream (`createUIMessageStreamResponse`):
`start`, `data-thread`, `start-step` (step boundary — keeps answered tool parts out of the
resumed turn's step), `text-start/delta/end`, `data-tool` (chip state machine, optional
`card` per issue #16), `data-error {code}`, `[DONE]`. Clients must ignore unknown chunk types.

**Tier-1 generative UI (issue #28; surfaces with a card renderer — web + Android)** — the
`render_ui` tool (offered when `interactive ∥ cards`, issue #30) executes server-side: the
model's component tree is validated
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
- **MCP-tool approvals (issue #32)**: with the admin setting `mcp.requireToolApprovals` on,
  a gated MCP call streams the synthetic `mcp_approval` tool part (`tool-input-start` +
  `tool-input-available` with `input: {server, tool, args}`) instead of executing → the client
  renders Approve/Deny and calls `addToolOutput(...)` with `"approved"` / `"denied"`. The
  SDK-native `tool-approval-request`/`addToolApprovalResponse` path is NOT used: its
  per-request approval-sequence contract assumes the approval rides the transport history,
  which doesn't compose with the DB-hydration loop.
- The answer arrives on the **next request**: the trailing assistant message now carries the tool
  part in `output-available` state (or an approval response). Trigger "resume": the last client
  message is an assistant whose tool calls match server-created **pending actions**.

### Pending actions (P2)

Server table `pending_actions { id (=toolCallId), threadId, userId, messageId, kind, tool,
argsJson, createdAt, expiresAt, consumedAt }`, written when the asking assistant row is persisted
(`kind: "tool"` = interactive asks; `kind: "approval"` = MCP-tool approvals, below):

- On the next request, every tool output in the trailing assistant message must match an
  unconsumed, unexpired row **for this user + thread** → consumed, and the answer is overlaid
  onto the stored assistant turn's `meta.tools` record (`answered: true`) so history converges
  for later turns.
- Expired → row closes and the model sees `[no answer — the request expired]`; already consumed
  or unknown/foreign rows are ignored (a replay can never clobber a stored answer). A resume
  where **nothing** matches is `409 invalid_history` (no generation is spent on it).
- `interactive: false` never offers the ask tools nor creates pending rows; answers to rows that
  exist (created while interactive) still gate normally.

#### MCP-tool approvals (`kind: "approval"`, issue #32)

With `mcp.requireToolApprovals` on (Settings → Tools), every MCP call gates BEFORE the bridge:
`execute()` returns the placeholder `[pending user approval — …]` (the model is told not to
retry; a same-turn retry just gets `…already requested…` without re-opening the request), the
`mcp_approval` tool part streams as above, and the persisted `meta.tools` record carries
`{approval: true, callId}` — at persist time that opens the `kind:"approval"` row (tool = the
qualified `mcp__<server>__<tool>` name, args = the verbatim call).

The verdict resumes like an ask; the RESUME request then **executes the deferred tool itself**
and overlays the REAL output (or `[denied by user]`, the expiry string, or the tool-vanished
string) onto the stored round — the model sees one clean MCP exchange under the original
tool_call id, with no re-call and no approval protocol inside the model loop. A resume carrying
only approval answers never builds the toolset unless a verdict actually needs it (lazy).
Non-promptable surfaces (`interactive: false`) get a hard `[blocked: …]` tool result instead —
gated tools are never silently executed there. The `/v1` compat endpoint has no client channel
and is unaffected by the setting (documented limitation).

## Resume streams (issue #33)

Generation is **decoupled from the response connection**. `buildChatResponse` opens a replay hub
(`lib/chat/replay.ts`) keyed by `(userId, threadId)`: every SSE frame of the turn is buffered and
fanned out to any number of views. The original `POST /api/chat` response is just one view, so:

- **A client disconnect no longer kills the turn.** Closing/reloading the tab unsubscribes its
  view; generation runs to completion server-side and the assistant row persists normally (the busy
  gate stays claimed until then — a second send still gets `409 busy`).
- **Reattach:** `GET /api/chat/[threadId]/stream` (the SDK's default `reconnectToStream` URL)
  returns the hub view — a full replay from frame zero (matching `resumeStreamIsReplay`), then
  live frames until the turn ends. `204` = nothing in flight (the SDK's clean no-resume signal).
  Ownership is implicit: the hub key is the authenticated user id, so another user's thread id
  matches nothing (204, not a 404 oracle). The web client calls `resumeStream()` after loading a
  thread whose `GET /api/threads/[id]` reports `thread.generating: true`.
- **Explicit stop:** because a gone view is not a stop, the Stop button must tell the server —
  `POST /api/chat/stop { id }` aborts the turn exactly like the old disconnect path (partial row
  persists as `aborted: true`, gate releases, `200`; `404` when idle). Before the first `data-thread`
  arrives there is no id to target, so the turn finishes server-side and surfaces on reload.

Frames are pre-encoded SSE strings byte-identical to `JsonToSseTransformStream` (`data: {json}\n\n`,
closed by `data: [DONE]\n\n`), with `: stream-open` / `: keep-alive` comment pings on the heartbeat,
so `DefaultChatTransport.processResponseStream` parses hub views unchanged. **Single-instance
constraint** (process-local registry, same as the busy gate — matches the compose topology), and a
fan-out cap per hub (extra reattaches get 204). The `/v1` compat endpoint is unaffected (no hub).

## Error codes

Unchanged (`invalid_message`, `invalid_model`, `busy`, `no_model_configured`, `not_found`,
`upstream_*`, `timeout`, `empty_response`, …) plus new: `invalid_history` (409, reconciliation),
`expired` / `invalid` (tool results, not HTTP).

## Rollout (greenfield)

Single cutover per phase, ordered server → web → android; until the Android app lands on v3 its
requests 400/409 — acceptable on the dev instance during the stack (issue #21 sequencing).
