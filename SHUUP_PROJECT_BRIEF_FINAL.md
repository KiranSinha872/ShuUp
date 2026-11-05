# Shuup: Final Project Brief for the AI Agent

Read this whole file before doing anything. It describes what I am building, how it should work, my constraints, my folder setup, and how I want you to work with me. Do not write code until I confirm your plan.

---

## 1. What Shuup is

Shuup is a browser-based, one-to-one random video chat website, inspired by the general idea of Omegle/OmeTV. A user opens the site, picks their matching preferences, presses Start, and joins a waiting queue. When a mutually compatible user is available, the two are paired and a real-time audio/video call starts directly between their browsers.

**Main product goal:** matching should be preference-aware and transparent. Users should not have to pay just to say who they would like to meet.

## 2. About me and how I want you to work

- My skills: HTML, CSS, JavaScript, React, Next.js, Node.js, Express. I have used Supabase and Firebase.
- I am building with **free resources and open-source tools** wherever possible.
- **Frontend and backend are separate projects** so I can work on each independently.
- Guide me **step by step**. One milestone at a time. Finish and test one step before the next.
- Explain the reasoning behind each step briefly. I want to understand the logic, not only paste code.
- Don't jump ahead to later milestones or add features I didn't ask for.
- When there is a trade-off (free-tier limits, hosting), tell me the trade-off and recommend one option.
- Keep things as simple as possible. This is a prototype first.
- Ask me before making decisions listed in section 14.

## 3. Project folder layout (already created)

I am working in an IDE with this folder structure:

```
Shuup/
├── SHUUP_PROJECT_BRIEF_FINAL.md   <- this file
├── frontend/                      <- React / Next.js app
└── backend/                       <- Node.js + Socket.IO server
```

- `frontend` and `backend` are fully independent projects. Each has its own `package.json`, its own dependencies, its own `.env` and its own start command.
- The only connection between them is the backend URL (stored in one frontend environment variable) and the event names in section 8.
- Run them on different ports locally (for example frontend 3000, backend 4000).
- The backend must allow the frontend's address in its CORS settings.

### Git setup notes

- My IDE warns that a git repository exists at my **home folder** (`/Users/kiransinha`) with too many changes. That is an unrelated, accidental repo. Do not touch or delete it.
- Shuup should have **its own repository**: run `git init` inside the `Shuup` folder (ask me to confirm before doing it).
- Create a `.gitignore` in `frontend` and `backend` from the start. It must exclude `node_modules`, `.env` and `.env.*` files, build output, and OS junk files like `.DS_Store`.
- Never commit secrets. Invite codes, TURN credentials and database keys live only in `.env` files. Provide a `.env.example` in each folder listing variable names without values.

## 4. The three separate responsibilities

Keep these separate in the design and in the code:

1. **Matchmaking:** decides which two users get paired.
2. **Signaling:** carries setup messages (offer, answer, ICE candidates) between the two browsers so they can connect.
3. **Media transport:** the actual audio/video, carried by WebRTC directly browser-to-browser, or through a TURN relay when a direct path is impossible.

The server never carries video. Socket.IO is only for queue events and signaling messages.

## 5. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React or Next.js | In `frontend/` |
| Backend | Node.js + Socket.IO | In `backend/`. Express is optional; plain Node plus Socket.IO is enough for the prototype. |
| Realtime | Socket.IO | Queue events, signaling, report/block events |
| Media | Browser-native WebRTC | No video SDK needed |
| Connectivity | STUN + TURN | Free public STUN to start. For TURN, prefer a free-tier managed service for the prototype. Self-hosting Coturn is a later option. |
| Database | Supabase (preferred) | Added late, only for reports, invite codes and optional accounts. Not used in the matching path. |
| Frontend hosting | Vercel or Cloudflare Pages | Free |
| Backend hosting | Render (free tier sleeps when idle) or similar | Vercel cannot host long-lived WebSocket servers |

Check current free-tier quotas before relying on any provider. Free software is not free to operate at scale: TURN bandwidth is the main cost risk.

## 6. Matching logic (core of the product)

### 6.1 Data per user

