# Shuup - UI & Design Specifications

This document outlines the user interface layout, design system, and component specifications. All design proposals below are marked as **[PROPOSED]** pending user review and approval.

---

## 1. Layout Architecture [PROPOSED]

Shuup employs a responsive, dark-mode-first split-screen layout designed for immediate clarity and zero cognitive clutter.

```text
+--------------------------------------------------------------+
|  [Logo] Shuup                    ● 12 Online   [About/Admin] |
+--------------------------------------------------------------+
|                                                              |
|   +--------------------------+  +-------------------------+  |
|   |                          |  |                         |  |
|   |                          |  |                         |  |
|   |       Remote Video       |  |       Local Video       |  |
|   |      (Partner Stream)    |  |     (Self Preview)      |  |
|   |                          |  |                         |  |
|   +--------------------------+  +-------------------------+  |
|                                                              |
+--------------------------------------------------------------+
|  Status: Searching for someone compatible... (Waiting 12s)   |
+--------------------------------------------------------------+
|   [ Preferences ]      [ ▶ Start ]   [ ⏭ Next ]   [ ⏹ Stop ]  |
+--------------------------------------------------------------+
```

### Layout Specifications:
- **Desktop:** Two equal video panes positioned side-by-side (16:9 or 4:3 aspect ratio).
- **Mobile:** Video panes stacked vertically (partner stream on top, local self preview below).
- **Control Bar:** Fixed or centered bottom bar containing the primary action buttons (`Start`, `Next`, `Stop`) and quick access to `Preferences`.
- **Status Indicator:** Clear text status row directly below the video frames showing current state (`Searching`, `Matched`, `Broaden Search?`).
- **Header:** Lightweight navigation displaying the Shuup logo and live online user counter.

---

## 2. Visual Design System [PROPOSED]

### 2.1 Color Palette
- **Background Deep:** `#0B0F19` (rich dark blue-gray, avoids pure `#000000` eye strain)
- **Surface / Card:** `#1E293B` (slate background for video frames and modal backdrops)
- **Border / Divider:** `#334155` (subtle contrast borders)
- **Brand Primary:** `#6366F1` (Indigo / Electric Iris - distinct from legacy Omegle blue/orange)
- **Brand Primary Hover:** `#4F46E5`
- **Action Success (Start):** `#10B981` (Emerald green)
- **Action Skip (Next):** `#3B82F6` (Sky blue)
- **Action Danger (Stop/Leave):** `#EF4444` (Ruby red)
- **Text Primary:** `#F8FAFC` (Off-white, 100% readable)
- **Text Secondary / Muted:** `#94A3B8` (Slate gray for labels and counters)

### 2.2 Typography
- **Font Family:** System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`)
  - *Rationale:* Zero network latency, instant rendering, native platform feel.
- **Scale:**
  - App Header / Brand: `20px` (bold)
  - Video Overlay Labels: `12px` (semibold, semi-transparent pill)
  - Control Action Buttons: `16px` (semibold)
  - Status Indicators: `14px` (regular)

### 2.3 Spacing & Radius
- **Base Grid:** `8px` (`8px`, `16px`, `24px`, `32px`)
- **Border Radius:**
  - Video Frames: `12px` (`rounded-xl`)
  - Action Buttons: `10px` (`rounded-lg`)
  - Modals / Drawers: `16px` (`rounded-2xl`)

---

## 3. Core Component Wireframes & Behaviors

### 3.1 Consent & Rules Modal (First Visit)
- Appears before asking for camera/mic permissions.
- Explicit `18+` confirmation checkbox.
- Code of conduct: No nudity, no hate speech, mutual respect.
- Single confirmation button: `"I am 18+ and Agree to Rules"`.

### 3.2 Preferences Drawer / Modal
- **Identity Selection (Single Select):**
  - Radio pills: `Man` | `Woman` | `Non-binary` | `Prefer not to say`
- **Match Preferences (Multi-Select):**
  - Checkbox pills: `Men` | `Women` | `Non-binary people` | `Anyone`
  - Explanatory note: *"Selecting 'Anyone' matches you with all users, including those who prefer not to state their identity."*

### 3.3 Call Controls
- Explicitly scoped for prototype: `Start`, `Next`, `Leave/Stop`.
- **Excluded by design:** Mute toggle, camera disable toggle, text chat, country filter.

### 3.4 In-Call Safety Trigger
- Discrete `Report / Block` flag button anchored to the remote video pane.
- Clicking opens a concise modal:
  - Radio options: Inappropriate behavior, underage suspicion, spam/harassment.
  - Buttons: `Submit Report`, `Block User` (ends call and blacklists partner from rematching).

---

## 4. Open Items
- [OPEN] Custom vector logo icon asset for "Shuup" branding.
- [OPEN] Admin dashboard graphical charts vs tabular breakdown for the 7-day metric view.

