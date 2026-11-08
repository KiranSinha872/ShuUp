import React, { useState } from "react";
import { validateConsent } from "../safety-helpers.js";

export default function ConsentGate({ onConsentGranted }) {
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [p2pConfirmed, setP2pConfirmed] = useState(false);
  const [rulesConfirmed, setRulesConfirmed] = useState(false);

  const isComplete = validateConsent({
    ageConfirmed,
    p2pConfirmed,
    rulesConfirmed
  });

  function handleSubmit(e) {
    e.preventDefault();
    if (isComplete) {
      onConsentGranted();
    }
  }

  return (
    <div
      style={{
        maxWidth: "540px",
        margin: "3rem auto",
        padding: "2rem",
        backgroundColor: "#ffffff",
        borderRadius: "12px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        border: "1px solid #e2e8f0"
      }}
    >
      <h2 style={{ fontSize: "1.4rem", fontWeight: "700", marginBottom: "0.5rem", color: "#0f172a", textAlign: "center" }}>
        Tester Agreement & Safety Notice
      </h2>

      <div
        style={{
          padding: "0.75rem 1rem",
          backgroundColor: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: "6px",
          color: "#92400e",
          fontSize: "0.85rem",
          marginBottom: "1.25rem",
          lineHeight: "1.4"
        }}
      >
        <strong>Notice:</strong> This is a screen in the browser and the server cannot verify your age. Access is strictly restricted to invited adult testers.
      </div>

      <p style={{ fontSize: "0.875rem", color: "#475569", marginBottom: "1rem", lineHeight: "1.5" }}>
        Live video is not screened in advance and may be offensive. You can leave any conversation immediately at any time by pressing <strong>Next</strong> or <strong>Leave</strong>.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", marginBottom: "1.5rem" }}>
          <label
            htmlFor="consent-age"
            style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontSize: "0.875rem", color: "#1e293b", cursor: "pointer" }}
          >
            <input
              id="consent-age"
              type="checkbox"
              checked={ageConfirmed}
              onChange={(e) => setAgeConfirmed(e.target.checked)}
              style={{ marginTop: "0.2rem" }}
            />
            <span>
              I confirm that I am at least 18 years old and understand this is an experimental prototype restricted to invited adult testers.
            </span>
          </label>

          <label
            htmlFor="consent-p2p"
            style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontSize: "0.875rem", color: "#1e293b", cursor: "pointer" }}
          >
            <input
              id="consent-p2p"
              type="checkbox"
              checked={p2pConfirmed}
              onChange={(e) => setP2pConfirmed(e.target.checked)}
              style={{ marginTop: "0.2rem" }}
            />
            <span>
              I understand that video calls are direct peer-to-peer (P2P), meaning connected partners can technically see my public network address via WebRTC.
            </span>
          </label>

          <label
            htmlFor="consent-rules"
            style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontSize: "0.875rem", color: "#1e293b", cursor: "pointer" }}
          >
            <input
              id="consent-rules"
              type="checkbox"
              checked={rulesConfirmed}
              onChange={(e) => setRulesConfirmed(e.target.checked)}
              style={{ marginTop: "0.2rem" }}
            />
            <span>
              I agree to follow community safety rules and understand I can report or block anyone at any time.
            </span>
          </label>
        </div>

        <button
          type="submit"
          disabled={!isComplete}
          style={{
            width: "100%",
            padding: "0.75rem",
            fontSize: "1rem",
            fontWeight: "600",
            backgroundColor: isComplete ? "#16a34a" : "#94a3b8",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: isComplete ? "pointer" : "not-allowed"
          }}
        >
          Enter Shuup
        </button>
      </form>
    </div>
  );
}

