PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_categories (
  sort_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (sort_index)
);

CREATE TABLE IF NOT EXISTS countdowns (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS private_uploads (
  filename TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_reminder_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  checkpoint TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sort_index INTEGER NOT NULL,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, sort_index);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  parent_run_id TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);

CREATE TABLE IF NOT EXISTS agent_memories (
  kind TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (kind, sort_index)
);

CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
