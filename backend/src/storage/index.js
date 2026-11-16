import crypto from "node:crypto";
import { createSqliteDatabase } from "./sqlite.js";
import { createPostgresDatabase } from "./postgres.js";
import { createStorageQueue } from "./queue.js";
import { SUPABASE_DB_URL, STORAGE_BACKEND, NODE_ENV } from "../config.js";

/**
 * Creates a high-performance, non-blocking storage adapter.
 * Supports Supabase PostgreSQL (production & connection pooling) and local SQLite (development/tests).
 */
export function createStorageAdapter(options = {}) {
  const logger = options.logger || console;
  const maxCallLogQueueSize = options.maxCallLogQueueSize || 500;
  const flushIntervalMs = options.flushIntervalMs || 50;

  // Determine backend: explicit option > SUPABASE_DB_URL presence > STORAGE_BACKEND config
  let backend = options.backend;
  if (!backend) {
    if (options.supabaseDbUrl || (STORAGE_BACKEND === "postgres") || (SUPABASE_DB_URL && NODE_ENV === "production")) {
      backend = "postgres";
    } else {
      backend = STORAGE_BACKEND || "sqlite";
    }
  }

  // Enforce no silent fallback to SQLite in production
  if (NODE_ENV === "production" && backend === "sqlite") {
    throw new Error(
      "Configuration error: SQLite storage backend is not permitted in production environment. Configure SUPABASE_DB_URL."
    );
  }

  let dbDriver = null;
  const isPostgres = backend === "postgres";

  if (isPostgres) {
    const connectionString = options.supabaseDbUrl || SUPABASE_DB_URL;
    if (!connectionString && !options.pool) {
      throw new Error(
        "Configuration error: SUPABASE_DB_URL (or DATABASE_URL) is required for postgres storage backend."
      );
    }
    dbDriver = createPostgresDatabase(connectionString, {
      logger,
      pool: options.pool,
      ssl: options.ssl
    });
  } else {
    const dbPath = options.dbPath || ":memory:";
    dbDriver = createSqliteDatabase(dbPath, { logger });
  }

  const queue = createStorageQueue(dbDriver, {
    maxCallLogQueueSize,
    flushIntervalMs,
    logger
  });

  return {
    backend,
    isPostgres,
    db: dbDriver,

    async initSchema() {
      if (isPostgres && typeof dbDriver.initSchema === "function") {
        await dbDriver.initSchema();
      }
    },

    /**
     * Non-blocking call logging. Completely anonymous (no session_id, no account_id, no IPs).
     * Never awaits or throws inside hot matching path.
     */
    logCall({ startedAt, endedAt, durationSeconds, connectionType }) {
      if (!startedAt || !endedAt) return;
      const data = {
        id: crypto.randomUUID(),
        startedAt,
        endedAt,
        durationSeconds: Math.max(0, Math.round(durationSeconds || 0)),
        connectionType: ["direct", "relay", "unknown"].includes(connectionType) ? connectionType : "unknown"
      };
      queue.enqueue("call_log", data);
    },

    /**
     * Non-blocking report persistence. Never dropped under queue overflow.
     */
    saveReport({ reportId, createdAt, sessionId, category, note, reportedAccountId, reporterAccountId, status = "pending" }) {
      if (!sessionId || !category) return;
      const data = {
        reportId: reportId || crypto.randomUUID(),
        createdAt: createdAt || new Date().toISOString(),
        sessionId,
        category,
        note: note ? String(note).slice(0, 500) : null,
        reportedAccountId: reportedAccountId || null,
        reporterAccountId: reporterAccountId || null,
        status
      };
      queue.enqueue("report", data);
    },

    /**
     * Read reports for moderation/admin.
     */
    getReports({ limit = 50, offset = 0 } = {}) {
      if (isPostgres) {
        return dbDriver.getReports({ limit, offset });
      }
      const rows = dbDriver.stmts.getReportsList.all(limit, offset);
      return rows.map((r) => ({
        reportId: r.report_id,
        createdAt: r.created_at,
        sessionId: r.session_id,
        category: r.category,
        note: r.note,
        reportedAccountId: r.reported_account_id,
        status: r.status
      }));
    },

    getReportById(reportId) {
      if (isPostgres) {
        return dbDriver.getReportById(reportId);
      }
      const r = dbDriver.stmts.getReportById.get(reportId);
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

    updateReportStatus(reportId, status) {
      if (isPostgres) {
        return dbDriver.updateReportStatus(reportId, status);
      }
      return dbDriver.stmts.updateReportStatus.run(status, reportId);
    },

    /**
     * Accounts management (Phase 8a foundation for 7c/7d).
     */
    createAccount({ id, googleSubHash, role = "user", email = null, passwordHash = null }) {
      if (isPostgres) {
        return dbDriver.createAccount({ id, googleSubHash, role, email, passwordHash });
      }
      const accountId = id || crypto.randomUUID();
      const createdAt = new Date().toISOString();
      dbDriver.stmts.insertAccount.run(
        accountId,
        googleSubHash || null,
        role,
        createdAt,
        email || null,
        passwordHash || null
      );
      return { id: accountId, googleSubHash, role, createdAt, email };
    },

    getAccountById(id) {
      if (isPostgres) {
        return dbDriver.getAccountById(id);
      }
      return dbDriver.stmts.getAccountById.get(id) || null;
    },

    getAccountByGoogleSubHash(googleSubHash) {
      if (!googleSubHash) return null;
      if (isPostgres) {
        return dbDriver.getAccountByGoogleSubHash(googleSubHash);
      }
      return dbDriver.stmts.getAccountByGoogleSub.get(googleSubHash) || null;
    },

    getAccountByEmail(email) {
      if (!email) return null;
      if (isPostgres) {
        return dbDriver.getAccountByEmail(email);
      }
      return dbDriver.stmts.getAccountByEmail.get(email.toLowerCase()) || null;
    },

    /**
     * Deletes an account with privacy and safety invariants:
     * - Clears reporter_account_id when this account was the reporter.
     * - Replaces reported_account_id with identity tombstone ONLY if user is banned or has open reports.
     *   Otherwise nulls it.
     * - Preserves bans table entry intact.
     */
    deleteAccount(accountId) {
      if (isPostgres) {
        return dbDriver.deleteAccount(accountId);
      }
      const account = dbDriver.stmts.getAccountById.get(accountId);
      if (!account) return false;

      const identityHash = account.google_sub_hash || accountId;

      dbDriver.db.exec("BEGIN TRANSACTION;");
      try {
        dbDriver.stmts.clearReporterInReports.run(accountId);

        const hasBan = Boolean(dbDriver.stmts.getBanByIdentity.get(identityHash));
        const hasOpenReport = Boolean(dbDriver.stmts.hasOpenReportsForAccount.get(accountId));

        if (hasBan || hasOpenReport) {
          const tombstone = `tombstone:${identityHash}`;
          dbDriver.stmts.tombstoneReportedInReports.run(tombstone, accountId);
        } else {
          dbDriver.stmts.clearReportedInReports.run(accountId);
        }

        dbDriver.stmts.deleteAccount.run(accountId);
        dbDriver.db.exec("COMMIT;");
        return true;
      } catch (err) {
        dbDriver.db.exec("ROLLBACK;");
        throw err;
      }
    },

    /**
     * Bans management (keyed by identity hash; survives account deletion).
     */
    banIdentity({ identityHash, reason = "safety_violation" }) {
      if (!identityHash) return false;
      if (isPostgres) {
        return dbDriver.banIdentity({ identityHash, reason });
      }
      const id = crypto.randomUUID();
      const bannedAt = new Date().toISOString();
      dbDriver.stmts.insertBan.run(id, identityHash, reason, bannedAt);
      return true;
    },

    isIdentityBanned(identityHash) {
      if (!identityHash) return false;
      if (isPostgres) {
        return dbDriver.isIdentityBanned(identityHash);
      }
      const ban = dbDriver.stmts.getBanByIdentity.get(identityHash);
      return Boolean(ban);
    },

    unbanIdentity(identityHash) {
      if (!identityHash) return false;
      if (isPostgres) {
        return dbDriver.unbanIdentity(identityHash);
      }
      dbDriver.stmts.deleteBanByIdentity.run(identityHash);
      return true;
    },

    /**
     * Aggregated metrics for Admin Dashboard (Phase 8b readiness).
     */
    getDashboardStats() {
      if (isPostgres) {
        return dbDriver.getDashboardStats();
      }
      const totals = dbDriver.stmts.getAggregatedTotals.get();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const pastDaily = dbDriver.stmts.getDailySummariesSinceDate.all(sevenDaysAgo) || [];
      const recentCalls = dbDriver.stmts.getCallsSinceDate.all(sevenDaysAgo) || [];

      const dailyMap = new Map();
      for (const row of pastDaily) {
        dailyMap.set(row.day, { calls: Number(row.count) || 0, seconds: Number(row.seconds) || 0 });
      }
      for (const row of recentCalls) {
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

    /**
     * Pruning job: Aggregates raw call logs older than `callLogDays` into daily_summaries,
     * then deletes raw logs in exact atomic batches with event loop yields.
     */
    async pruneOldData({ callLogDays = 90, reportDays = 90, batchSize = 500 } = {}) {
      if (isPostgres) {
        return await dbDriver.pruneOldData({ callLogDays, reportDays, batchSize });
      }

      const cutoffCalls = new Date(Date.now() - callLogDays * 24 * 60 * 60 * 1000).toISOString();
      const cutoffReports = new Date(Date.now() - reportDays * 24 * 60 * 60 * 1000).toISOString();

      let prunedCalls = 0;
      let prunedReports = 0;

      while (true) {
        const batch = dbDriver.stmts.getOldestCallLogs.all(cutoffCalls, batchSize);
        if (!batch || batch.length === 0) break;

        const dayAgg = new Map();
        for (const log of batch) {
          const day = log.started_at.slice(0, 10);
          const agg = dayAgg.get(day) || { total: 0, seconds: 0, direct: 0, relay: 0, unknown: 0 };
          agg.total += 1;
          agg.seconds += log.duration_seconds || 0;
          if (log.connection_type === "direct") agg.direct += 1;
          else if (log.connection_type === "relay") agg.relay += 1;
          else agg.unknown += 1;
          dayAgg.set(day, agg);
        }

        dbDriver.db.exec("BEGIN TRANSACTION;");
        try {
          for (const [day, agg] of dayAgg.entries()) {
            dbDriver.stmts.upsertDailySummary.run(day, agg.total, agg.seconds, agg.direct, agg.relay, agg.unknown);
          }
          const ids = batch.map((b) => b.id);
          dbDriver.stmts.deleteCallLogsByIds(ids).run(...ids);
          dbDriver.db.exec("COMMIT;");
          prunedCalls += batch.length;
        } catch (err) {
          dbDriver.db.exec("ROLLBACK;");
          logger.warn("[Storage] Prune chunk transaction failed:", err.message);
          break;
        }

        await new Promise((resolve) => setImmediate(resolve));
      }

      try {
        const info = dbDriver.stmts.deleteOldNonUrgentReports.run(cutoffReports, cutoffReports, batchSize);
        prunedReports += info?.changes || 0;
      } catch (err) {
        logger.warn("[Storage] Report prune failed:", err.message);
      }

      return { prunedCalls, prunedReports };
    },

    getQueueStats() {
      return queue.getStats();
    },

    async flushQueue() {
      return await queue.flush();
    },

    async close({ timeoutMs = 2000 } = {}) {
      await queue.drain({ timeoutMs });
      if (isPostgres) {
        await dbDriver.close();
      } else {
        dbDriver.close();
      }
    }
  };
}
