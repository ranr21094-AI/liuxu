CREATE TABLE IF NOT EXISTS reading_positions (document_id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reading_time (document_id TEXT PRIMARY KEY, milliseconds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS reading_time_sessions (document_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, milliseconds INTEGER NOT NULL, PRIMARY KEY(document_id, session_id));
