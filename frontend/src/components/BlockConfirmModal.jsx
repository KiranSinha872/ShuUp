import React, { useEffect, useRef } from "react";

export default function BlockConfirmModal({
  isOpen,
  onConfirm,
  onCancel,
  isSubmitting = false
}) {
  const cancelBtnRef = useRef(null);
  const previousActiveElement = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    previousActiveElement.current = document.activeElement;

    if (cancelBtnRef.current) {
      cancelBtnRef.current.focus();
    }

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement.current && typeof previousActiveElement.current.focus === "function") {
        previousActiveElement.current.focus();
      }
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="block-modal-title"
        style={{
          width: "100%",
          maxWidth: "420px",
          backgroundColor: "#ffffff",
          borderRadius: "12px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          padding: "1.75rem",
          boxSizing: "border-box",
          textAlign: "center"
        }}
      >
        <h2 id="block-modal-title" style={{ fontSize: "1.25rem", fontWeight: "700", margin: "0 0 0.75rem 0", color: "#b91c1c" }}>
          Block Partner?
        </h2>
        <p style={{ fontSize: "0.95rem", color: "#334155", margin: "0 0 1.5rem 0", lineHeight: "1.5" }}>
          You will immediately leave this call, and you won't be matched with this user for a while.
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: "0.75rem" }}>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              padding: "0.6rem 1.25rem",
              fontSize: "0.95rem",
              fontWeight: "600",
              color: "#475569",
              backgroundColor: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: isSubmitting ? "not-allowed" : "pointer"
            }}
          >
            Keep Talking
          </button>

          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            style={{
              padding: "0.6rem 1.25rem",
              fontSize: "0.95rem",
              fontWeight: "600",
              color: "#ffffff",
              backgroundColor: isSubmitting ? "#94a3b8" : "#dc2626",
              border: "none",
              borderRadius: "6px",
              cursor: isSubmitting ? "not-allowed" : "pointer"
            }}
          >
            {isSubmitting ? "Blocking..." : "Confirm Block"}
          </button>
        </div>
      </div>
    </div>
  );
}

