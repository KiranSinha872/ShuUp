import crypto from "node:crypto";
import { createSqliteDatabase } from "./sqlite.js";
import { createStorageQueue } from "./queue.js";

/**
 * Creates a high-performance, non-blocking storage adapter.
 */
export function createStorageAdapter(options = {}) {
  const dbPath = options.dbPath || ":memory:";
  const logger = options.logger || console;
  const maxCallLogQueueSize = options.maxCallLogQueueSize || 500;
  const flushIntervalMs = options.flushIntervalMs || 50;

  const sqlite = createSqliteDatabase(dbPath, { logger });
  const queue = createStorageQueue(sqlite, {
    maxCallLogQueueSize,
    flushIntervalMs,
    logger
  });

  return {
    /**
     * Non-blocking call logging. Completely anonymous (no session_id, no account_id, no IPs).
     * Never awaits or throws.
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
      const rows = sqlite.stmts.getReportsList.all(limit, offset);
      // Never expose reporterAccountId to public or non-privileged callers
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
      const r = sqlite.stmts.getReportById.get(reportId);
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
      return sqlite.stmts.updateReportStatus.run(status, reportId);
    },

    /**
     * Accounts management (Phase 8a foundation for 7c/7d).
     */
    createAccount({ id, googleSubHash, role = "user", email = null, passwordHash = null }) {
      const accountId = id || crypto.randomUUID();
      const createdAt = new Date().toISOString();
      sqlite.stmts.insertAccount.run(
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
      return sqlite.stmts.getAccountById.get(id) || null;
    },

    getAccountByGoogleSubHash(googleSubHash) {
      if (!googleSubHash) return null;
      return sqlite.stmts.getAccountByGoogleSub.get(googleSubHash) || null;
    },

    getAccountByEmail(email) {
      if (!email) return null;
      return sqlite.stmts.getAccountByEmail.get(email.toLowerCase()) || null;
    },

    /**
     * Deletes an account with privacy and safety invariants:
     * - Clears reporter_account_id when this account was the reporter.
     * - Replaces reported_account_id with identity tombstone ONLY if user is banned or has open reports.
     *   Otherwise nulls it.
     * - Preserves bans table entry intact.
     */
    deleteAccount(accountId) {
      const account = sqlite.stmts.getAccountById.get(accountId);
      if (!account) return false;

      const identityHash = account.google_sub_hash || accountId;

      sqlite.db.exec("BEGIN TRANSACTION;");
      try {
        // 1. Clear reporter account when this user was the reporter
        sqlite.stmts.clearReporterInReports.run(accountId);

        // 2. Determine whether account is banned or has an open (pending) report
        const hasBan = Boolean(sqlite.stmts.getBanByIdentity.get(identityHash));
        const hasOpenReport = Boolean(sqlite.stmts.hasOpenReportsForAccount.get(accountId));

        if (hasBan || hasOpenReport) {
          // Preserve tombstone with identity hash so ban/incident correlation is not lost
          const tombstone = `tombstone:${identityHash}`;
          sqlite.stmts.tombstoneReportedInReports.run(tombstone, accountId);
        } else {
          // Clean user with no violations: completely null reported reference
          sqlite.stmts.clearReportedInReports.run(accountId);
        }

        // 3. Remove account row (bans table entry remains completely intact)
        sqlite.stmts.deleteAccount.run(accountId);

        sqlite.db.exec("COMMIT;");
        return true;
      } catch (err) {
        sqlite.db.exec("ROLLBACK;");
        throw err;
      }
    },

    /**
     * Bans management (keyed by identity hash; survives account deletion).
     */
    banIdentity({ identityHash, reason = "safety_violation" }) {
      if (!identityHash) return false;
      const id = crypto.randomUUID();
      const bannedAt = new Date().toISOString();
      sqlite.stmts.insertBan.run(id, identityHash, reason, bannedAt);
      return true;
    },

    isIdentityBanned(identityHash) {
      if (!identityHash) return false;
      const ban = sqlite.stmts.getBanByIdentity.get(identityHash);
      return Boolean(ban);
    },

    unbanIdentity(identityHash) {
      if (!identityHash) return false;
      sqlite.stmts.deleteBanByIdentity.run(identityHash);
      return true;
    },

    /**
     * Aggregated metrics for Admin Dashboard (Phase 8b readiness).
     */
    getDashboardStats() {
      const totals = sqlite.stmts.getAggregatedTotals.get();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      // Merge daily summaries with live call logs for last 7 days
      const pastDaily = sqlite.stmts.getDailySummariesSinceDate.all(sevenDaysAgo) || [];
      const recentCalls = sqlite.stmts.getCallsSinceDate.all(sevenDaysAgo) || [];

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
      const cutoffCalls = new Date(Date.now() - callLogDays * 24 * 60 * 60 * 1000).toISOString();
      const cutoffReports = new Date(Date.now() - reportDays * 24 * 60 * 60 * 1000).toISOString();

      let prunedCalls = 0;
      let prunedReports = 0;

      // 1. Chunked atomic prune of call_logs
      while (true) {
        const batch = sqlite.stmts.getOldestCallLogs.all(cutoffCalls, batchSize);
        if (!batch || batch.length === 0) break;

        // Group the batch rows by day for atomic upsert
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

        sqlite.db.exec("BEGIN TRANSACTION;");
        try {
          for (const [day, agg] of dayAgg.entries()) {
            sqlite.stmts.upsertDailySummary.run(day, agg.total, agg.seconds, agg.direct, agg.relay, agg.unknown);
          }
          const ids = batch.map((b) => b.id);
          sqlite.stmts.deleteCallLogsByIds(ids).run(...ids);
          sqlite.db.exec("COMMIT;");
          prunedCalls += batch.length;
        } catch (err) {
          sqlite.db.exec("ROLLBACK;");
          logger.warn("[Storage] Prune chunk transaction failed:", err.message);
          break;
        }

        // Yield to the event loop between batches so signaling/matching never starves
        await new Promise((resolve) => setImmediate(resolve));
      }

      // 2. Chunked prune of non-urgent reports (urgent reports are exempt and remain indefinitely)
      try {
        const info = sqlite.stmts.deleteOldNonUrgentReports.run(cutoffReports, cutoffReports, batchSize);
        prunedReports += info?.changes || 0;
      } catch (err) {
        logger.warn("[Storage] Report prune failed:", err.message);
      }

      return { prunedCalls, prunedReports };
    },

    getQueueStats() {
      return queue.getStats();
    },

    flushQueue() {
      return queue.flush();
    },

    async close({ timeoutMs = 2000 } = {}) {
      await queue.drain({ timeoutMs });
      sqlite.close();
    }
  };
}
