# Shuup - System Architecture

This document defines the high-level system components, matching logic, and realtime event contract. For safety rules, see [PRD.md](file:///Users/kiransinha/Desktop/Shuup/docs/PRD.md). For implementation and security standards, see [tech-stack-rules.md](file:///Users/kiransinha/Desktop/Shuup/docs/tech-stack-rules.md).

---

## 1. High-Level Component Overview

```text
+--------------------------------------------------------------+
|                        Client Browser                        |
|   (Vite + React, navigator.mediaDevices, RTCPeerConnection)  |
+------------------------------+-------------------------------+
                               |
            WebSocket (Socket.IO signaling & queue events)
                               |
                               v
+--------------------------------------------------------------+
|                     Node.js Signaling Server                 |
|   (Plain Node http + Socket.IO, In-Memory Matchmaking Queue) |
+------------------------------+-------------------------------+
                               |
     Direct P2P WebRTC Media   |   (Fallback to TURN relay
     (Browser <===============> Browser)   when NAT traversal fails)
```

Three strictly separated layers:
1. **Matchmaking:** Backend in-memory queue pairs compatible sockets atomically.
2. **Signaling:** Socket.IO relays session descriptions and ICE candidates between paired sockets.
3. **Media Transport:** Native WebRTC streams audio/video directly peer-to-peer (or via TURN relay). Server never handles media data.

---

## 2. Matching Logic & Compatibility Rules (Single Source of Truth)

### 2.1 User Attribute Definitions
- **Identity (Single-choice):** `Man` | `Woman` | `Non-binary` | `Prefer not to say`
- **Preferences (Multi-choice):** Set containing any combination of: `Men`, `Women`, `Non-binary people`, `Anyone`

### 2.2 Matching Compatibility Rule
A match between User A and User B is valid if and only if **all** of the following hold:
1. **User A accepts User B's identity:**
   - If User A selected `Anyone`, User B is accepted regardless of User B's identity (including `Prefer not to say`).
   - Otherwise, User B's identity must match one of User A's explicit preference categories (`Men` matches `Man`, `Women` matches `Woman`, `Non-binary people` matches `Non-binary`).
   - *Rule:* If User B's identity is `Prefer not to say`, User A **must** have selected `Anyone` to match. Selecting all three specific groups (`Men`, `Women`, `Non-binary people`) does **not** accept `Prefer not to say`.
2. **User B accepts User A's identity:**
   - Evaluated using the exact same rule inversely.
3. **Session Availability:** Neither user is currently paired in an active session.
4. **Recent Partner Exclusion:** User A and User B are not in each other's recent partner cache (prevents instant rematching when skipping; Phase 5).

### 2.3 Queue Mechanics
- **In-Memory Storage:** The active queue resides entirely in server memory. No database queries exist in the matchmaking loop.
- **Ordering:** Longest-waiter-first (ordered by `joined_queue_at` timestamp).
- **Atomic Match Execution:** Scanning the queue, validating compatibility, and removing both users from the queue executes in a single synchronous function block with **no `await` statements**, preventing race conditions and double-matching in Node's single-threaded event loop.
- **Broaden Preferences:**
  - If a user waits in the queue for 30 seconds without a match, the server emits a `broaden-prompt` (Phase 5).
  - Widening is strictly opt-in; the server never silently alters user preferences.
  - Upon receiving `broaden-accept`, the user's preference set expands to `Anyone`, enabling broader compatibility while still respecting the partner's mutual preferences.
  - Broaden never overrides the recent-partner rule.

---

## 3. Realtime Event Contract (Single Source of Truth)

All events travel over Socket.IO. The server guarantees that signaling messages are forwarded **only** to the verified session partner stored in server memory.

| Event Name | Direction | Payload Schema | Purpose | Status in Code |
|---|---|---|---|---|
| `handshake (auth)` | Client -> Server | `{ auth: { inviteCode: string, clientToken: string } }` | Authenticates connection against server invite codes and hashes client token | Implemented (Phase 7a) |
| `join-queue` | Client -> Server | `{ identity: string, preferences: string[] }` | Enters client into matchmaking queue | Implemented (Phase 4) |
| `queue-status` | Server -> Client | `{ status: "waiting" \| "rejected", message: string }` | Queue status update or payload rejection reason | Implemented (Phase 4) |
| `broaden-prompt` | Server -> Client | `{ waitSeconds: number }` | Prompt user to broaden preferences after 30s | Implemented (Phase 5) |
| `broaden-accept` | Client -> Server | `{}` | User opts in to broaden preferences | Implemented (Phase 5) |
| `matched` | Server -> Both Clients | `{ sessionId: string, isCaller: boolean, iceServers: RTCIceServer[], iceTransportPolicy: "all" \| "relay" }` | Pairs two sockets with session ID, caller role, and server-configured ICE servers and policy | Implemented (Phase 3 & 6a) |
| `connection-stats` | Client -> Server | `{ sessionId: string, connectionType: "direct" \| "relay" \| "unknown" }` | Client reports WebRTC candidate pair type for telemetry (rate-limited, no IPs/strings) | Implemented (Phase 6a) |
| `offer` (client emit) | Client -> Server | `{ sdp: RTCSessionDescriptionInit }` | Caller sends WebRTC SDP offer | Implemented (Phase 2) |
| `offer` (forwarded) | Server -> Partner | `{ sessionId: string, sdp: RTCSessionDescriptionInit }` | Relayed to stored partner with session verification | Implemented (Phase 3) |
| `answer` (client emit) | Client -> Server | `{ sdp: RTCSessionDescriptionInit }` | Callee responds with WebRTC SDP answer | Implemented (Phase 2) |
| `answer` (forwarded) | Server -> Partner | `{ sessionId: string, sdp: RTCSessionDescriptionInit }` | Relayed to stored partner with session verification | Implemented (Phase 3) |
| `ice-candidate` (client emit) | Client -> Server | `{ candidate: RTCIceCandidateInit }` | Client sends local ICE candidate | Implemented (Phase 2) |
| `ice-candidate` (forwarded) | Server -> Partner | `{ sessionId: string, candidate: RTCIceCandidateInit }` | Relayed to stored partner with session verification | Implemented (Phase 3) |
| `leave-session` | Client -> Server | `{}` | Leaves active call or cancels waiting queue (Next re-enqueues client) | Implemented (Phase 3 & 5) |
| `partner-left` | Server -> Client | `{ reason: "left" \| "disconnected" \| "blocked" }` | Notifies remaining peer that partner left or was blocked | Implemented (Phase 2 & 7a) |
| `report-user` | Client -> Server | `{ sessionId: string, category: string, note?: string }` | Reports session partner for safety violation (active or 120s grace period) | Implemented (Phase 7a) |
| `block-user` | Client -> Server | `{ sessionId: string }` | Blocks session partner's token in memory for 24h and dissolves active call immediately | Implemented (Phase 7a) |

---

## 4. ICE Connectivity & Privacy Architecture (Phase 6)

### 4.1 ICE Policy & Privacy
- **Default Policy (`ICE_TRANSPORT_POLICY=all`):** Default for the application and private tester phase using Google public STUN (`stun:stun.l.google.com:19302`). Peers attempt a direct peer-to-peer connection via STUN.
- **Privacy Limitation (Direct Mode):** Direct mode reveals the user's public IP address to the connected partner through WebRTC candidate exchange. Private testers must be informed of this limitation.
- **Relay Policy (`ICE_TRANSPORT_POLICY=relay`):** Hides both peers' IP addresses behind a TURN relay server. A public launch requires relay mode with adequate TURN bandwidth capacity to uphold Section 9 privacy rules.
- **Relay-Without-TURN Refusal:** "relay" mode must NOT be enabled without valid TURN credentials in `backend/.env`. When `ICE_TRANSPORT_POLICY="relay"` and no TURN credentials exist, the server immediately refuses pairing with a clear rejection error rather than falling back to STUN, ensuring IP addresses are never exposed accidentally.
- **Dormant TURN Infrastructure:** The dynamic TURN credential fetch and caching logic in `ice.js` remains completely dormant until credentials are provided in `backend/.env`. Provider choice remains open with no specific provider decided, adhering to the rule that no payment method or card may be required.

### 4.2 Credential Protection
- TURN credentials and provider secrets reside exclusively in `backend/.env`.
- The server delivers short-lived credentials directly inside the `matched` Socket.IO event.
- Zero TURN or ICE configuration is stored in client code or client environment variables.

### 4.3 Phase 6b Deferral Note
- Phase 6b (TURN account setup and cross-network tunnel testing) is deferred since no free, no-card TURN provider has been chosen.
- The system operates in STUN-only mode for now, to be revisited only if real users cannot connect.

---

## 5. Trust, Safety & Abuse Control Architecture (Phase 7a)

### 5.1 Invite-Code Gate & Handshake Security
- Gated behind `INVITE_CODES` in `backend/.env`.
- Validation is evaluated at the Socket.IO connection handshake level before enrolling sockets.
- **Timing-Safe Comparison:** `validateInviteCode` uses `crypto.timingSafeEqual` over fixed-length SHA-256 digests across all valid codes without early return.
- **Dual-Tier Lockout Defense:**
  - *Per-Token Lockout:* 5 failed attempts within 15 minutes locks out `${address}:${clientToken}` with `INVITE_LOCKED_OUT`.
  - *Per-Address Lockout:* A second, looser counter (`INVITE_ADDRESS_LOCKOUT_ATTEMPTS`, default 50 failed attempts within 15 minutes) rejects all further handshakes from that IP with `INVITE_LOCKED_OUT` to prevent token-rotation bypass attacks. Only failed attempts increment the counter; valid codes never trip it. Shared networks (campus Wi-Fi, tunnels, NATs) can raise this limit via `INVITE_ADDRESS_LOCKOUT_ATTEMPTS`.
- **Memory Growth & Hard Bounds:**
  - In-memory maps (`lockouts`, `addressLockouts`, `userBlocks`, `sessionReports`, `verifiedPairings`, `userReportTallies`, `cooldowns`) enforce hard bounds (`MAX_TRACKED_LOCKOUTS`, default 10,000) using oldest-entry LRU eviction (`setWithCap`).
  - `sweepExpired()` actively purges all failed-attempt records older than 15 minutes, including partial attempts that never reached the lockout threshold.
- **Startup Protection:** `validateStartupConfig()` checks `SERVER_SALT` ($\ge 32$ chars) and `INVITE_CODES` ($\ge 16$ chars per code) on process startup, exiting safely without printing secrets.

### 5.2 Anonymous Client Token
- Generated in the browser (`crypto.randomUUID()`) and stored in `localStorage` under `shuup_client_token`.
- Sent strictly via `auth: { clientToken }` at handshake.
- Hashed server-side via `HMAC-SHA256` keyed with `SERVER_SALT`. Raw tokens are never logged or stored.

### 5.3 Reporting, Blocking & Last-Partner Grace Window
- **Zero Trust:** Clients emit `report-user` or `block-user` with `sessionId` only; the server derives the partner token from server memory.
- **Grace Window:** Server stores the last `sessionId` and partner's `hashedToken` for 120 seconds after a session ends (leave, Next, partner-left) so users can report or block a partner who quickly disconnected.
- **Blocking:** Bidirectional block check evaluated inside `isCompatible` in constant time without `await`. Blocks persist for 24 hours with an LRU cap of 100 per user.
- **Reports File:** Appended to `backend/data/reports.jsonl` (mode `0600`, git-ignored, 10MB size cap). Notes are stripped of control characters and capped at 200 characters.

### 5.4 Multi-Tier Rate Limiting & Cooldown
- **Token Bucket Limiting:**
  - `ice-candidate`: generous bucket capacity (30 tokens, refill 10/s) accommodating initial gathering bursts.
  - Strict limits for `join-queue`, `offer`, `answer`, `report-user`, and `block-user`.
  - Global flood limit drops excessive events and disconnects sockets on sustained abuse.
- **Automated Cooldown:** If a token accumulates reports from $\ge 3$ distinct reporter tokens who shared verified sessions within 1 hour, that token is temporarily suspended from matchmaking for 1 hour.

---

## 5. Admin Telemetry & Persistence (Phase 8)

When Supabase is integrated in Phase 8:
- Backend writes anonymous session metrics (`sessionId`, `durationSeconds`, `connectionType`, `startedAt`, `endedAt`).
- No personal user identifiers or IP addresses are passed to or stored in Supabase.
- The `/admin` API route authenticates requests by validating the Supabase Auth JWT and verifying MFA status before returning platform aggregate metrics.
