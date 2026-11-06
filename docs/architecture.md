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
| `partner-left` | Server -> Client | `{ reason: "left" \| "disconnected" }` | Notifies remaining peer that partner left | Implemented (Phase 2) |
| `report-user` | Client -> Server | `{ sessionId: string, reason: string }` | Flags current partner for moderation | Planned (Phase 7) |
| `block-user` | Client -> Server | `{ sessionId: string }` | Blocks current partner from rematching | Planned (Phase 7) |

---

## 4. ICE Connectivity & Privacy Architecture (Phase 6)

### 4.1 ICE Policy & Privacy
- **Direct Mode (`iceTransportPolicy: "all"`):** Default for the private tester phase. Peers attempt peer-to-peer connection via STUN. **Privacy limitation:** Direct mode reveals the user's public IP address to the connected partner via WebRTC candidate exchange.
- **Relay Mode (`iceTransportPolicy: "relay"`):** Hides both peers' IP addresses behind the TURN relay server. **Public release requirement:** A public launch must enforce relay mode with adequate TURN bandwidth capacity to uphold Section 9 privacy rules.
- **Relay-Without-TURN Refusal:** If `ICE_TRANSPORT_POLICY` is set to `"relay"` but no TURN credentials are valid/available, the server refuses to fall back to STUN. It terminates the pairing immediately with a clear error so IP addresses are never exposed accidentally.

### 4.2 Credential Protection
- Turn credentials are kept exclusively on the server in `backend/.env`.
- The server delivers short-lived credentials directly inside the `matched` Socket.IO event.
- Zero TURN or ICE configuration is stored in client code or client environment variables.

### 4.3 Phase 6b Tunnel Testing Guidelines (For Later Verification)
- When testing mobile data against a laptop via Cloudflare Tunnel (`cloudflared`):
  1. Open the laptop browser through the frontend tunnel URL too (not `localhost`) so both clients test on equivalent network topologies.
  2. Restrict Vite `allowedHosts` in `frontend/vite.config.js` to the exact tunnel hostname, and remove it immediately after testing.
  3. Note that ad-hoc quick-tunnel URLs change on every process restart, and the application does not yet have an invite-code gate (coming in Phase 7).

---

## 5. Admin Telemetry & Persistence (Phase 8)

When Supabase is integrated in Phase 8:
- Backend writes anonymous session metrics (`sessionId`, `durationSeconds`, `connectionType`, `startedAt`, `endedAt`).
- No personal user identifiers or IP addresses are passed to or stored in Supabase.
- The `/admin` API route authenticates requests by validating the Supabase Auth JWT and verifying MFA status before returning platform aggregate metrics.