| Field | Example | Purpose |
|---|---|---|
| gender_identity | man / woman / non-binary / prefer not to say | Self-declared, optional. Never inferred from face, voice, name or appearance. |
| match_preferences | women / men / non-binary people / anyone | Who this user is willing to be matched with |
| queue_status | waiting / matched / disconnected | Current state |
| session_id | unique ID | Identifies the temporary session |
| joined_queue_at | timestamp | Used for "longest waiter first" |
| recent_partners | short list | Prevents instant rematch after Next |

### 6.2 Mutual compatibility rule

A pairing is valid only if **both** checks pass:

1. User A's preferences accept User B's identity.
2. User B's preferences accept User A's identity.

Also: neither user may already be in a session, and they must not be recent partners.

### 6.3 How the queue behaves

- The live queue is kept **in server memory** for the prototype. No database in the matching path.
- When a user joins, the server checks the people already waiting and picks the compatible one who has **waited longest**.
- If found: remove both from the queue, create a unique session, send "matched" to both clients.
- If not found: add the user to the queue and send a "waiting" status.
- The "find a match and remove both from the queue" step must be **one synchronous block with no awaits in the middle**. Node is single-threaded, so this prevents a user from being matched twice.
- Optional optimization: keep waiting users in buckets keyed by (identity, accepted set). With few identity options the bucket count is tiny, and "broaden preferences" just adds the user to more buckets.

### 6.4 Worked example with 6 users arriving in order

| Order | Person | Identity | Wants |
|---|---|---|---|
| 1 | Aman | man | women |
| 2 | Priya | woman | men |
| 3 | Sara | woman | women |
| 4 | Ravi | man | anyone |
| 5 | Neha | woman | men |
| 6 | Alex | non-binary | anyone |

1. Aman joins. Queue empty, so he waits.
2. Priya joins. Aman wants women and she is a woman. She wants men and he is a man. Both pass, so Aman and Priya are matched.
3. Sara joins. Queue empty, so she waits.
4. Ravi joins. Sara is waiting. Ravi accepts anyone, but Sara wants women only and he is a man. Fails. Ravi waits.
5. Neha joins. Sara first: Neha wants men, so it fails. Ravi next: he accepts anyone and Neha wants men. Both pass, so Neha and Ravi are matched.
6. Alex joins. Sara wants women only, so it fails. Alex waits.

Result: two calls running; Sara and Alex still waiting.

### 6.5 Broadening preferences (opt-in only)

- If nobody compatible is found, keep the user waiting and show a clear status.
- After a configurable wait (for example 30 seconds), ask: "No matches yet. Want to widen your search?"
- **Never silently override a user's preferences.** A fallback match happens only after the user opts in, and only if the pairing is still mutually compatible.
- In the example above, if Sara opts in, she can be matched with Alex.

### 6.6 Other rules

- **Skip / Next:** the user goes back into the queue, but the server remembers their last partner(s) so they are not instantly rematched.
- **Disconnect or tab close:** remove the user from the queue, end the session, notify the partner, clean up all state.
- **Honesty about guarantees:** the platform cannot guarantee a match with a particular group. It depends on who is online. Never write copy promising guaranteed access to any group. With few users, long waits are normal.
- Self-declared preferences can be gamed. Word the UI modestly and build reporting early.

## 7. How a call is established

1. Browser asks for camera and mic permission (`getUserMedia`).
2. Client emits `join-queue`.
3. Server finds a mutually compatible user, creates a session, emits `matched` to both.
4. The caller creates an offer; the other side sets it, creates an answer and sends it back.
5. Both sides exchange ICE candidates through Socket.IO. STUN/TURN settings help find a working route.
6. WebRTC carries audio/video directly (or via TURN). Socket.IO does not carry video.
7. Either user can leave, report, block or press Next.

## 8. Event contract (between `frontend` and `backend`)

| Event | Direction | Purpose |
|---|---|---|
| join-queue | client to server | Enter matchmaking, with identity and preferences |
| queue-status | server to client | Waiting / searching updates |
| broaden-prompt | server to client | Ask whether to widen preferences after the wait |
| broaden-accept | client to server | User opts in to wider preferences |
| matched | server to both clients | New session created; includes session_id and which client is the caller |
| offer / answer | client to server to partner | WebRTC session descriptions |
| ice-candidate | client to server to partner | ICE connection candidates |
| leave-session | client to server | End current pairing or press Next |
| partner-left | server to client | Partner disconnected or ended |
| report-user / block-user | client to server | Safety and moderation actions |

Signaling rules:

