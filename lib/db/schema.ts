import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const ts = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).$defaultFn(() => new Date());

// ── better-auth tables ────────────────────────────────────────────────────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  // Account UI/output locale (BCP-47 tag from LOCALES); null = follow DEFAULT_LOCALE.
  locale: text("locale"),
  // username plugin
  username: text("username").unique(),
  displayUsername: text("display_username"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: ts("expires_at").notNull(),
  token: text("token").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: ts("access_token_expires_at"),
  refreshTokenExpiresAt: ts("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

// ── Yasha tables ──────────────────────────────────────────────────────────────

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  title: text("title").notNull().default(""),
  systemPrompt: text("system_prompt"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull().default(""),
  metaJson: text("meta_json"),
  createdAt: ts("created_at").notNull(),
});

// Protocol v3 pending actions (docs/protocol-v3.md): one row per client answer
// the server is waiting for (interactive tool calls today; `kind` reserves
// tool approvals for the next slice). Written when the assistant row that
// asks is persisted, consumed by the next request whose history carries the
// matching tool output. `message_id` is the row the answer gets overlaid on.
export const pendingActions = sqliteTable("pending_actions", {
  id: text("id").primaryKey(), // SDK toolCallId of the ask
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"tool">().notNull().default("tool"),
  tool: text("tool").notNull(),
  argsJson: text("args_json").notNull(),
  // Plain timestamps (no $defaultFn): createPendingActions always supplies both.
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  last4: text("last4").notNull().default(""),
  createdAt: ts("created_at").notNull(),
  // nullable WITHOUT $defaultFn (a plain ts() would stamp every new key revoked)
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// ── Model providers (docs/provider-plan.md) ───────────────────────────────────
// Env-seeded once (BACKEND_*), then the table is the source of truth (Q5).
// `models` is a per-provider catalog cache (Q13): identity + admin capability
// overrides; volatile state (loaded/downloaded) is always fetched live.

export const PROVIDER_TYPES = ["lemonade", "openai_compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(), // slug; part of canonical model ids (M2)
  type: text("type").$type<ProviderType>().notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  /** Secret: masked on every API read (mcp_servers.headers_json precedent). */
  apiKey: text("api_key"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  configJson: text("config_json"), // reserved, unused until a provider type needs extras
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(), // canonical `${providerId}:${remoteId}` (M2)
    providerId: text("provider_id").notNull(),
    remoteId: text("remote_id").notNull(),
    displayName: text("display_name"),
    /** null = from upstream/auto-seed; true/false = admin override (wins, Q14). */
    vision: integer("vision", { mode: "boolean" }),
    audioInput: integer("audio_input", { mode: "boolean" }),
    contextWindow: integer("context_window"),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("models_provider_remote_idx").on(t.providerId, t.remoteId),
    foreignKey({
      columns: [t.providerId],
      foreignColumns: [providers.id],
    }).onDelete("cascade"),
  ]
);

// ── MCP servers (builtin ketch row + admin-registered global servers +
//    user-owned servers, isolated per owner) ──────────────────────────────────

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
    name: text("name").notNull(),
    /** Remote (streamable HTTP) servers only; builtin ketch is stdio. */
    url: text("url"),
    /** Static auth headers (secret): owner-write only, masked on read. */
    headersJson: text("headers_json"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** JSON string array of tool names to hide from this server. */
    disabledToolsJson: text("disabled_tools_json"),
    /** NULL = global (builtin or admin-registered, visible to everyone);
     *  set = user-owned (visible only to the owner). */
    ownerUserId: text("owner_user_id"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.ownerUserId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    index("mcp_servers_owner_idx").on(t.ownerUserId),
  ],
);

// ── MCP OAuth (per remote server: DCR client, tokens, discovery cache,
//    one-shot pending authorization). The row's existence is what opts the
//    streamable-HTTP transport into the OAuth provider on connect.

export const mcpOauth = sqliteTable(
  "mcp_oauth",
  {
    serverId: text("server_id").primaryKey(),
    /** Authorization server the client/tokens below were obtained from. */
    issuer: text("issuer"),
    clientJson: text("client_json"),
    tokensJson: text("tokens_json"),
    /** Epoch ms when the stored access token expires (from `expires_in` at
     * save time; null when unknown) — drives proactive refresh. */
    tokensExpiresAt: integer("tokens_expires_at", { mode: "timestamp_ms" }),
    discoveryJson: text("discovery_json"),
    pendingState: text("pending_state"),
    pendingVerifier: text("pending_verifier"),
    pendingUrl: text("pending_url"),
    pendingAt: integer("pending_at", { mode: "timestamp_ms" }),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.serverId],
      foreignColumns: [mcpServers.id],
    }).onDelete("cascade"),
  ],
);

export type McpOauth = typeof mcpOauth.$inferSelect;

// ── Background jobs queue (generic engine; memory is just the first family) ──

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    // `<type>:<threadId|userId>` — THE enqueue primitive (dedupe upsert).
    dedupeKey: text("dedupe_key").notNull().unique(),
    type: text("type").notNull(),
    // Null for workspace-wide events; FK cascade: thread deletion kills job rows.
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    // Earliest claim time: debounce target, cron fire time, or retry backoff.
    runAfter: ts("run_after").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: integer("locked_at", { mode: "timestamp_ms" }),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    lastError: text("last_error"),
    // Enqueue-time snapshot for run bounds/logging only — never the checkpoint.
    payloadJson: text("payload_json"),
    resultJson: text("result_json"),
  },
  (t) => [
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
    index("jobs_thread_type_idx").on(t.threadId, t.type),
    index("jobs_user_idx").on(t.userId),
  ]
);

