# Shuup - Moderation Procedure & Runbook

> **Disclaimer:** The creator and operator of this application is not a lawyer. This software is an experimental prototype restricted exclusively to known, invited adult testers. You must seek proper legal counsel before inviting anyone beyond your own trusted devices or releasing this service to the public.

---

## 1. Legal Duties & Emergency Contacts

### 1.1 Legal Reporting Duties
- **Mandatory Reporting:** You must research whether the laws in your country or jurisdiction impose legal duties on operators of communications services to report child sexual abuse material (CSAM), child sexual exploitation and abuse (CSAE), or imminent threats of violence to law enforcement or child protection agencies.
- **Seek Professional Advice:** Do not deploy or invite external users without consulting a qualified legal professional regarding your jurisdiction's reporting obligations, intermediary liability, and privacy laws.

### 1.2 Official Contacts to Fill In (Operator Research Required)
Fill in the official contact details for your jurisdiction before inviting testers:
- **Child Protection Authority:** `[INSERT NATIONAL CHILD PROTECTION AUTHORITY AND HOW TO CONTACT IT]`
- **Local Emergency Services (Police / Ambulance):** `[INSERT LOCAL EMERGENCY NUMBER]`
- **Hotline for Illegal Online Content:** `[INSERT REGIONAL HOTLINE FOR ILLEGAL CONTENT]`

*(Note: Do not invent phone numbers or URLs. Research and verify official reporting endpoints directly.)*

---

## 2. Real-Time Alert Monitoring

- **No Admin Dashboard in Phase 7:** There is no web admin dashboard or database in Phase 7 (Supabase and the `/admin` telemetry route arrive in Phase 8).
- **Terminal Alerts:** Operators must monitor the backend process terminal output (`stdout` / `stderr`).
- **Urgent Notifications:** When an urgent report is submitted (`urgent_minor_safety` or `urgent_violence_threat`), the backend immediately outputs a terminal alert:
  ```text
  [URGENT SAFETY ALERT] Category: <category> | Session: <sessionId> | ReportId: <reportId> | Time: <timestamp>
  ```
  *(The user note, raw token, and IP address are never displayed in the terminal alert to prevent PII leaks).*

---

## 3. How to Read and Preserve Moderation Reports

### 3.1 Report Storage Location
- Reports are appended to: `backend/data/reports.jsonl`
- **File Permissions:** Set to mode `0600` (`-rw-------`), readable strictly by the process owner.
- **Git Status:** Both `backend/data/` and `data/` are strictly ignored by git (`.gitignore`). Never stage or commit report files.

### 3.2 Inspecting Reports
To inspect recent reports, run in your terminal:
```bash
tail -n 20 backend/data/reports.jsonl
```

Each line is a self-contained JSON record:
```json
{
  "reportId": "d5a8...",
  "timestamp": "2026-11-06T14:00:00.000Z",
  "sessionId": "b4f2...",
  "category": "harassment_hate",
  "note": "Sanitized user comment",
  "reportedHashedToken": "9f83a...",
  "reporterHashedToken": "1e24c..."
}
```

### 3.3 Preserving Evidence Before Rotation or Cleanup
- Video and audio streams are ephemeral peer-to-peer WebRTC connections. **Zero video or audio is ever recorded or stored by Shuup.**
- Evidence consists entirely of: timestamp, session ID, sanitized text note, and HMAC-SHA256 hashed client tokens.
- **Backup Rule:** Always copy `reports.jsonl` to a secure, private, encrypted location before rotating or deleting anything:
  ```bash
  cp backend/data/reports.jsonl ~/secure-backups/reports-$(date +%Y%m%d-%H%M%S).jsonl
  ```

---

## 4. Response Procedures by Category

The server does **not** record which invite code a specific user submitted during handshake (to maintain zero link between tokens and codes). Follow these procedures:

### 4.1 Category: `urgent_minor_safety`
1. **Immediate Session Termination:** Stop the backend server immediately (`Ctrl + C` or `kill`). Restarting the server is the only way to immediately terminate all active peer calls and clear server memory.
2. **Preserve Report Record:** Copy `backend/data/reports.jsonl` to a secure private backup folder.
3. **Ban Reported User Token:**
   - Copy `reportedHashedToken` from the report record.
   - Add it to `BANNED_TOKENS` in `backend/.env`:
     ```text
     BANNED_TOKENS=<reportedHashedToken>,<otherHashes>
     ```
4. **Rotate ALL Invite Codes:** Because the server cannot identify which invite code was used by the offender, immediately rotate **all** invite codes in `backend/.env` under `INVITE_CODES`. Distribute the new codes only to verified, trusted adult testers.
5. **Report to Authorities:** Submit a report to your national child protection authority:
   - Provide the session timestamp, category, and report ID.
   - **Crucial Rule:** Never attempt to view, verify, request, or store illegal images or video frames under any circumstances.
6. **Restart Backend Server:** Start the server with the updated `backend/.env`.

### 4.2 Category: `urgent_violence_threat`
1. **Terminate & Restart Server:** Restart the server to terminate all ongoing sessions and clear sockets.
2. **Preserve Report Record:** Securely back up `backend/data/reports.jsonl`.
3. **Ban Reported User Token:** Add `reportedHashedToken` to `BANNED_TOKENS` in `backend/.env`.
4. **Rotate Invite Codes:** Rotate all `INVITE_CODES` if the source is unknown or compromised.
5. **Contact Emergency Services:** If the threat is credible, specific, or imminent, contact local emergency services immediately using the official contact details for your jurisdiction.

### 4.3 Categories: `nudity_sexual_content`, `harassment_hate`, `spam_bot`
1. **Review History:** Check `backend/data/reports.jsonl` to see if `reportedHashedToken` has previous reports from distinct sessions.
2. **Automated Cooldown:** If 3 distinct verified partners have reported this token, the server automatically suspends the token from matchmaking for 1 hour.
3. **Permanent Ban:** If behavior is repeated or abusive, permanently ban the token by adding `reportedHashedToken` to `BANNED_TOKENS` in `backend/.env` and restarting the backend.
4. **Invite Code Rotation:** If widespread spam or abuse occurs, rotate all `INVITE_CODES`.

---

## 5. Technical Realities & Inherent Limits

What the application **cannot** prevent:
1. **Direct P2P Network Address Visibility:** In direct WebRTC mode (`ICE_TRANSPORT_POLICY=all`), peers connect directly and exchange candidates. A technically skilled user can inspect network packets and see their connected partner's public IP address. Testers must be informed.
2. **External Screen Capture:** The app cannot prevent a peer from recording their monitor with external cameras or recording software.
3. **Dishonest or Retaliatory Reports:** Users may submit false reports against partners. The distinct-reporter threshold ($\ge 3$ distinct sessions) mitigates single-user retaliatory attacks, but manual operator review of notes is required before permanent bans.
4. **Client-Side Self-Certification:** The browser 18+ consent checkboxes cannot physically verify user age. Formal third-party ID verification is deferred post-prototype.
5. **Previous-Partner Window Ephemerality:** The 120-second post-call reporting window is bound to the active socket session in server memory. It **does not survive a socket disconnect, network interruption, or page reload**. If a user's connection drops, the reporting window for their previous call is closed.

