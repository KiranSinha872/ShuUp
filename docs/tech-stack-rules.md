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
| Persistence (Phase 8) | Supabase | Auth with MFA, anonymous session analytics, and invite code management. |

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
- **Server-Side Validation:** The backend must strictly validate every incoming socket event payload with pure validation functions (e.g. `validateJoinPayload`). Never trust partner IDs or data types sent from clients.
- **Signaling Partner Isolation:** The server stores partner pairings internally. Offer, answer, and ICE candidates are dispatched solely to the paired partner socket verified in memory.
- **Ghost Socket Cleanup:** Active heartbeat monitoring and disconnect hooks immediately purge stale sockets from the matchmaking queue and notify active partners.

### Phase 7 (Trust & Safety)
- **Invite Code Validation:** Invite codes are checked strictly on the server before enrolling any socket into the queue.
- **Event Rate Limiting:** Apply an in-memory sliding window rate limiter on high-frequency socket events (`join-queue`, `leave-session`, `report-user`) to prevent denial-of-service or connection flooding.
- **Production Hygiene:** Suppress all verbose console debug logging in production environments (`process.env.NODE_ENV === 'production'`).
- **Dependency Auditing:** Run `npm audit` prior to adding or updating any third-party dependency.

### Phase 8–9 (Persistence, Admin Dashboard, & Deployment)
- **Admin JWT Verification:** The backend verifies Supabase Auth JWT tokens and confirms Multi-Factor Authentication (MFA) status on every incoming request to `/admin` telemetry routes.
- **No IP or Media Logging:** Session persistence records only aggregated metrics (timestamps, duration, connection type). IP addresses and personal identifiers are never written to the database.

---

## 3. Database Indexing, Caching, & Testing Scope

### Database Indexing (Phase 8 Supabase)
- **Needed:**
  - `sessions(created_at DESC)`: Required to compute the 7-day rolling call volume and duration efficiently without full table scans.
  - `invite_codes(code)`: Unique index required for $O(1)$ invite code lookup.
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
