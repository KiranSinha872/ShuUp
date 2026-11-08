import React, { useState, useEffect } from "react";
import { calculateRemainingGraceSeconds } from "../safety-helpers.js";

export default function PreviousPartnerNotice({
  graceExpiresAt,
  onOpenReport,
  onExpire
}) {
  const [secondsRemaining, setSecondsRemaining] = useState(() =>
    calculateRemainingGraceSeconds(graceExpiresAt)
  );

  useEffect(() => {
    if (!graceExpiresAt) return;

    const interval = setInterval(() => {
      const remaining = calculateRemainingGraceSeconds(graceExpiresAt);
      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        onExpire();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [graceExpiresAt, onExpire]);

  if (secondsRemaining <= 0) return null;

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const timeDisplay = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  return (
    <div
      style={{
        padding: "0.6rem 1rem",
        backgroundColor: "#fef3c7",
        border: "1px solid #fde68a",
        borderRadius: "8px",
        marginBottom: "1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: "0.875rem",
        color: "#92400e"
      }}
    >
      <div>
        <span>Previous partner: Need to report an issue from your last call? </span>
        <span style={{ fontWeight: "600", fontSize: "0.8rem", color: "#b45309" }}>
          (Available for {timeDisplay})
        </span>
      </div>
      <button
        type="button"
        onClick={onOpenReport}
        style={{
          padding: "0.35rem 0.75rem",
          fontSize: "0.825rem",
          fontWeight: "600",
          backgroundColor: "#b45309",
          color: "#ffffff",
          border: "none",
          borderRadius: "5px",
          cursor: "pointer"
        }}
      >
        Report Previous Partner
      </button>
    </div>
  );
}

