import crypto from "node:crypto";
import pg from "pg";
const { Pool } = pg;

export const POSTGRES_SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    identity_hash TEXT UNIQUE NOT NULL,
    reason TEXT,
    banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_bans_identity ON bans(identity_hash);
  ALTER TABLE bans ENABLE ROW LEVEL SECURITY;

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL,
    connection_type TEXT NOT NULL CHECK(connection_type IN ('direct', 'relay', 'unknown'))
  );

  CREATE INDEX IF NOT EXISTS idx_call_logs_started_at ON call_logs(started_at DESC);
  ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;

  CREATE TABLE IF NOT EXISTS daily_summaries (
    date DATE PRIMARY KEY,
    total_calls INTEGER NOT NULL DEFAULT 0,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    direct_calls INTEGER NOT NULL DEFAULT 0,
    relay_calls INTEGER NOT NULL DEFAULT 0,
    unknown_calls INTEGER NOT NULL DEFAULT 0
  );

  ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;

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
`;

/**
 * Initializes and manages PostgreSQL database connection pool, schema, and queries.
 * Suitable for Supabase transaction/session poolers.
 */
export function createPostgresDatabase(connectionString, options = {}) {
  const logger = options.logger || console;

  // Determine SSL settings: Supabase requires SSL
  const sslConfig = options.ssl !== undefined
    ? options.ssl
    : (connectionString.includes("localhost") || connectionString.includes("127.0.0.1"))
      ? false
      : { rejectUnauthorized: false };

  const pool = options.pool || new Pool({
    connectionString,
    ssl: sslConfig,
    max: options.maxPoolSize || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  pool.on("error", (err) => {
    logger.warn("[Postgres] Unexpected client error in connection pool:", err.message);
  });

  return {
    pool,

    async initSchema() {
      const client = await pool.connect();
      try {
        await client.query(POSTGRES_SCHEMA_SQL);
      } finally {
        client.release();
      }
    },

    async batchInsert(items) {
      if (!items || !items.length) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");
        for (const item of items) {
          if (item.type === "call_log") {
            const { id, startedAt, endedAt, durationSeconds, connectionType } = item.data;
            await client.query(
              `INSERT INTO call_logs (id, started_at, ended_at, duration_seconds, connection_type)
               VALUES ($1, $2, $3, $4, $5);`,
              [
                id || crypto.randomUUID(),
                startedAt,
                endedAt,
                durationSeconds,
                connectionType || "unknown"
              ]
            );
          } else if (item.type === "report") {
            const { reportId, createdAt, sessionId, category, note, reportedAccountId, reporterAccountId, status } = item.data;
            await client.query(
              `INSERT INTO reports (report_id, created_at, session_id, category, note, reported_account_id, reporter_account_id, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
              [
                reportId || crypto.randomUUID(),
                createdAt || new Date().toISOString(),
                sessionId,
                category,
                note || null,
                reportedAccountId || null,
                reporterAccountId || null,
                status || "pending"
              ]
            );
          }
        }
        await client.query("COMMIT;");
      } catch (err) {
        await client.query("ROLLBACK;");
        throw err;
      } finally {
        client.release();
      }
    },

    async createAccount({ id, googleSubHash, role = "user", email = null, passwordHash = null, createdAt }) {
      const accountId = id || crypto.randomUUID();
      const timestamp = createdAt || new Date().toISOString();
      await pool.query(
        `INSERT INTO accounts (id, google_sub_hash, role, created_at, email, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [accountId, googleSubHash || null, role, timestamp, email || null, passwordHash || null]
      );
      return { id: accountId, googleSubHash, role, createdAt: timestamp, email };
    },

    async getAccountById(id) {
      const res = await pool.query(
        `SELECT id, google_sub_hash, role, created_at, email FROM accounts WHERE id = $1;`,
        [id]
      );
      return res.rows[0] || null;
    },

    async getAccountByGoogleSubHash(googleSubHash) {
      if (!googleSubHash) return null;
      const res = await pool.query(
        `SELECT id, google_sub_hash, role, created_at, email FROM accounts WHERE google_sub_hash = $1;`,
        [googleSubHash]
      );
      return res.rows[0] || null;
    },

    async getAccountByEmail(email) {
      if (!email) return null;
      const res = await pool.query(
        `SELECT id, google_sub_hash, role, created_at, email, password_hash FROM accounts WHERE email = $1;`,
        [email.toLowerCase()]
      );
      return res.rows[0] || null;
    },

    async deleteAccount(accountId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN;");

        const accountRes = await client.query(
          `SELECT id, google_sub_hash FROM accounts WHERE id = $1;`,
          [accountId]
        );
        const account = accountRes.rows[0];
        if (!account) {
          await client.query("ROLLBACK;");
          return false;
        }

        const identityHash = account.google_sub_hash || accountId;

        // 1. Clear reporter account when this user was the reporter
        await client.query(
          `UPDATE reports SET reporter_account_id = NULL WHERE reporter_account_id = $1;`,
          [accountId]
        );

        // 2. Determine whether account is banned or has an open (pending) report
        const banRes = await client.query(
          `SELECT 1 FROM bans WHERE identity_hash = $1 LIMIT 1;`,
          [identityHash]
        );
        const reportRes = await client.query(
          `SELECT 1 FROM reports WHERE reported_account_id = $1 AND status = 'pending' LIMIT 1;`,
          [accountId]
        );

        const hasBan = banRes.rows.length > 0;
        const hasOpenReport = reportRes.rows.length > 0;

        if (hasBan || hasOpenReport) {
          const tombstone = `tombstone:${identityHash}`;
          await client.query(
            `UPDATE reports SET reported_account_id = $1 WHERE reported_account_id = $2;`,
            [tombstone, accountId]
          );
        } else {
          await client.query(
            `UPDATE reports SET reported_account_id = NULL WHERE reported_account_id = $1;`,
            [accountId]
          );
        }

        // 3. Remove account row (bans table entry remains completely intact)
        await client.query(
          `DELETE FROM accounts WHERE id = $1;`,
          [accountId]
        );

        await client.query("COMMIT;");
        return true;
      } catch (err) {
        await client.query("ROLLBACK;");
        throw err;
      } finally {
        client.release();
      }
    },

    async banIdentity({ identityHash, reason = "safety_violation" }) {
      if (!identityHash) return false;
      const id = crypto.randomUUID();
      const bannedAt = new Date().toISOString();
      await pool.query(
        `INSERT INTO bans (id, identity_hash, reason, banned_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (identity_hash) DO UPDATE SET reason = EXCLUDED.reason, banned_at = EXCLUDED.banned_at;`,
        [id, identityHash, reason, bannedAt]
      );
      return true;
    },

    async isIdentityBanned(identityHash) {
      if (!identityHash) return false;
      const res = await pool.query(
        `SELECT 1 FROM bans WHERE identity_hash = $1 LIMIT 1;`,
        [identityHash]
      );
      return res.rows.length > 0;
    },

    async unbanIdentity(identityHash) {
      if (!identityHash) return false;
      await pool.query(
        `DELETE FROM bans WHERE identity_hash = $1;`,
        [identityHash]
      );
      return true;
    },

    async getReports({ limit = 50, offset = 0 } = {}) {
      const res = await pool.query(
        `SELECT report_id, created_at, session_id, category, note, reported_account_id, status
         FROM reports
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2;`,
        [limit, offset]
      );
      return res.rows.map((r) => ({
        reportId: r.report_id,
        createdAt: r.created_at,
        sessionId: r.session_id,
        category: r.category,
        note: r.note,
        reportedAccountId: r.reported_account_id,
        status: r.status
      }));
    },

    async getReportById(reportId) {
      const res = await pool.query(
        `SELECT * FROM reports WHERE report_id = $1;`,
        [reportId]
      );
      const r = res.rows[0];
      if (!r) return null;
      return {
        reportId: r.report_id,
        createdAt: r.created_at,
        sessionId: r.session_id,
        category: r.category,
        note: r.note,
        reportedAccountId: r.reported_account_id,
        reporterAccountId: r.reporter_account_id,
        status: r.status
      };
    },

    async updateReportStatus(reportId, status) {
      const res = await pool.query(
        `UPDATE reports SET status = $1 WHERE report_id = $2;`,
        [status, reportId]
      );
      return { changes: res.rowCount };
    },

    async getDashboardStats() {
      const totalsRes = await pool.query(`
        SELECT 
          (COALESCE((SELECT SUM(total_calls) FROM daily_summaries), 0) + (SELECT COUNT(*) FROM call_logs))::bigint AS total_calls,
          (COALESCE((SELECT SUM(total_seconds) FROM daily_summaries), 0) + COALESCE((SELECT SUM(duration_seconds) FROM call_logs), 0))::bigint AS total_seconds;
      `);
      const totals = totalsRes.rows[0];

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const pastDailyRes = await pool.query(
        `SELECT date::text as day, total_calls as count, total_seconds as seconds
         FROM daily_summaries
         WHERE date >= $1
         ORDER BY day ASC;`,
        [sevenDaysAgo]
      );

      const recentCallsRes = await pool.query(
        `SELECT started_at::date::text as day, COUNT(*)::bigint as count, SUM(duration_seconds)::bigint as seconds
         FROM call_logs
         WHERE started_at >= $1
         GROUP BY day
         ORDER BY day ASC;`,
        [sevenDaysAgo]
      );

      const dailyMap = new Map();
      for (const row of pastDailyRes.rows) {
        dailyMap.set(row.day, { calls: Number(row.count) || 0, seconds: Number(row.seconds) || 0 });
      }
      for (const row of recentCallsRes.rows) {
        const cur = dailyMap.get(row.day) || { calls: 0, seconds: 0 };
        cur.calls += Number(row.count) || 0;
        cur.seconds += Number(row.seconds) || 0;
        dailyMap.set(row.day, cur);
      }

      const callsPerDay = Array.from(dailyMap.entries())
        .map(([day, val]) => ({ day, calls: val.calls, minutes: Math.round(val.seconds / 60) }))
        .sort((a, b) => a.day.localeCompare(b.day));

      return {
        totalCalls: Number(totals?.total_calls) || 0,
        totalMinutes: Math.round((Number(totals?.total_seconds) || 0) / 60),
        callsPerDay
      };
    },

    async pruneOldData({ callLogDays = 90, reportDays = 90, batchSize = 500 } = {}) {
      const cutoffCalls = new Date(Date.now() - callLogDays * 24 * 60 * 60 * 1000).toISOString();
      const cutoffReports = new Date(Date.now() - reportDays * 24 * 60 * 60 * 1000).toISOString();

      let prunedCalls = 0;
      let prunedReports = 0;

      while (true) {
        const batchRes = await pool.query(
          `SELECT id, started_at::date::text as day, duration_seconds, connection_type
           FROM call_logs
           WHERE started_at < $1
           LIMIT $2;`,
          [cutoffCalls, batchSize]
        );
        const batch = batchRes.rows;
        if (!batch || batch.length === 0) break;

        const dayAgg = new Map();
        for (const log of batch) {
          const day = log.day;
          const agg = dayAgg.get(day) || { total: 0, seconds: 0, direct: 0, relay: 0, unknown: 0 };
          agg.total += 1;
          agg.seconds += Number(log.duration_seconds) || 0;
          if (log.connection_type === "direct") agg.direct += 1;
          else if (log.connection_type === "relay") agg.relay += 1;
          else agg.unknown += 1;
          dayAgg.set(day, agg);
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN;");
          for (const [day, agg] of dayAgg.entries()) {
            await client.query(
              `INSERT INTO daily_summaries (date, total_calls, total_seconds, direct_calls, relay_calls, unknown_calls)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT(date) DO UPDATE SET
                 total_calls = daily_summaries.total_calls + EXCLUDED.total_calls,
                 total_seconds = daily_summaries.total_seconds + EXCLUDED.total_seconds,
                 direct_calls = daily_summaries.direct_calls + EXCLUDED.direct_calls,
                 relay_calls = daily_summaries.relay_calls + EXCLUDED.relay_calls,
                 unknown_calls = daily_summaries.unknown_calls + EXCLUDED.unknown_calls;`,
              [day, agg.total, agg.seconds, agg.direct, agg.relay, agg.unknown]
            );
          }
          const ids = batch.map((b) => b.id);
          await client.query(
            `DELETE FROM call_logs WHERE id = ANY($1::text[]);`,
            [ids]
          );
          await client.query("COMMIT;");
          prunedCalls += batch.length;
        } catch (err) {
          await client.query("ROLLBACK;");
          logger.warn("[Postgres] Prune chunk transaction failed:", err.message);
          break;
        } finally {
          client.release();
        }

        await new Promise((resolve) => setImmediate(resolve));
      }

      try {
        const reportRes = await pool.query(
          `DELETE FROM reports
           WHERE report_id IN (
             SELECT report_id FROM reports
             WHERE created_at < $1
               AND category NOT IN ('urgent_minor_safety', 'urgent_violence_threat')
             LIMIT $2
           );`,
          [cutoffReports, batchSize]
        );
        prunedReports += reportRes.rowCount || 0;
      } catch (err) {
        logger.warn("[Postgres] Report prune failed:", err.message);
      }

      return { prunedCalls, prunedReports };
    },

    async close() {
      await pool.end();
    }
  };
}