- The server stores who is paired with whom. Every offer, answer and ICE message is forwarded **only to the stored partner**. Never trust a partner ID sent by the client.
- Use a **fixed role** (the server tells one side "you are the caller") or the "perfect negotiation" pattern, so both sides never send offers at once.

## 9. Safety, privacy and trust (required, not optional)

- **Private, invite-only testing first, with known adult testers only.** Enforce it with a simple invite-code gate (a few codes in an environment variable at first).
- Do not enable unrestricted stranger-to-stranger video for minors. Any public release needs real adult verification, not just a checkbox. Plan for this before opening beyond testers.
- Show clear community rules and get consent before camera/mic activation.
- Report and block controls available during every session.
- Rate limits, spam prevention and repeat-abuser controls.
- A moderation workflow and a way to handle urgent reports.
- Do not record or store calls by default. Explain any data collection clearly.
- Never expose phone numbers, emails, IP addresses or private account details to other users.
- Never infer gender from face, voice, name or appearance.

## 10. Robustness requirements

- Prevent duplicate queue entries and duplicate events.
- No user can be matched twice (single synchronous match step).
- Heartbeat and a "ghost cleanup" timer so stale sockets don't get matched with real users.
- Handle disconnects, timeouts, reconnects and rapid Next presses.
- Handle camera/microphone permission denied or unavailable.
- If the backend ever runs on more than one instance, the in-memory queue is not enough. Use Redis or similar. Not needed for the prototype.
- Log whether each call used a direct connection or a TURN relay (from WebRTC stats). This feeds cost planning.
- Add a feature flag so preference matching can be switched to "match with anyone" while testing the call pipeline.

## 11. Cost reality

- Software licensing cost for the prototype: zero.
- The real costs are bandwidth and TURN relay traffic. Free hosting may sleep, limit ports, cap concurrent connections or cap bandwidth.
- A free tunnel (Cloudflare Tunnel or ngrok) lets me test from a friend's phone on mobile data without deploying, which shows whether TURN is actually needed.
- Approach: build locally, test across networks, measure how often TURN is needed, then pick hosting based on real numbers. Don't promise unlimited free service.

## 12. Build order (riskiest part first)

Work through these in order. Don't skip ahead.

1. **Setup:** confirm `frontend` and `backend` run separately and talk through one "hello" event. Git init and `.gitignore` files.
2. **WebRTC first:** two browser tabs on localhost video-calling each other through a bare signaling server. No queue, no preferences. First tab in is always the caller. No TURN needed on localhost.
3. **Queue:** any two waiting users get paired. Session IDs and private rooms.
4. **Preferences:** identity and preference options, mutual compatibility check, longest-waiter-first.
5. **Lifecycle:** Next/skip, recent-partner memory, disconnect and reconnect handling, ghost cleanup, broaden-preferences prompt.
6. **Connectivity:** STUN config, TURN service, tests across different networks.
7. **Trust and safety:** report, block, rate limits, invite-code gate, moderation workflow.
8. **Persistence:** Supabase for invite codes, reports and optional accounts, with authenticated and restricted access.
9. **Deployment:** frontend on Vercel/Cloudflare Pages, backend on Render or similar, end-to-end test with monitoring and quota checks.

Acceptance check for every step: it works with two real browsers before moving on.

## 13. Rules for the agent

- Plan first, code second. Wait for my confirmation after each plan.
- Make small changes and tell me which files you changed and why.
- Don't install packages, delete files, or run git commands without telling me first.
- Don't touch anything outside the `Shuup` folder.
- Don't store secrets in code. Use `.env` files.
- If something in this brief is unclear or conflicts with itself, ask me instead of guessing.

## 14. Open decisions (ask me, don't assume)

- Final list of identity options and preference options, and their exact wording.
- Wait time before the broaden prompt is shown.
- Next.js or plain React for the frontend.
- Which free TURN provider to try first.
- Project name: "Shuup" is also the name of an existing open-source e-commerce platform, so check domain and handle availability. This does not block development.

## 15. First request to the agent

Please start by:

1. Summarizing your understanding of this project in a few lines so I can confirm.
2. Proposing the folder structure inside `frontend` and `backend`.
3. Walking me through build step 1, then step 2, one at a time, waiting for me to confirm each works before continuing.

Do not write code until I confirm your summary and structure.
