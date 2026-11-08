import test from "node:test";
import assert from "node:assert/strict";
import {
  mapReportResponse,
  validateConsent,
  calculateRemainingGraceSeconds,
  REPORT_CATEGORIES
} from "../src/safety-helpers.js";

test("Phase 7b: Report Categories & Response Mapping", async (t) => {
  await t.test("exports 5 immutable server report categories", () => {
    assert.equal(REPORT_CATEGORIES.length, 5);
    const ids = REPORT_CATEGORIES.map((c) => c.id);
    assert.deepEqual(ids, [
      "urgent_minor_safety",
      "urgent_violence_threat",
      "nudity_sexual_content",
      "harassment_hate",
      "spam_bot"
    ]);
  });

  await t.test("maps successful report callback", () => {
    const res = mapReportResponse({ ok: true, reportId: "test-uuid-123" });
    assert.equal(res.type, "success");
    assert.match(res.message, /Report submitted/i);
  });

  await t.test("maps DUPLICATE_REPORT cleanly", () => {
    const res = mapReportResponse({ ok: false, error: "DUPLICATE_REPORT" });
    assert.equal(res.type, "info");
    assert.match(res.message, /already been submitted/i);
  });

  await t.test("maps INVALID_SESSION cleanly", () => {
    const res = mapReportResponse({ ok: false, error: "INVALID_SESSION" });
    assert.equal(res.type, "error");
    assert.match(res.message, /reporting window for this call has expired/i);
  });

  await t.test("maps STORAGE_LIMIT_REACHED cleanly", () => {
    const res = mapReportResponse({ ok: false, error: "STORAGE_LIMIT_REACHED" });
    assert.equal(res.type, "error");
    assert.match(res.message, /moderation storage is temporarily at capacity/i);
  });

  await t.test("maps NOT_CONNECTED cleanly", () => {
    const res = mapReportResponse({ ok: false, error: "NOT_CONNECTED" });
    assert.equal(res.type, "error");
    assert.match(res.message, /Connection was lost; unable to submit report/i);
  });

  await t.test("maps unexpected error / timeout gracefully", () => {
    const res = mapReportResponse(null);
    assert.equal(res.type, "error");
    assert.match(res.message, /Unable to submit report/i);
  });
});

test("Phase 7b: Consent Gating Logic", async (t) => {
  await t.test("returns false when any required checkbox is false or missing", () => {
    assert.equal(validateConsent({ ageConfirmed: false, p2pConfirmed: true, rulesConfirmed: true }), false);
    assert.equal(validateConsent({ ageConfirmed: true, p2pConfirmed: false, rulesConfirmed: true }), false);
    assert.equal(validateConsent({ ageConfirmed: true, p2pConfirmed: true, rulesConfirmed: false }), false);
    assert.equal(validateConsent({}), false);
    assert.equal(validateConsent(null), false);
  });

  await t.test("returns true strictly when all three checkboxes are true", () => {
    assert.equal(
      validateConsent({
        ageConfirmed: true,
        p2pConfirmed: true,
        rulesConfirmed: true
      }),
      true
    );
  });
});

test("Phase 7b: Post-Call Grace Countdown Calculation", async (t) => {
  const baseTime = 1_000_000;

  await t.test("computes remaining seconds correctly", () => {
    const expiresAt = baseTime + 120_000;
    assert.equal(calculateRemainingGraceSeconds(expiresAt, baseTime), 120);
    assert.equal(calculateRemainingGraceSeconds(expiresAt, baseTime + 30_500), 90);
    assert.equal(calculateRemainingGraceSeconds(expiresAt, baseTime + 119_100), 1);
  });

  await t.test("floors at zero when window has passed", () => {
    const expiresAt = baseTime + 120_000;
    assert.equal(calculateRemainingGraceSeconds(expiresAt, baseTime + 120_001), 0);
    assert.equal(calculateRemainingGraceSeconds(expiresAt, baseTime + 200_000), 0);
  });

  await t.test("handles null or invalid timestamp safely", () => {
    assert.equal(calculateRemainingGraceSeconds(null), 0);
    assert.equal(calculateRemainingGraceSeconds(undefined), 0);
    assert.equal(calculateRemainingGraceSeconds("invalid"), 0);
  });
});

