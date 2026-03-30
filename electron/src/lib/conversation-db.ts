import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { getDataDir } from "./data-dir";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(path.join(dir, "conversations.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      toolName TEXT,
      toolInput TEXT,
      toolResult TEXT,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(projectId);
    CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

    CREATE TABLE IF NOT EXISTS sessions (
      sessionId TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      title TEXT,
      model TEXT,
      engine TEXT DEFAULT 'ollama',
      createdAt INTEGER NOT NULL,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId);
  `);

  return db;
}

export function saveMessage(
  sessionId: string,
  projectId: string,
  msg: {
    role: string;
    content: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    timestamp: number;
  },
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO messages (sessionId, projectId, role, content, toolName, toolInput, toolResult, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        projectId,
        msg.role,
        msg.content,
        msg.toolName ?? null,
        msg.toolInput ?? null,
        msg.toolResult ?? null,
        msg.timestamp,
      );
  } catch {}
}

export function saveSessionMeta(
  sessionId: string,
  projectId: string,
  title: string | null,
  model: string | null,
  engine: string,
  createdAt: number,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO sessions (sessionId, projectId, title, model, engine, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sessionId) DO UPDATE SET
           title = excluded.title,
           model = excluded.model,
           engine = excluded.engine`,
      )
      .run(sessionId, projectId, title ?? null, model ?? null, engine, createdAt);
  } catch {}
}

export function updateSessionSummary(sessionId: string, summary: string): void {
  try {
    getDb()
      .prepare(`UPDATE sessions SET summary = ? WHERE sessionId = ?`)
      .run(summary, sessionId);
  } catch {}
}

export function getSessionMessages(
  sessionId: string,
  limit = 100,
): Array<{
  id: number;
  sessionId: string;
  projectId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  timestamp: number;
  createdAt: number;
}> {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM messages WHERE sessionId = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(sessionId, limit) as ReturnType<typeof getSessionMessages>;
  } catch {
    return [];
  }
}

export function searchProjectMessages(
  projectId: string,
  query: string,
  limit = 50,
): Array<{
  id: number;
  sessionId: string;
  projectId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  timestamp: number;
  createdAt: number;
}> {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM messages WHERE projectId = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(projectId, `%${query}%`, limit) as ReturnType<typeof searchProjectMessages>;
  } catch {
    return [];
  }
}

export function getProjectSessions(projectId: string): Array<{
  sessionId: string;
  projectId: string;
  title: string | null;
  model: string | null;
  engine: string;
  createdAt: number;
  summary: string | null;
}> {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM sessions WHERE projectId = ? ORDER BY createdAt DESC`,
      )
      .all(projectId) as ReturnType<typeof getProjectSessions>;
  } catch {
    return [];
  }
}

export function getRecentMessages(
  projectId: string,
  limit = 50,
): Array<{
  id: number;
  sessionId: string;
  projectId: string;
  role: string;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  timestamp: number;
  createdAt: number;
}> {
  try {
    return getDb()
      .prepare(
        `SELECT * FROM messages WHERE projectId = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(projectId, limit) as ReturnType<typeof getRecentMessages>;
  } catch {
    return [];
  }
}
