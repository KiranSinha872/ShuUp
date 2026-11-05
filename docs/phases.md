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

### Phase 6: Network Connectivity & TURN Relay
- **Scope:**
  - [OPEN] Verify current free quota limits for Metered.ca TURN service.
  - Add TURN server configuration credentials to backend config and relay to clients.
  - Log WebRTC connection statistics (`RTCIceCandidatePairStats`) to detect direct vs TURN relay usage.
- **Acceptance Check:**
  - Works with two real browsers across different networks (e.g., home Wi-Fi and mobile hotspot via Cloudflare Tunnel/ngrok), maintaining stable audio and video.

---

### Phase 7: Trust, Safety & Invite Gate
- **Scope:**
  - Add invite-code gate (checked against `INVITE_CODES` environment variable).
  - Implement first-visit 18+ confirmation and Community Rules modal.
  - Implement in-call `Report` and `Block` controls with server-side recording.
  - Apply socket event rate-limiting to prevent spamming.
- **Acceptance Check:**
  - Works with two real browsers: Unauthorized users are blocked by the invite gate; authorized users can report and block partners, ensuring blocked partners cannot be rematched.

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

