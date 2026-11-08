import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  INVITE_CODES,
  SERVER_SALT,
  REQUIRE_INVITE,
  TRUST_PROXY,
  MAX_SOCKETS_PER_ADDRESS,
  MAX_TOTAL_CONNECTIONS,
  BANNED_TOKENS,
  INVITE_LOCKOUT_ATTEMPTS,
  INVITE_LOCKOUT_MS,
  INVITE_ADDRESS_LOCKOUT_ATTEMPTS,
  MAX_TRACKED_LOCKOUTS,
  GRACE_PERIOD_MS,
  BLOCK_TTL_MS,
  MAX_BLOCKS_PER_USER,
  COOLDOWN_REPORT_THRESHOLD,
  COOLDOWN_WINDOW_MS,
  COOLDOWN_DURATION_MS,
  REPORTS_FILE_PATH,
  MAX_REPORTS_FILE_SIZE_BYTES
} from "./config.js";

export const REPORT_CATEGORIES = Object.freeze([
  "urgent_minor_safety",
  "urgent_violence_threat",
  "nudity_sexual_content",
  "harassment_hate",
  "spam_bot"
]);

export function hashToken(clientToken, salt = SERVER_SALT) {
  if (!clientToken || typeof clientToken !== "string") return null;
  return crypto.createHmac("sha256", salt).update(clientToken.trim()).digest("hex");
}

/**
 * Constant-time comparison of candidate invite code against all configured codes.
 * Computes fixed-length SHA-256 digests and checks all entries without early exit.
 */
export function validateInviteCode(candidate, inviteCodes = INVITE_CODES) {
  if (!candidate || typeof candidate !== "string" || !Array.isArray(inviteCodes) || inviteCodes.length === 0) {
    return false;
  }
  const trimmed = candidate.trim();
  const candDigest = crypto.createHash("sha256").update(trimmed).digest();
  let matched = false;

  for (const validCode of inviteCodes) {
    if (typeof validCode !== "string") continue;
    const targetDigest = crypto.createHash("sha256").update(validCode.trim()).digest();
    if (crypto.timingSafeEqual(candDigest, targetDigest)) {
      matched = true;
    }
  }
  return matched;
}

export function resolveClientAddress(handshake, trustProxy = TRUST_PROXY) {
  if (trustProxy && handshake && handshake.headers) {
    const forwarded = handshake.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0].trim();
    }
  }
  return (handshake && (handshake.address || (handshake.conn && handshake.conn.remoteAddress))) || "127.0.0.1";
}

export function sanitizeNote(note) {
  if (!note || typeof note !== "string") return "";
  // Strip control characters (ASCII 0-31 and 127) to prevent log injection or formatting attacks
  return note.replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, 200);
}

/**
 * Token Bucket implementation for per-event-type and overall rate limiting.
 */
export class TokenBucket {
  constructor(capacity, refillRatePerSec, timeProvider = () => Date.now()) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSec;
    this.timeProvider = timeProvider;
    this.lastRefill = this.timeProvider();
  }

  refill() {
    const now = this.timeProvider();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
      this.lastRefill = now;
    }
  }

  consume(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}

/**
 * Sets key/value in Map enforcing an upper bound via oldest-key eviction (LRU).
 */
