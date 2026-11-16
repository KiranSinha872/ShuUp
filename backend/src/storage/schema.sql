-- ==============================================================================
-- ShuUp: Supabase PostgreSQL Schema
-- Migration from SQLite to PostgreSQL
-- Preserves existing table names, column semantics, indexes, and constraints.
-- Enables Row Level Security (RLS) on all tables with NO public policies.
-- ==============================================================================

-- 1. Accounts Table (Phase 8a foundation for 7c Google Sign-In & 7d Email)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  google_sub_hash TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role = 'user'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  email TEXT UNIQUE,
  password_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub_hash);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- 2. Bans Table (Keyed by identity hash; survives account deletion)
CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  identity_hash TEXT UNIQUE NOT NULL,
  reason TEXT,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bans_identity ON bans(identity_hash);
ALTER TABLE bans ENABLE ROW LEVEL SECURITY;

-- 3. Anonymous Call Logs (session_id strictly omitted to prevent deanonymization)
CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_seconds INTEGER NOT NULL,
  connection_type TEXT NOT NULL CHECK(connection_type IN ('direct', 'relay', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_call_logs_started_at ON call_logs(started_at DESC);
ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;

-- 4. Daily Summaries (Aggregated metrics for pruning & 7-day stats)
CREATE TABLE IF NOT EXISTS daily_summaries (
  date DATE PRIMARY KEY,
  total_calls INTEGER NOT NULL DEFAULT 0,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  direct_calls INTEGER NOT NULL DEFAULT 0,
  relay_calls INTEGER NOT NULL DEFAULT 0,
  unknown_calls INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;

-- 5. Moderation Reports (note capped at 500 chars via CHECK constraint)
CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT CHECK(note IS NULL OR length(note) <= 500),
  reported_account_id TEXT,
  reporter_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reported_account ON reports(reported_account_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_account ON reports(reporter_account_id);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

