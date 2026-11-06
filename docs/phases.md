# Shuup - Development Phases & Acceptance Criteria

Development proceeds sequentially through 9 distinct phases. Each milestone must be verified and confirmed working before advancing to the next.

---

### Phase 1: Setup & Connection Baseline
- **Scope:**
  - Initialize dedicated Git repository strictly inside `/Users/kiransinha/Desktop/Shuup` with root, frontend, and backend `.gitignore` files.
  - Set up `frontend/` (Vite + React, plain JS) and `backend/` (Node `http` + Socket.IO).
  - Implement GET `/health` endpoint returning `{ status: "ok" }`.
  - Wire up a basic `"ping"` / `"pong"` Socket.IO event between frontend and backend.
- **Acceptance Check:**
  - Works with two real browsers opening the frontend, connecting to the backend on separate ports (e.g. 5173 & 4000), and logging successful socket connections.

---

### Phase 2: WebRTC Signaling Baseline (Localhost Video Call)
- **Scope:**
  - Request camera and microphone access via `navigator.mediaDevices.getUserMedia`.
  - Establish peer connection between two tabs via bare signaling (offer, answer, ICE candidates).
  - Designate fixed roles: first tab to connect is caller, second is callee.
  - Configure Google public STUN (`stun:stun.l.google.com:19302`). No TURN needed on localhost.
  - Render local and remote video streams in the UI.
- **Acceptance Check:**
  - Works with two real browsers: Tab A and Tab B establish a bidirectional audio/video call on localhost with zero queue logic.

---

### Phase 3: In-Memory Queue & Private Rooms
- **Scope:**
  - Implement backend in-memory waiting queue (FIFO without preference filters).
  - Server pairs any two waiting users, creates a unique `sessionId`, assigns caller/callee roles, and joins them to a private Socket.IO room.
  - Transition frontend UI state machine: `idle` -> `waiting` -> `connected`.
- **Acceptance Check:**
  - Works with two real browsers: Opening two tabs sequentially enters both into the queue and automatically transitions both into a private video session.

---

### Phase 4: Preference-Aware Matchmaking
- **Scope:**
  - Implement frontend Preferences UI (Identity: Man, Woman, Non-binary, Prefer not to say; Preferences: Men, Women, Non-binary people, Anyone).
  - Implement backend synchronous mutual compatibility matching algorithm with longest-waiter-first ordering.
  - Implement special rule: `Anyone` is the only preference accepting `Prefer not to say`.
- **Acceptance Check:**
  - Works with two real browsers: Tabs with incompatible preferences wait in queue without matching; tabs with mutually compatible preferences match immediately.

---

### Phase 5: Session Lifecycle & Robustness
- **Scope:**
  - Implement `Next` / `Leave` actions with partner notification (`partner-left`).
  - Add in-memory `recent_partners` cache to prevent instant rematching.
  - Implement 30-second waiting timer with opt-in `broaden-prompt` and `broaden-accept`.
  - Implement heartbeat and disconnect cleanup (ghost socket removal).
- **Acceptance Check:**
  - Works with two real browsers: Clicking `Next` terminates the call cleanly, skips instant rematching, and broadens preferences after 30s when no matches are available.

---

### Phase 6: Network Connectivity (STUN Baseline & TURN Deferred)
- **Phase 6a (Complete):**
  - Implement ICE management in `ice.js`: delivers `iceServers` (Google public STUN baseline) and `iceTransportPolicy` (`"all"` default, `"relay"` configurable) inside `matched`.
  - Log WebRTC connection statistics (`connection-stats` event) to detect direct vs relay candidate pairs without storing IP addresses.
  - Relay-without-TURN refusal: if `ICE_TRANSPORT_POLICY="relay"` without credentials, call is refused cleanly without falling back to STUN.
  - Ephemeral ICE server delivery in `matched`, mid-call disconnect recovery (5s timer), and zero client-side ICE credentials.
- **Phase 6b (Deferred):**
  - Deferred: no free no-card TURN option chosen; STUN-only for now; revisit if real users cannot connect.
  - The TURN fetch and configuration logic in `ice.js` remains dormant until credentials exist in `backend/.env`. Provider choice remains open.
- **Acceptance Check:**
  - Works with two real browsers establishing direct P2P connection via STUN baseline, logging candidate pair stats and handling network disconnect cleanly.

---

### Phase 7: Trust, Safety & Invite Gate
- **Phase 7a (Implemented, Awaiting Verification):**
  - **Handshake Invite Gate:** Server-side validation via `crypto.timingSafeEqual` against `INVITE_CODES` with per-token+address lockout (5 attempts in 15 mins).
  - **Token Hashing & Zero Secret Logging:** Client token stored in `localStorage`, hashed via `HMAC-SHA256` with `SERVER_SALT`. Zero logging of raw tokens, codes, or notes.
  - **Startup Safeguards:** `validateStartupConfig()` checks `SERVER_SALT` ($\ge 32$) and `INVITE_CODES` ($\ge 16$) on startup, exiting cleanly without logging secrets.
  - **Multi-Tier Rate Limiting:** Token-bucket rate limits per event type (30-candidate ICE burst; strict queue/safety limits) and global flood limiter.
  - **Grace Period & Abuse Controls:** 120s post-call grace window for reporting/blocking; 24h in-memory bidirectional block check inside `isCompatible`; automated 1h cooldown after $\ge 3$ distinct verified partner reports.
  - **Reports Storage:** Appends sanitized incident records to `backend/data/reports.jsonl` (file mode `0600`, git-ignored, 10MB cap); urgent categories trigger high-visibility terminal alert.
  - **Minimal Client Integration:** Bare invite-code input screen preceding camera/preview; Start button disabled until media is ready.
- **Phase 7b (Planned):**
  - Consent screen: Explicit 18+ declaration and Community Rules agreement checkboxes before media activation.
  - In-call `Report` and `Block` UI buttons and modal dialog.
  - Operational moderation protocol documentation (`docs/moderation-procedure.md`).
  - Full manual two-browser verification across invite, report, block, and cooldown flows.
- **Acceptance Check:**
  - Works with real browsers: Handshake rejects unauthorized or locked-out connections; authorized users enter with client token; reports append to reports.jsonl; blocked partners cannot be rematched.

---

### Phase 8: Persistence & Admin Dashboard
- **Scope:**
  - Integrate Supabase database: store invite codes, moderation reports, and anonymous session telemetry (`sessionId`, `durationSeconds`, `connectionType`).
  - Create protected `/admin` frontend page.
  - Implement admin authentication via Supabase Auth with Multi-Factor Authentication (MFA).
  - Backend verifies admin JWT and MFA status to serve live platform statistics:
    - Current online users.
    - Total calls completed.
    - Total call minutes.
    - 7-day rolling call volume.
- **Acceptance Check:**
  - Works with two real browsers making calls while the `/admin` dashboard updates and accurately reflects real-time platform statistics following MFA login.

---

### Phase 9: Production Deployment & Verification
- **Scope:**
  - [OPEN] Validate domain name and social handles for "Shuup" prior to final publishing.
  - Deploy frontend to Vercel or Cloudflare Pages.
  - Deploy backend to Render (or equivalent long-lived WebSocket host).
  - Configure production CORS origins, security headers, and environment variables.
- **Acceptance Check:**
  - Works with two real browsers on distinct devices accessing the live production URL end-to-end.

