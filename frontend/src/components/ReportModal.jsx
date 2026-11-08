import React, { useState, useEffect, useRef } from "react";
import { REPORT_CATEGORIES, mapReportResponse } from "../safety-helpers.js";

export default function ReportModal({
  isOpen,
  targetSessionId,
  partnerLabel = "partner",
  onSubmitReport,
  onClose
}) {
  const [category, setCategory] = useState("harassment_hate");
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const modalRef = useRef(null);
  const selectRef = useRef(null);
  const previousActiveElement = useRef(null);

  // Focus trap & Escape key listener
  useEffect(() => {
    if (!isOpen) return;

    previousActiveElement.current = document.activeElement;

    // Reset fields on open
    setCategory("harassment_hate");
    setNote("");
    setIsSubmitting(false);
    setFeedback(null);

    // Focus first interactive control
    if (selectRef.current) {
      selectRef.current.focus();
    }

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (previousActiveElement.current && typeof previousActiveElement.current.focus === "function") {
        previousActiveElement.current.focus();
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!targetSessionId || isSubmitting) return;

    setIsSubmitting(true);
    setFeedback(null);

    onSubmitReport(
      {
        sessionId: targetSessionId,
        category,
        note: note.slice(0, 200)
      },
      (res) => {
        setIsSubmitting(false);
        const mapped = mapReportResponse(res);
        setFeedback(mapped);
        if (mapped.type === "success" || mapped.type === "info") {
          setTimeout(() => {
            onClose(true); // Close with success flag
          }, 1800);
        }
      }
    );
  }

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
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-modal-title"
        style={{
          width: "100%",
          maxWidth: "480px",
          backgroundColor: "#ffffff",
          borderRadius: "12px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          padding: "1.75rem",
          boxSizing: "border-box"
        }}
      >
        <h2 id="report-modal-title" style={{ fontSize: "1.25rem", fontWeight: "700", margin: "0 0 0.5rem 0", color: "#0f172a" }}>
          Report {partnerLabel}
        </h2>
        <p style={{ fontSize: "0.85rem", color: "#64748b", margin: "0 0 1.25rem 0" }}>
          Reports are reviewed by human operators and appended to private moderation records. Session ID:{" "}
          <code>{targetSessionId ? targetSessionId.slice(0, 8) : "none"}...</code>
        </p>

        {feedback && (
          <div
            role="status"
            style={{
              padding: "0.75rem",
              borderRadius: "6px",
              marginBottom: "1rem",
              fontSize: "0.875rem",
              backgroundColor: feedback.type === "success" ? "#f0fdf4" : feedback.type === "info" ? "#eff6ff" : "#fef2f2",
              color: feedback.type === "success" ? "#15803d" : feedback.type === "info" ? "#1d4ed8" : "#b91c1c",
              border: `1px solid ${feedback.type === "success" ? "#bbf7d0" : feedback.type === "info" ? "#bfdbfe" : "#fecaca"}`
            }}
          >
            {feedback.message}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="report-category-select"
              style={{ display: "block", fontSize: "0.875rem", fontWeight: "600", color: "#334155", marginBottom: "0.35rem" }}
            >
              Violation Category
            </label>
            <select
              id="report-category-select"
              ref={selectRef}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "0.6rem 0.75rem",
                fontSize: "0.95rem",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                backgroundColor: "#f8fafc",
                boxSizing: "border-box"
              }}
            >
              {REPORT_CATEGORIES.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.35rem" }}>
              <label
                htmlFor="report-note-textarea"
                style={{ fontSize: "0.875rem", fontWeight: "600", color: "#334155" }}
              >
                Optional Details (max 200 chars)
              </label>
              <span style={{ fontSize: "0.75rem", color: note.length >= 200 ? "#dc2626" : "#64748b" }}>
                {note.length}/200
              </span>
            </div>
            <textarea
              id="report-note-textarea"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 200))}
              disabled={isSubmitting}
              rows={3}
              placeholder="Briefly describe what happened..."
              style={{
                width: "100%",
                padding: "0.6rem 0.75rem",
                fontSize: "0.9rem",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                boxSizing: "border-box",
                fontFamily: "inherit",
                resize: "vertical"
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
            <button
              type="button"
              onClick={() => onClose()}
              disabled={isSubmitting}
              style={{
                padding: "0.55rem 1rem",
                fontSize: "0.9rem",
                fontWeight: "600",
                color: "#475569",
                backgroundColor: "#f1f5f9",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: isSubmitting ? "not-allowed" : "pointer"
              }}
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                padding: "0.55rem 1.25rem",
                fontSize: "0.9rem",
                fontWeight: "600",
                color: "#ffffff",
                backgroundColor: isSubmitting ? "#94a3b8" : "#dc2626",
                border: "none",
                borderRadius: "6px",
                cursor: isSubmitting ? "not-allowed" : "pointer"
              }}
            >
              {isSubmitting ? "Submitting..." : "Submit Report"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

