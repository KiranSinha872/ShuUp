/**
 * Split write queues for non-blocking persistence.
 * - callLogQueue: bounded with oldest-dropped overflow policy under high backpressure.
 * - reportQueue: high-priority safety queue that is NEVER dropped, retrying with backoff.
 */
export function createStorageQueue(database, options = {}) {
  const maxCallLogQueueSize = options.maxCallLogQueueSize || 500;
  const flushIntervalMs = options.flushIntervalMs || 50;
  const maxCallLogRetries = options.maxCallLogRetries || 3;
  const logger = options.logger || console;

  let callLogQueue = [];
  let reportQueue = [];
  let isFlushing = false;
  let timer = null;
  let isClosed = false;
  let consecutiveReportFailures = 0;

  const stats = {
    pendingCallLogs: 0,
    pendingReports: 0,
    totalQueuedCallLogs: 0,
    totalQueuedReports: 0,
    totalFlushed: 0,
    droppedCallLogs: 0,
    writeErrors: 0
  };

  function enqueue(type, data) {
    if (isClosed) {
      if (type === "report") {
        // Even when closing, hold reports in memory for shutdown flush
        reportQueue.push({ type, data, retries: 0 });
        stats.pendingReports = reportQueue.length;
        return true;
      }
      stats.droppedCallLogs += 1;
      return false;
    }

    if (type === "report") {
      // Safety critical: Reports queue NEVER drops items
      reportQueue.push({
        type,
        data,
        retries: 0,
        enqueuedAt: Date.now()
      });
      stats.totalQueuedReports += 1;
      stats.pendingReports = reportQueue.length;
    } else {
      // Call logs: Bounded queue with oldest-eviction under extreme load
      if (callLogQueue.length >= maxCallLogQueueSize) {
        callLogQueue.shift();
        stats.droppedCallLogs += 1;
        // Counter only, zero sensitive data
        logger.warn(`[StorageQueue] Call log queue capacity reached; 1 oldest call log dropped (total dropped: ${stats.droppedCallLogs})`);
      }

      callLogQueue.push({
        type,
        data,
        retries: 0,
        enqueuedAt: Date.now()
      });
      stats.totalQueuedCallLogs += 1;
      stats.pendingCallLogs = callLogQueue.length;
    }

    if (!timer && !isFlushing) {
      scheduleFlush(flushIntervalMs);
    }

    return true;
  }

  function scheduleFlush(delayMs) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush().catch((err) => {
        logger.warn("[StorageQueue] Background flush error:", err.message);
      });
    }, delayMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  async function flush() {
    if (isFlushing || (reportQueue.length === 0 && callLogQueue.length === 0)) return;
    isFlushing = true;

    // Prioritize reports: always drain all pending reports first, then batch call logs
    const reportsToFlush = reportQueue.slice(0, 50);
    const callLogsToFlush = callLogQueue.slice(0, 50);
    const batch = [...reportsToFlush, ...callLogsToFlush];

    if (batch.length === 0) {
      isFlushing = false;
      return;
    }

    try {
      await database.batchInsert(batch);

      // Successfully written: remove from respective queues
      if (reportsToFlush.length > 0) {
        reportQueue.splice(0, reportsToFlush.length);
        consecutiveReportFailures = 0;
      }
      if (callLogsToFlush.length > 0) {
        callLogQueue.splice(0, callLogsToFlush.length);
      }

      stats.totalFlushed += batch.length;
    } catch (err) {
      stats.writeErrors += 1;
      logger.warn("[StorageQueue] Database batch write error (counter incremented):", err.message);

      // 1. Reports: Increment retry count, NEVER DROP. Reschedule with backoff delay.
      if (reportsToFlush.length > 0) {
        consecutiveReportFailures += 1;
        for (const item of reportsToFlush) {
          item.retries += 1;
        }
      }

      // 2. Call logs: Drop if retry threshold exceeded
      if (callLogsToFlush.length > 0) {
        for (const item of callLogsToFlush) {
          item.retries += 1;
        }
        const failingCallLogs = callLogsToFlush.filter((item) => item.retries > maxCallLogRetries);
        if (failingCallLogs.length > 0) {
          callLogQueue = callLogQueue.filter((item) => item.retries <= maxCallLogRetries);
          stats.droppedCallLogs += failingCallLogs.length;
          logger.warn(`[StorageQueue] Dropped ${failingCallLogs.length} call logs after ${maxCallLogRetries} failed attempts`);
        }
      }

      // Schedule next flush with backoff delay (500ms, 1s, 2s, up to 5s max)
      const backoffMs = Math.min(500 * Math.pow(2, consecutiveReportFailures), 5000);
      scheduleFlush(backoffMs);
      return;
    } finally {
      isFlushing = false;
      stats.pendingReports = reportQueue.length;
      stats.pendingCallLogs = callLogQueue.length;

      // If more items remain and no error occurred, drain immediately
      if ((reportQueue.length > 0 || callLogQueue.length > 0) && !timer && !isClosed) {
        scheduleFlush(10);
      }
    }
  }

  async function drain({ timeoutMs = 2000 } = {}) {
    isClosed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    const start = Date.now();
    while (reportQueue.length > 0 || callLogQueue.length > 0) {
      if (Date.now() - start > timeoutMs) {
        logger.warn(`[StorageQueue] Drain timeout reached with ${reportQueue.length} reports and ${callLogQueue.length} call logs pending`);
        break;
      }
      const prevTotal = reportQueue.length + callLogQueue.length;
      await flush();
      if (reportQueue.length + callLogQueue.length === prevTotal) {
        // Still failing, wait briefly before next attempt within timeout
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  return {
    enqueue,
    flush,
    drain,
    getStats: () => ({
      ...stats,
      pendingWrites: reportQueue.length + callLogQueue.length,
      pendingReports: reportQueue.length,
      pendingCallLogs: callLogQueue.length
    })
  };
}
