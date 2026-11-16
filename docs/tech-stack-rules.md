# Shuup - Tech Stack & Implementation Rules

This document establishes the technical constraints, coding standards, and security requirements across the project lifecycle. For matching rules and event payloads, see [architecture.md](file:///Users/kiransinha/Desktop/Shuup/docs/architecture.md). For safety specifications, see [PRD.md](file:///Users/kiransinha/Desktop/Shuup/docs/PRD.md).

---

## 1. Core Stack Specifications

| Component | Technology | Rationale |
|---|---|---|
| Frontend Framework | Vite + React (Plain JS) | Ultra-fast startup, static build output, zero SSR hydration pitfalls with WebRTC. Runs on port 3000. |
| Backend Server | Plain Node.js `http` | Minimal footprint; no Express overhead needed for a Socket.IO signaling server. Runs on port 4000. |
| Realtime Engine | Socket.IO | Battle-tested WebSocket fallback, connection heartbeats, and room management. |
| Media Transport | Browser-native WebRTC | Direct P2P video/audio; zero third-party video SDK dependencies. |
| Health Check | Plain Node `http.createServer` | Simple GET `/health` returning `{ status: "ok" }`. |
| Test Runner | Node.js built-in `node --test` | Zero external testing dependencies. Executed via `npm test` (`"test": "node --test"` in `backend/package.json`). |
| Persistence (Phase 8) | SQLite / Hosted Postgres | Auth with MFA, anonymous session analytics, accounts, bans, and moderation reports. |

---

## 2. Security Rules by Phase

### Phase 1–3 (Setup, Signaling, & Basic Queue)
- **Zero Secrets in Version Control:** All secrets reside strictly in `.env` files. Both `frontend/.gitignore` and `backend/.gitignore` must block `.env` and `.env.*`.
- **Frontend Environment Safety:** Frontend `.env` contains only public values prefixed with `VITE_` (e.g. `VITE_BACKEND_URL`). Never expose backend keys or admin tokens.
- **Strict CORS Policy:** Backend Socket.IO and HTTP endpoints permit connections **only** from the explicitly configured frontend origin (`http://localhost:3000` in development). Wildcard `*` is strictly forbidden.
- **Baseline HTTP Security Headers:** For the Node HTTP server (including `/health`), set explicit security headers on responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Content-Security-Policy: default-src 'self'` (with required WebSocket origins)

### Phase 4–6 (Preferences, Lifecycle, & Connectivity)
- **Server-Side Validation:** The backend must strictly validate every incoming socket event payload with pure validation functions (e.g. `validateJoinPayload`, `isValidEmptyPayload`, and `connection-stats` validator). Never trust partner IDs or data types sent from clients.
- **Signaling Partner Isolation:** The server stores partner pairings internally. Offer, answer, and ICE candidates are dispatched solely to the paired partner socket verified in memory.
- **Ghost Socket Cleanup:** Active heartbeat monitoring and disconnect hooks immediately purge stale sockets from the matchmaking queue and notify active partners.
- **ICE Policy, Privacy & Zero-Payment Constraint (Phase 6):**
  - **Zero-Payment Rule:** Never use any third-party service, provider, or infrastructure that requires a credit card or payment method on file. Only strictly free resources with no card required may be used.
  - The default is `ICE_TRANSPORT_POLICY=all` using Google public STUN (`stun:stun.l.google.com:19302`).
  - Direct P2P mode lets the partner see the user's public IP address through WebRTC candidate exchange; private testers must be informed of this limitation.
  - "relay" policy must NOT be enabled without valid TURN credentials in `backend/.env`. If relay policy is active and TURN credentials fail or are absent, the server must refuse the pairing and terminate with an error rather than falling back to STUN.
  - The TURN fetch and configuration logic in `ice.js` remains completely dormant until credentials exist in `backend/.env`. Provider choice remains open (no provider decided).
  - TURN credentials and provider secrets reside exclusively in `backend/.env`. The frontend has zero ICE or TURN environment variables.
  - Ephemeral credentials are passed to clients strictly inside the `matched` event payload.
  - Connection telemetry (`connection-stats`) reports strictly the enum `"direct" | "relay" | "unknown"`. Zero IP addresses, ports, or raw candidate strings may be accepted, logged, or recorded.

### Phase 7 (Trust & Safety)
- **Handshake Authentication & Connection Caps:**
  - Handshake authentication validates `clientToken` presence and length ($\ge 8$ chars) before allowing socket connection.
  - Startup validation (`validateStartupConfig`) fails safely without printing secret values if `SERVER_SALT` (< 32 chars) is missing or invalid.
  - Sockets-per-address and total server connections are capped in memory (`MAX_SOCKETS_PER_ADDRESS`, `MAX_CONNECTIONS`). When server capacity is reached, new handshakes are refused with `SERVER_FULL`. Network addresses are used strictly in memory for counting and are never stored or logged.
  - In-memory data structures enforce hard bounds with oldest-eviction (LRU) to prevent unbounded memory growth.
- **Anonymous Token Hashing & Zero Secret Logging:**
  - Client tokens are hashed server-side using `HMAC-SHA256` keyed with `SERVER_SALT`.
  - Raw client tokens, token hashes, IP addresses, and user notes must **never** be output to standard console logs or persisted in version control.
- **Multi-Tier Rate Limiting & Connection Caps:**
  - Per-event token bucket rate limits: generous burst for `ice-candidate` (capacity 30, refill 10/s); strict limits for `join-queue`, `offer`, `answer`, `leave-session`, `report-user`, and `block-user`.
  - Global socket flood limiter drops excessive traffic and signals disconnect upon sustained abuse.
- **Reports & Moderation Records:**
  - Reports are appended to `backend/data/reports.jsonl` with file permissions `0600`. The `backend/data/` directory must remain strictly git-ignored.
  - File size is capped (`MAX_REPORTS_FILE_SIZE_BYTES`); appends outside the matching path.
  - User notes are stripped of control characters and capped at 200 characters.
  - Urgent safety alerts (`urgent_minor_safety`, `urgent_violence_threat`) surface a minimal terminal alert displaying only `category`, `sessionId`, `reportId`, and `timestamp` (never notes or tokens).
- **Grace Period & Block Synchronicity:**
  - The server retains the last `sessionId` and partner's `hashedToken` in memory for 120s (`GRACE_PERIOD_MS`) after session end to permit post-call reporting and blocking.
  - Block enforcement is evaluated bidirectionally in constant time inside `isCompatible` with zero `await` statements.
  - Automated cooldown triggers only after $\ge 3$ distinct verified partner tokens report an account.

### Phase 8–9 (Persistence, Admin Dashboard, & Deployment)
- **Admin JWT Verification:** The backend verifies Supabase Auth JWT tokens and confirms Multi-Factor Authentication (MFA) status on every incoming request to `/admin` telemetry routes.
- **No IP or Media Logging:** Session persistence records only aggregated metrics (timestamps, duration, connection type). IP addresses and personal identifiers are never written to the database.

---

## 3. Database Indexing, Caching, & Testing Scope

### Database Indexing (Phase 8 Supabase)
- **Needed:**
  - `sessions(created_at DESC)`: Required to compute the 7-day rolling call volume and duration efficiently without full table scans.
  - `reports(created_at DESC)`: Needed for moderation review ordering.
- **Not Needed:**
  - No database indexes on the matchmaking queue. The queue is 100% in-memory; no database table is touched during matching.

### Caching Strategy
- **Needed:**
  - In-memory `recent_partners` Set per socket to prevent instant rematching on skip.
- **Not Needed:**
  - Redis or distributed cache: Unnecessary overhead for the single-instance prototype. Server memory is completely adequate.

### Testing Strategy
- **Unit Tests (`node --test`):** Isolated tests for pure matching logic (`isCompatible`), payload validation (`validateJoinPayload`), and simulated multi-user arrival queues without network overhead.
- **Load Testing:**
  - Multi-tab manual verification (testing 4–6 concurrent browser sessions locally) across different identity/preference combinations.
  - Automated synthetic load testing tools (e.g. k6, Artillery) are out of scope for the prototype and will not be configured unless requested.
