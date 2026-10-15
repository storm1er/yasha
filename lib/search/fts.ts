import { rawSqlite } from "@/lib/db";

/**
 * FTS5 external-content indexes over `messages.content` and `memories.text`,
 * kept in sync by SQL triggers (so every write path — chat route, memory API,
 * job handlers — is covered for free). Called once per process from
 * `ensureReady()`.
 */
export function ensureFts(): void {
  rawSqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      content='memories',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF text ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
      INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  // One-time backfill for rows written before the index existed.
  rawSqlite
    .prepare(
      `INSERT INTO messages_fts(messages_fts)
       SELECT 'rebuild' WHERE (SELECT count(*) FROM messages_fts) = 0
         AND (SELECT count(*) FROM messages) > 0;`
    )
    .run();
  rawSqlite
    .prepare(
      `INSERT INTO memories_fts(memories_fts)
       SELECT 'rebuild' WHERE (SELECT count(*) FROM memories_fts) = 0
         AND (SELECT count(*) FROM memories) > 0;`
    )
    .run();
}

/**
 * Rank memory ids by relevance to a free-text query (bm25, best first).
 * Returns [] on any FTS hiccup — callers fall back to recency ordering.
 */
export function searchMemoryIds(query: string, userId: string, limit: number): string[] {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    const rows = rawSqlite
      .prepare(
        `SELECT m.id AS id
         FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.user_id = ? AND m.superseded_by_id IS NULL
         ORDER BY bm25(memories_fts)
         LIMIT ?`
      )
      .all(match, userId, limit) as { id: string }[];
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Sanitized OR-joined quoted-phrase query; never throws on user input. */
export function buildFtsQuery(raw: string): string | null {
  const terms = new Set<string>();
  for (const word of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 3) terms.add(word);
    if (terms.size >= 12) break;
  }
  if (terms.size === 0) return null;
  return [...terms].map((t) => `"${t}"`).join(" OR ");
}

export type MessageEvidence = {
  role: string;
  content: string;
  metaJson: string | null;
  createdAt: Date;
};

/**
 * Dreaming evidence pass (MEMORY-ENHANCEMENT-PLAN P3): raw user/assistant
 * messages owned by `userId`, ranked by bm25 against a free-text topic.
 * Returns [] on any FTS hiccup or empty query.
 */
export function searchMessagesText(userId: string, query: string, limit: number): MessageEvidence[] {
  const match = buildFtsQuery(query);
  if (!match) return [];
  try {
    const rows = rawSqlite
      .prepare(
        `SELECT m.role AS role, m.content AS content, m.meta_json AS metaJson, m.created_at AS createdAt
         FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN threads t ON t.id = m.thread_id
         WHERE messages_fts MATCH ? AND t.user_id = ? AND m.role IN ('user', 'assistant')
         ORDER BY bm25(messages_fts)
         LIMIT ?`
      )
      .all(match, userId, limit) as { role: string; content: string; metaJson: string | null; createdAt: number }[];
    return rows.map((r) => ({ role: r.role, content: r.content, metaJson: r.metaJson, createdAt: new Date(r.createdAt) }));
  } catch {
    return [];
  }
}