// ── Memory system (M1) ────────────────────────────────────────────────────────

export const MEMORY_KINDS = ["fact", "preference", "summary", "insight"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_SOURCES = ["derived", "explicit"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];
export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MemoryKind>().notNull().default("fact"),
    text: text("text").notNull(),
    source: text("source").$type<MemorySource>().notNull().default("derived"),
    // Insight rows only: code-derived from the cited evidence count (D3), never
    // trusted from the model.
    confidence: text("confidence").$type<MemoryConfidence>(),
    // Insight rows only: JSON array (≥2) of memory ids the insight was derived
    // from (D6 provenance). Plain text like supersededById — no FK.
    evidenceIds: text("evidence_ids"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    // Provenance only — NOT an FK: memories outlive their source thread (PLAN §1).
    threadId: text("thread_id"),
    // Set when a merge supersedes this row; plain text (no self-FK) — deletions
    // null it out explicitly.
    supersededById: text("superseded_by_id"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    index("memories_user_pinned_idx").on(t.userId, t.pinned),
    index("memories_user_updated_idx").on(t.userId, t.updatedAt),
  ]
);

// Durable watermark for checkpointed handlers (today: memory.fact_extraction).
// threadId = '' for workspace-wide jobs → no FK (an '' row would violate one);
// orphans are pruned by the worker once their thread is gone.
export const threadSummaries = sqliteTable(
  "thread_summaries",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    /** Watermark: id of the last message rolled into `summary`. */
    throughMessageId: text("through_message_id"),
    version: integer("version").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.threadId] })]
);

export const jobCheckpoints = sqliteTable(
  "job_checkpoints",
  {
    jobType: text("job_type").notNull(),
    threadId: text("thread_id").notNull().default(""),
    throughMessageId: text("through_message_id").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.jobType, t.threadId] })]
);

// ── Imports (chat history brought in from other assistants) ───────────────────
// One row per uploaded file/batch (GEMINI-IMPORT-PLAN §Data model). Counters are
// updated by the chunked importer; `checkpointOffset` is the byte cursor into the
// spooled file, which is what makes a crashed import resumable.

export const IMPORT_BATCH_STATUSES = [
  "uploading",
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("gemini"),
    filename: text("filename"),
    bytes: integer("bytes").notNull().default(0),
    sha256: text("sha256"),
    status: text("status").$type<ImportBatchStatus>().notNull().default("uploading"),
    // Byte cursor + line cursor into the spooled file (resume point).
    checkpointOffset: integer("checkpoint_offset").notNull().default(0),
    checkpointLines: integer("checkpoint_lines").notNull().default(0),
    // Running counters, advanced once per committed chunk.
    totalLines: integer("total_lines").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    skippedUnchanged: integer("skipped_unchanged").notNull().default(0),
    skippedChanged: integer("skipped_changed").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    malformedCount: integer("malformed_count").notNull().default(0),
    flaggedCount: integer("flagged_count").notNull().default(0),
    optionsJson: text("options_json"),
    // Report payload: failure/flag samples + post-run duplicate audit (bounded).
    countsJson: text("counts_json"),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("import_batches_user_created_idx").on(t.userId, t.createdAt)]
);

// Provenance + idempotency ledger: one row per conversation actually created.
// The unique key is what makes re-uploading the same (or resumed) file a no-op.
export const threadImports = sqliteTable(
  "thread_imports",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    importId: text("import_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("gemini"),
    externalId: text("external_id").notNull(),
    bodyHash: text("body_hash").notNull(),
    turnCount: integer("turn_count").notNull().default(0),
    lineIndex: integer("line_index").notNull(),
    flagsJson: text("flags_json"),
    importedAt: ts("imported_at").notNull(),
  },
  (t) => [
    uniqueIndex("thread_imports_unique_external").on(t.userId, t.provider, t.externalId),
    // One provenance row per thread (also the cleanup-by-thread lookup).
    uniqueIndex("thread_imports_thread_idx").on(t.threadId),
    index("thread_imports_import_line_idx").on(t.importId, t.lineIndex),
    index("thread_imports_user_body_idx").on(t.userId, t.provider, t.bodyHash),
  ]
);

// Per-user Android APK builds (host + baked session, one-time download link).
// At most one row per user: a rebuild resets the row (new token, new session).
export const APK_BUILD_STATUSES = ["queued", "building", "ready", "failed", "consumed"] as const;
export type ApkBuildStatus = (typeof APK_BUILD_STATUSES)[number];

export const apkBuilds = sqliteTable("apk_builds", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  // Unguessable token in the one-time /d/<token> download URL.
  token: text("token").notNull().unique(),
  // Server base URL baked into the APK (from the request origin at build time).
  serverUrl: text("server_url").notNull(),
  // better-auth session row created for the device and baked into the APK.
  sessionId: text("session_id").notNull(),
  status: text("status").$type<ApkBuildStatus>().notNull().default("queued"),
  apkPath: text("apk_path"),
  error: text("error"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  // Download links and abandoned builds are swept past this deadline.
  expiresAt: ts("expires_at").notNull(),
});

// Personal prefs only (instance-wide keys stay in `settings`).
// Today: memory.userEnabled — row absent = follow instance default.
export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })]
);

export type User = typeof user.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type ThreadSummary = typeof threadSummaries.$inferSelect;
export type JobCheckpoint = typeof jobCheckpoints.$inferSelect;
export type ApkBuild = typeof apkBuilds.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type ThreadImport = typeof threadImports.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