export function setWithCap(map, key, value, maxCap) {
  if (map.size >= maxCap && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * Creates the Safety and Abuse Control manager.
 */
export function createSafetyManager(options = {}) {
  const timeProvider = options.timeProvider || (() => Date.now());
  const reportsFilePath = options.reportsFilePath || REPORTS_FILE_PATH;
  const maxReportsFileSize = options.maxReportsFileSize ?? MAX_REPORTS_FILE_SIZE_BYTES;
  const bannedTokens = new Set(options.bannedTokens ?? BANNED_TOKENS);
  const logger = options.logger ?? console;

  const inviteLockoutMs = options.inviteLockoutMs ?? INVITE_LOCKOUT_MS;
  const inviteLockoutAttempts = options.inviteLockoutAttempts ?? INVITE_LOCKOUT_ATTEMPTS;
  const inviteAddressLockoutAttempts = options.inviteAddressLockoutAttempts ?? INVITE_ADDRESS_LOCKOUT_ATTEMPTS;
  const maxTrackedLockouts = options.maxTrackedLockouts ?? MAX_TRACKED_LOCKOUTS;
  const maxTrackedAddressLockouts = options.maxTrackedAddressLockouts ?? MAX_TRACKED_LOCKOUTS;
  const maxTrackedBlockers = options.maxTrackedBlockers ?? 5_000;
  const maxTrackedSessionReports = options.maxTrackedSessionReports ?? 10_000;
  const maxTrackedPairings = options.maxTrackedPairings ?? 10_000;
  const maxTrackedTallies = options.maxTrackedTallies ?? 5_000;
  const maxTrackedCooldowns = options.maxTrackedCooldowns ?? 5_000;

  // In-memory token lockout: Map<"address:clientToken", { attempts: number, lockedUntil: number, firstAttempt: number }>
  const lockouts = new Map();

  // In-memory address lockout: Map<address, { attempts: number, lockedUntil: number, firstAttempt: number }>
  const addressLockouts = new Map();

  // In-memory connection counts: Map<address, count>
  const addressConnections = new Map();
  let totalConnections = 0;

  // Last-partner grace records: Map<socketId, { sessionId: string, partnerHashedToken: string, expiresAt: number }>
  const graceRecords = new Map();

  // User blocks: Map<blockerHashedToken, Map<blockedHashedToken, expiresAt>>
  const userBlocks = new Map();

  // Session report history: Map<"sessionId:reporterHashedToken", boolean>
  const sessionReports = new Map();

  // Reporter verification: Map<"reporterHashedToken:reportedHashedToken", true>
  const verifiedPairings = new Map();

  // User report counts for cooldown: Map<reportedHashedToken, Map<reporterHashedToken, timestamp>>
  const userReportTallies = new Map();

  // Active cooldowns: Map<reportedHashedToken, expiresAt>
  const cooldowns = new Map();

  function isTokenLockedOut(address, clientToken) {
    const key = `${address}:${clientToken}`;
    const entry = lockouts.get(key);
    if (!entry) return false;
    const now = timeProvider();
    if (now < entry.lockedUntil) {
      return true;
    }
    if (entry.lockedUntil > 0 && now >= entry.lockedUntil) {
      lockouts.delete(key);
      return false;
    }
    return false;
  }

  function isAddressLockedOut(address) {
    const entry = addressLockouts.get(address);
    if (!entry) return false;
    const now = timeProvider();
    if (now < entry.lockedUntil) {
      return true;
    }
    if (entry.lockedUntil > 0 && now >= entry.lockedUntil) {
      addressLockouts.delete(address);
      return false;
    }
    return false;
  }

  function isLockedOut(address, clientToken) {
    return isAddressLockedOut(address) || isTokenLockedOut(address, clientToken);
  }

  function recordFailedInviteAttempt(address, clientToken) {
    const now = timeProvider();

    // 1. Per-token failed attempt tracking (strict: default 5 attempts / 15 min)
    const tokenKey = `${address}:${clientToken}`;
    const tokenEntry = lockouts.get(tokenKey) || { attempts: 0, lockedUntil: 0, firstAttempt: now };
    if (now - tokenEntry.firstAttempt > inviteLockoutMs) {
      tokenEntry.attempts = 0;
      tokenEntry.firstAttempt = now;
      tokenEntry.lockedUntil = 0;
    }
    tokenEntry.attempts += 1;
    if (tokenEntry.attempts >= inviteLockoutAttempts) {
      tokenEntry.lockedUntil = now + inviteLockoutMs;
      logger.warn("[Auth] Handshake lockout applied for client token");
    }
    setWithCap(lockouts, tokenKey, tokenEntry, maxTrackedLockouts);

    // 2. Per-address failed attempt tracking (looser counter: default 50 attempts / 15 min)
    const addrEntry = addressLockouts.get(address) || { attempts: 0, lockedUntil: 0, firstAttempt: now };
    if (now - addrEntry.firstAttempt > inviteLockoutMs) {
      addrEntry.attempts = 0;
      addrEntry.firstAttempt = now;
      addrEntry.lockedUntil = 0;
    }
    addrEntry.attempts += 1;
    if (addrEntry.attempts >= inviteAddressLockoutAttempts) {
      addrEntry.lockedUntil = now + inviteLockoutMs;
      logger.warn("[Auth] Address handshake lockout threshold reached");
    }
    setWithCap(addressLockouts, address, addrEntry, maxTrackedAddressLockouts);
  }

  function clearLockout(address, clientToken) {
    const key = `${address}:${clientToken}`;
    lockouts.delete(key);
  }

  function authenticateHandshake(handshake) {
    const now = timeProvider();
    const address = resolveClientAddress(handshake, options.trustProxy ?? TRUST_PROXY);
    const auth = (handshake && handshake.auth) || {};
    const clientToken = typeof auth.clientToken === "string" ? auth.clientToken.trim() : "";
    const inviteCode = typeof auth.inviteCode === "string" ? auth.inviteCode.trim() : "";

    const requireInvite = options.requireInvite ?? REQUIRE_INVITE;

    if (!clientToken || clientToken.length < 8) {
      return { ok: false, error: "INVALID_CLIENT_TOKEN" };
    }

    const hashedToken = hashToken(clientToken, options.serverSalt ?? SERVER_SALT);
    if (!hashedToken) {
      return { ok: false, error: "TOKEN_HASHING_FAILED" };
    }

    if (bannedTokens.has(hashedToken.toLowerCase())) {
      return { ok: false, error: "BANNED" };
    }

    if (isLockedOut(address, clientToken)) {
      return { ok: false, error: "INVITE_LOCKED_OUT" };
    }

    if (requireInvite) {
      const isValid = validateInviteCode(inviteCode, options.inviteCodes ?? INVITE_CODES);
      if (!isValid) {
        recordFailedInviteAttempt(address, clientToken);
        return { ok: false, error: "INVALID_INVITE_CODE" };
      }
    }

    // Clear failed attempts on successful verification
    clearLockout(address, clientToken);

    // Enforce connection limits
    const maxPerAddr = options.maxSocketsPerAddress ?? MAX_SOCKETS_PER_ADDRESS;
    const maxTotal = options.maxTotalConnections ?? MAX_TOTAL_CONNECTIONS;

    const currentAddrCount = addressConnections.get(address) || 0;
    if (currentAddrCount >= maxPerAddr) {
      return { ok: false, error: "MAX_ADDRESS_CONNECTIONS_REACHED" };
    }
    if (totalConnections >= maxTotal) {
      return { ok: false, error: "MAX_SERVER_CONNECTIONS_REACHED" };
    }

    addressConnections.set(address, currentAddrCount + 1);
    totalConnections += 1;

    return {
      ok: true,
      hashedToken,
      address
    };
  }

  function releaseConnection(address) {
    if (!address) return;
    const current = addressConnections.get(address);
    if (current && current > 1) {
      addressConnections.set(address, current - 1);
    } else {
      addressConnections.delete(address);
    }
    if (totalConnections > 0) {
      totalConnections -= 1;
    }
  }

  /**
   * Creates a RateLimiter instance for an individual socket.
   */
  function createSocketLimiter() {
    // Generous burst for ICE candidates: 30 capacity, 10/s refill (normal gathering sends 5-15 in <500ms)
    const iceBucket = new TokenBucket(30, 10, timeProvider);
    // Strict buckets for queue, signaling, and safety actions
    const joinBucket = new TokenBucket(2, 0.5, timeProvider);
    const broadenBucket = new TokenBucket(2, 0.5, timeProvider);
    const offerBucket = new TokenBucket(3, 1, timeProvider);
    const answerBucket = new TokenBucket(3, 1, timeProvider);
    const leaveBucket = new TokenBucket(5, 2, timeProvider);
    const reportBucket = new TokenBucket(2, 0.2, timeProvider);
    const blockBucket = new TokenBucket(2, 0.2, timeProvider);
    const statsBucket = new TokenBucket(2, 0.5, timeProvider);

    // Global flood bucket: 50 capacity, 25/s refill
    const floodBucket = new TokenBucket(50, 25, timeProvider);
    let consecutiveDrops = 0;

    return {
      checkEvent(eventName) {
        if (!floodBucket.consume(1)) {
          consecutiveDrops += 1;
          return { allow: false, disconnect: consecutiveDrops > 15 };
        }

        let bucket = null;
        switch (eventName) {
          case "ice-candidate":
            bucket = iceBucket;
            break;
          case "join-queue":
            bucket = joinBucket;
            break;
          case "broaden-accept":
            bucket = broadenBucket;
            break;
          case "offer":
            bucket = offerBucket;
            break;
          case "answer":
            bucket = answerBucket;
            break;
          case "leave-session":
            bucket = leaveBucket;
            break;
          case "report-user":
            bucket = reportBucket;
            break;
          case "block-user":
            bucket = blockBucket;
            break;
          case "connection-stats":
            bucket = statsBucket;
            break;
          default:
            bucket = null;
        }

        if (bucket && !bucket.consume(1)) {
          consecutiveDrops += 1;
          return { allow: false, disconnect: false };
        }

        consecutiveDrops = 0;
        return { allow: true, disconnect: false };
      }
    };
  }

  function recordSessionPairing(tokenA, tokenB) {
    if (tokenA && tokenB) {
      setWithCap(verifiedPairings, `${tokenA}:${tokenB}`, true, maxTrackedPairings);
      setWithCap(verifiedPairings, `${tokenB}:${tokenA}`, true, maxTrackedPairings);
    }
  }

  const maxTrackedGraceRecords = options.maxTrackedGraceRecords ?? 2_000;

  function setGracePeriod(socketId, sessionId, partnerHashedToken) {
    if (!socketId || !sessionId || !partnerHashedToken) return;
    const expiresAt = timeProvider() + (options.gracePeriodMs ?? GRACE_PERIOD_MS);
    const key = `${socketId}:${sessionId}`;
    setWithCap(graceRecords, key, { socketId, sessionId, partnerHashedToken, expiresAt }, maxTrackedGraceRecords);
  }

  function getGraceRecord(socketId, sessionId) {
    if (!sessionId) {
      let latest = null;
      for (const [key, entry] of graceRecords.entries()) {
        if (key.startsWith(`${socketId}:`) && timeProvider() <= entry.expiresAt) {
          if (!latest || entry.expiresAt > latest.expiresAt) {
            latest = entry;
          }
        }
      }
      return latest;
    }

    const key = `${socketId}:${sessionId}`;
    const entry = graceRecords.get(key);
    if (!entry) return null;
    if (timeProvider() > entry.expiresAt) {
      graceRecords.delete(key);
      return null;
    }
    return entry;
  }

  function clearGraceRecord(socketId, sessionId) {
    if (sessionId) {
      graceRecords.delete(`${socketId}:${sessionId}`);
    } else {
      for (const [key, entry] of graceRecords.entries()) {
        if (entry.socketId === socketId) {
          graceRecords.delete(key);
        }
      }
    }
  }

  function recordBlock(blockerHashedToken, partnerHashedToken) {
    if (!blockerHashedToken || !partnerHashedToken) return;
    const now = timeProvider();
    const expiresAt = now + (options.blockTtlMs ?? BLOCK_TTL_MS);

    let blocks = userBlocks.get(blockerHashedToken);
    if (!blocks) {
      blocks = new Map();
      setWithCap(userBlocks, blockerHashedToken, blocks, maxTrackedBlockers);
    }

    // Evict oldest if capacity exceeded
    const maxBlocks = options.maxBlocksPerUser ?? MAX_BLOCKS_PER_USER;
    if (blocks.size >= maxBlocks) {
      const oldestKey = blocks.keys().next().value;
      blocks.delete(oldestKey);
    }

    blocks.set(partnerHashedToken, expiresAt);
  }

  function isBlocked(tokenA, tokenB) {
    if (!tokenA || !tokenB) return false;
    const now = timeProvider();

    const checkMap = (blocker, blocked) => {
      const map = userBlocks.get(blocker);
      if (!map) return false;
      const exp = map.get(blocked);
      if (!exp) return false;
      if (now > exp) {
        map.delete(blocked);
        return false;
      }
      return true;
    };

    return checkMap(tokenA, tokenB) || checkMap(tokenB, tokenA);
  }

  function checkCooldown(hashedToken) {
    const now = timeProvider();
    const exp = cooldowns.get(hashedToken);
    if (!exp) return false;
    if (now > exp) {
      cooldowns.delete(hashedToken);
      return false;
    }
    return true;
  }

  async function appendReportFile(reportRecord) {
    try {
      const resolvedPath = path.resolve(reportsFilePath);
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      if (fs.existsSync(resolvedPath)) {
        const stats = fs.statSync(resolvedPath);
        if (stats.size >= maxReportsFileSize) {
          logger.warn("[Safety] Reports file size limit reached; dropping report append");
          return false;
        }
      }

      const jsonLine = JSON.stringify(reportRecord) + "\n";
      await fs.promises.appendFile(resolvedPath, jsonLine, { mode: 0o600 });
      return true;
    } catch (err) {
      logger.warn("[Safety] Failed to write report file");
      return false;
    }
  }

  async function recordReport({ sessionId, category, rawNote, reporterHashedToken, reportedHashedToken }) {
    if (!REPORT_CATEGORIES.includes(category)) {
      return { ok: false, error: "INVALID_CATEGORY" };
    }
    if (!reporterHashedToken || !reportedHashedToken) {
      return { ok: false, error: "INVALID_PARTNERS" };
    }

    const reportKey = `${sessionId}:${reporterHashedToken}`;
    if (sessionReports.has(reportKey)) {
      return { ok: false, error: "DUPLICATE_REPORT" };
    }
    setWithCap(sessionReports, reportKey, true, maxTrackedSessionReports);

    const now = timeProvider();
    const reportId = crypto.randomUUID();
    const note = sanitizeNote(rawNote);

    const record = {
      reportId,
      timestamp: new Date(now).toISOString(),
      sessionId,
      category,
      note,
      reportedHashedToken,
      reporterHashedToken
    };

    // Terminal alert for urgent reports: NEVER output the note or raw token
    if (category === "urgent_minor_safety" || category === "urgent_violence_threat") {
      logger.warn(
        `[URGENT SAFETY ALERT] Category: ${category} | Session: ${sessionId} | ReportId: ${reportId} | Time: ${record.timestamp}`
      );
    }

    // Write outside matching path
    await appendReportFile(record);

    // Evaluate automated cooldown with distinct reporter verification
    const werePaired = verifiedPairings.has(`${reporterHashedToken}:${reportedHashedToken}`);
    if (werePaired) {
      let tallies = userReportTallies.get(reportedHashedToken);
      if (!tallies) {
        tallies = new Map();
        setWithCap(userReportTallies, reportedHashedToken, tallies, maxTrackedTallies);
      }

      // Purge entries older than window
      const windowStart = now - (options.cooldownWindowMs ?? COOLDOWN_WINDOW_MS);
      for (const [repToken, ts] of tallies.entries()) {
        if (ts < windowStart) tallies.delete(repToken);
      }

      tallies.set(reporterHashedToken, now);

      const threshold = options.cooldownReportThreshold ?? COOLDOWN_REPORT_THRESHOLD;
      if (tallies.size >= threshold) {
        const cooldownExp = now + (options.cooldownDurationMs ?? COOLDOWN_DURATION_MS);
        setWithCap(cooldowns, reportedHashedToken, cooldownExp, maxTrackedCooldowns);
        logger.warn("[Safety] User placed on automated cooldown due to multiple safety reports");
      }
    }

    return { ok: true, reportId };
  }

  function sweepExpired() {
    const now = timeProvider();

    // Expire token lockouts (delete expired locks OR attempts older than window even if never reached limit)
    for (const [key, entry] of lockouts.entries()) {
      if (entry.lockedUntil > 0 && now >= entry.lockedUntil) {
        lockouts.delete(key);
      } else if (now - entry.firstAttempt >= inviteLockoutMs) {
        lockouts.delete(key);
      }
    }

    // Expire address lockouts (delete expired locks OR attempts older than window even if never reached limit)
    for (const [addr, entry] of addressLockouts.entries()) {
      if (entry.lockedUntil > 0 && now >= entry.lockedUntil) {
        addressLockouts.delete(addr);
      } else if (now - entry.firstAttempt >= inviteLockoutMs) {
        addressLockouts.delete(addr);
      }
    }

    // Expire grace records
    for (const [socketId, entry] of graceRecords.entries()) {
      if (now >= entry.expiresAt) {
        graceRecords.delete(socketId);
      }
    }

    // Expire blocks
    for (const [blocker, blocks] of userBlocks.entries()) {
      for (const [blocked, exp] of blocks.entries()) {
        if (now >= exp) {
          blocks.delete(blocked);
        }
      }
      if (blocks.size === 0) {
        userBlocks.delete(blocker);
      }
    }

    // Expire cooldowns
    for (const [token, exp] of cooldowns.entries()) {
      if (now >= exp) {
        cooldowns.delete(token);
      }
    }
  }

  return {
    authenticateHandshake,
    releaseConnection,
    createSocketLimiter,
    recordSessionPairing,
    setGracePeriod,
    getGraceRecord,
    clearGraceRecord,
    recordBlock,
    isBlocked,
    recordReport,
    checkCooldown,
    sweepExpired,
    isLockedOut,
    hashToken,
    _getLockouts: () => lockouts,
    _getAddressLockouts: () => addressLockouts
  };
}

