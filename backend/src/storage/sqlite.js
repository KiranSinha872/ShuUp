import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Initializes and manages SQLite database connection, schema, and prepared statements.
 */
export function createSqliteDatabase(dbPath = ":memory:", options = {}) {
  const logger = options.logger || console;

  // Ensure parent directory exists for file-backed DBs
  let resolvedPath = null;
  if (dbPath !== ":memory:") {
    resolvedPath = path.resolve(dbPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Set file permissions to owner-only (0600) on file-backed databases
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    try {
      fs.chmodSync(resolvedPath, 0o600);
    } catch (_) {}
  }

  // WAL mode and foreign keys for file-backed databases
  if (dbPath !== ":memory:") {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
    } catch (err) {
      logger.warn("[Storage] Failed to set WAL mode:", err.message);
    }
  }

  // Create tables with strict CHECK constraints
  db.exec(`
    -- 1. Accounts Table (Phase 8a foundation for 7c/7d)
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      google_sub_hash TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role = 'user'),
      created_at TEXT NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub_hash);

    -- 2. Bans Table (Keyed by identity hash; survives account deletion)
    CREATE TABLE IF NOT EXISTS bans (
      id TEXT PRIMARY KEY,
      identity_hash TEXT UNIQUE NOT NULL,
      reason TEXT,
      banned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bans_identity ON bans(identity_hash);

    -- 3. Anonymous Call Logs (session_id omitted to prevent linking to accounts/reports)
    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      connection_type TEXT NOT NULL CHECK(connection_type IN ('direct', 'relay', 'unknown'))
    );

    CREATE INDEX IF NOT EXISTS idx_call_logs_started_at ON call_logs(started_at DESC);

    -- 4. Daily Summaries (Aggregated metrics for pruning & 7-day stats)
    CREATE TABLE IF NOT EXISTS daily_summaries (
      date TEXT PRIMARY KEY,
      total_calls INTEGER NOT NULL DEFAULT 0,
      total_seconds INTEGER NOT NULL DEFAULT 0,
      direct_calls INTEGER NOT NULL DEFAULT 0,
      relay_calls INTEGER NOT NULL DEFAULT 0,
      unknown_calls INTEGER NOT NULL DEFAULT 0
    );

    -- 5. Moderation Reports (note capped at 500 chars via CHECK constraint)
    CREATE TABLE IF NOT EXISTS reports (
      report_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
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
  `);

  // Prepared statements for all queries with bound parameters
  const stmts = {
    insertCallLog: db.prepare(`
      INSERT INTO call_logs (id, started_at, ended_at, duration_seconds, connection_type)
      VALUES (?, ?, ?, ?, ?);
    `),

    insertReport: db.prepare(`
      INSERT INTO reports (report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `),

    insertAccount: db.prepare(`
      INSERT INTO accounts (id, google_sub_hash, role, created_at, email, password_hash)
      VALUES (?, ?, ?, ?, ?, ?);
    `),

    getAccountById: db.prepare(`
      SELECT id, google_sub_hash, role, created_at, email FROM accounts WHERE id = ?;
    `),

    getAccountByGoogleSub: db.prepare(`
      SELECT id, google_sub_hash, role, created_at, email FROM accounts WHERE google_sub_hash = ?;
    `),

    getAccountByEmail: db.prepare(`
      SELECT id, google_sub_hash, role, created_at, email, password_hash FROM accounts WHERE email = ?;
    `),

    deleteAccount: db.prepare(`
      DELETE FROM accounts WHERE id = ?;
    `),

    insertBan: db.prepare(`
      INSERT OR REPLACE INTO bans (id, identity_hash, reason, banned_at)
      VALUES (?, ?, ?, ?);
    `),

    getBanByIdentity: db.prepare(`
      SELECT * FROM bans WHERE identity_hash = ?;
    `),

    deleteBanByIdentity: db.prepare(`
      DELETE FROM bans WHERE identity_hash = ?;
    `),

    clearReporterInReports: db.prepare(`
      UPDATE reports SET reporter_account_id = NULL WHERE reporter_account_id = ?;
    `),

    clearReportedInReports: db.prepare(`
      UPDATE reports SET reported_account_id = NULL WHERE reported_account_id = ?;
    `),

    tombstoneReportedInReports: db.prepare(`
      UPDATE reports SET reported_account_id = ? WHERE reported_account_id = ?;
    `),

    hasOpenReportsForAccount: db.prepare(`
      SELECT 1 FROM reports WHERE reported_account_id = ? AND status = 'pending' LIMIT 1;
    `),

    upsertDailySummary: db.prepare(`
      INSERT INTO daily_summaries (date, total_calls, total_seconds, direct_calls, relay_calls, unknown_calls)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_calls = total_calls + excluded.total_calls,
        total_seconds = total_seconds + excluded.total_seconds,
        direct_calls = direct_calls + excluded.direct_calls,
        relay_calls = relay_calls + excluded.relay_calls,
        unknown_calls = unknown_calls + excluded.unknown_calls;
    `),

    getReportsList: db.prepare(`
      SELECT report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status
      FROM reports
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?;
    `),

    getReportById: db.prepare(`
      SELECT * FROM reports WHERE report_id = ?;
    `),

    updateReportStatus: db.prepare(`
      UPDATE reports SET status = ? WHERE report_id = ?;
    `),

    getAggregatedTotals: db.prepare(`
      SELECT 
        (COALESCE((SELECT SUM(total_calls) FROM daily_summaries), 0) + (SELECT COUNT(*) FROM call_logs)) AS total_calls,
        (COALESCE((SELECT SUM(total_seconds) FROM daily_summaries), 0) + COALESCE((SELECT SUM(duration_seconds) FROM call_logs), 0)) AS total_seconds;
    `),

    getCallsSinceDate: db.prepare(`
      SELECT substr(started_at, 1, 10) as day, COUNT(*) as count, SUM(duration_seconds) as seconds
      FROM call_logs
      WHERE started_at >= ?
      GROUP BY day
      ORDER BY day ASC;
    `),

    getDailySummariesSinceDate: db.prepare(`
      SELECT date as day, total_calls as count, total_seconds as seconds
      FROM daily_summaries
      WHERE date >= ?
      ORDER BY day ASC;
    `),

    getOldestCallLogs: db.prepare(`
      SELECT id, started_at, duration_seconds, connection_type
      FROM call_logs
      WHERE started_at < ?
      LIMIT ?;
    `),

    deleteCallLogsByIds: (ids) => {
      if (!ids.length) return null;
      const placeholders = ids.map(() => "?").join(",");
      return db.prepare(`DELETE FROM call_logs WHERE id IN (${placeholders});`);
    },

    deleteOldNonUrgentReports: db.prepare(`
      DELETE FROM reports
      WHERE created_at < ?
        AND category NOT IN ('urgent_minor_safety', 'urgent_violence_threat')
        AND report_id IN (
          SELECT report_id FROM reports
          WHERE created_at < ?
            AND category NOT IN ('urgent_minor_safety', 'urgent_violence_threat')
          LIMIT ?
        );
    `)
  };

  return {
    db,
    stmts,

    // Batch insert for write queue drain
    batchInsert(items) {
      if (!items || !items.length) return;
      db.exec("BEGIN TRANSACTION;");
      try {
        for (const item of items) {
          if (item.type === "call_log") {
            const { id, startedAt, endedAt, durationSeconds, connectionType } = item.data;
            stmts.insertCallLog.run(
              id || crypto.randomUUID(),
              startedAt,
              endedAt,
              durationSeconds,
              connectionType || "unknown"
            );
          } else if (item.type === "report") {
            const { reportId, createdAt, sessionId, category, note, reportedAccountId, reporterAccountId, status } = item.data;
            stmts.insertReport.run(
              reportId || crypto.randomUUID(),
              createdAt || new Date().toISOString(),
              sessionId,
              category,
              note || null,
              reportedAccountId || null,
              reporterAccountId || null,
              status || "pending"
            );
          }
        }
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
    },

    close() {
      db.close();
    }
  };
}
