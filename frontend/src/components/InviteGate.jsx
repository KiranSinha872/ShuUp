import React, { useRef, useEffect } from "react";

export default function InviteGate({
  inviteInput,
  setInviteInput,
  isAuthenticating,
  inviteError,
  onSubmit
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  return (
    <div
      style={{
        maxWidth: "480px",
        margin: "4rem auto",
        padding: "2rem",
        backgroundColor: "#ffffff",
        borderRadius: "12px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        textAlign: "center",
        border: "1px solid #e2e8f0"
      }}
    >
      <h2 style={{ fontSize: "1.5rem", fontWeight: "700", marginBottom: "0.5rem", color: "#0f172a" }}>
        Shuup Private Access
      </h2>
      <p style={{ fontSize: "0.9rem", color: "#475569", marginBottom: "1.5rem" }}>
        Shuup is currently in private testing for invited adult testers only. Please enter your invite code to continue.
      </p>

      {inviteError && (
        <div
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "6px",
            color: "#b91c1c",
            fontSize: "0.875rem",
            marginBottom: "1rem",
            textAlign: "left"
          }}
        >
          <strong>Access Denied:</strong> {inviteError}
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: "1rem", textAlign: "left" }}>
          <label
            htmlFor="invite-code-input"
            style={{ display: "block", fontSize: "0.85rem", fontWeight: "600", color: "#334155", marginBottom: "0.35rem" }}
          >
            Invite Code
          </label>
          <input
            id="invite-code-input"
            ref={inputRef}
            type="text"
            value={inviteInput}
            onChange={(e) => setInviteInput(e.target.value)}
            disabled={isAuthenticating}
            placeholder="Paste your invite code here"
            style={{
              width: "100%",
              padding: "0.65rem 0.85rem",
              fontSize: "1rem",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              boxSizing: "border-box"
            }}
          />
        </div>

        <button
          type="submit"
          disabled={isAuthenticating || !inviteInput.trim()}
          style={{
            width: "100%",
            padding: "0.75rem",
            fontSize: "1rem",
            fontWeight: "600",
            backgroundColor: isAuthenticating || !inviteInput.trim() ? "#94a3b8" : "#2563eb",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: isAuthenticating || !inviteInput.trim() ? "not-allowed" : "pointer"
          }}
        >
          {isAuthenticating ? "Verifying..." : "Continue"}
        </button>
      </form>
    </div>
  );
}

