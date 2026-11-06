import {
  METERED_DOMAIN,
  METERED_API_KEY,
  ICE_TRANSPORT_POLICY
} from "./config.js";

export const DEFAULT_STUN_SERVERS = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" }
]);

/**
 * Validates the structure of ICE server objects returned from external providers or config.
 */
export function validateIceServers(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return false;
  return servers.every((server) => {
    if (!server || typeof server !== "object") return false;
    if (typeof server.urls !== "string" && !Array.isArray(server.urls)) return false;
    if (Array.isArray(server.urls) && server.urls.some((u) => typeof u !== "string")) return false;
    return true;
  });
}

// NOTE (to verify in the provider docs):
// Metered.ca's dashboard REST API returns account-level credentials with expiration timestamps.
// If Metered provides a per-session short-lived credential API endpoint (or HMAC secret generation),
// that should be used instead.
// Security risk: with shared account-level credentials, testers can copy credentials until expiration.

export function createIceManager(options = {}) {
  const domain = options.domain ?? METERED_DOMAIN;
  const apiKey = options.apiKey ?? METERED_API_KEY;
  const policy = options.policy ?? ICE_TRANSPORT_POLICY;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeProvider = options.timeProvider || (() => Date.now());
  const cacheTtlMs = options.cacheTtlMs ?? (3600 * 1000); // 1 hour
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 3000; // 3 seconds timeout
  const logger = options.logger ?? console;

  let cachedIceServers = null;
  let cacheExpiresAt = 0;
  let inFlightFetch = null;

  async function fetchMeteredTurn() {
    if (!domain || !apiKey) {
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

    try {
      const url = `https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetchFn(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP_${res.status}`);
      }

      const data = await res.json();
      if (validateIceServers(data)) {
        return data;
      }
      return null;
    } catch (err) {
      clearTimeout(timeoutId);
      // Redact: never log API key, URL, or raw error objects containing secrets
      const reason = err.name === "AbortError" ? "Request timed out (3s)" : "Network/service error";
      logger.warn(`[ICE] Failed to fetch TURN credentials: ${reason}`);
      return null;
    }
  }

  async function getOrFetchTurnServers() {
    const now = timeProvider();
    if (cachedIceServers && cacheExpiresAt > now) {
      return cachedIceServers;
    }

    if (!domain || !apiKey) {
      return null;
    }

    // Share concurrent in-flight fetch request
    if (inFlightFetch) {
      return inFlightFetch;
    }

    inFlightFetch = (async () => {
      try {
        const turnServers = await fetchMeteredTurn();
        if (turnServers && validateIceServers(turnServers)) {
          cachedIceServers = turnServers;
          cacheExpiresAt = timeProvider() + cacheTtlMs;
          return cachedIceServers;
        }
        return null;
      } finally {
        inFlightFetch = null;
      }
    })();

    return inFlightFetch;
  }

  async function getIceConfig() {
    const turnServers = await getOrFetchTurnServers();

    if (policy === "relay") {
      if (!turnServers || turnServers.length === 0) {
        return {
          ok: false,
          error: "Relay connection requires TURN credentials, but no TURN servers are available."
        };
      }
      return {
        ok: true,
        iceServers: turnServers,
        iceTransportPolicy: "relay"
      };
    }

    // Default policy: "all"
    const iceServers = turnServers && turnServers.length > 0
      ? [...DEFAULT_STUN_SERVERS, ...turnServers]
      : DEFAULT_STUN_SERVERS;

    return {
      ok: true,
      iceServers,
      iceTransportPolicy: "all"
    };
  }

  function warmCache() {
    if (domain && apiKey) {
      getOrFetchTurnServers().catch(() => {});
    }
  }

  function clearCache() {
    cachedIceServers = null;
    cacheExpiresAt = 0;
    inFlightFetch = null;
  }

  return {
    getIceConfig,
    warmCache,
    clearCache,
    validateIceServers
  };
}

