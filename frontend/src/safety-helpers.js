/**
 * Pure helper functions for Phase 7b Trust & Safety UI flows.
 */

export const REPORT_CATEGORIES = Object.freeze([
  { id: "urgent_minor_safety", label: "Urgent: Minor safety / exploitation" },
  { id: "urgent_violence_threat", label: "Urgent: Threat of violence or self-harm" },
  { id: "nudity_sexual_content", label: "Nudity or sexual content" },
  { id: "harassment_hate", label: "Harassment or hate speech" },
  { id: "spam_bot", label: "Spam or automated bot" }
]);

/**
 * Maps server report callback response to human-readable message and status.
 */
export function mapReportResponse(res) {
  if (res && res.ok === true) {
    return {
      type: "success",
      message: "Report submitted. Thank you for keeping Shuup safe."
    };
  }

  const err = res && res.error;
  if (err === "DUPLICATE_REPORT") {
    return {
      type: "info",
      message: "A report has already been submitted for this session."
    };
  }

  if (err === "INVALID_SESSION") {
    return {
      type: "error",
      message: "The reporting window for this call has expired."
    };
  }

  if (err === "STORAGE_LIMIT_REACHED") {
    return {
      type: "error",
      message: "Report recorded, but moderation storage is temporarily at capacity."
    };
  }

  if (err === "INVALID_CATEGORY" || err === "INVALID_REPORT") {
    return {
      type: "error",
      message: "Invalid report category or payload. Please select a valid category."
    };
  }

  if (err === "NOT_CONNECTED") {
    return {
      type: "error",
      message: "Connection was lost; unable to submit report."
    };
  }

  return {
    type: "error",
    message: "Unable to submit report. Please try again."
  };
}

/**
 * Validates the three mandatory consent checkboxes.
 */
export function validateConsent(flags) {
  if (!flags || typeof flags !== "object") return false;
  return (
    flags.ageConfirmed === true &&
    flags.p2pConfirmed === true &&
    flags.rulesConfirmed === true
  );
}

/**
 * Calculates remaining seconds in the post-call 120s grace period.
 */
export function calculateRemainingGraceSeconds(expiresAt, now = Date.now()) {
  if (!expiresAt || typeof expiresAt !== "number") return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}
