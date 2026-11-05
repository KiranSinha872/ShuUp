import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isCompatible, validateJoinPayload } from "../src/compatibility.js";

describe("isCompatible pure matching logic", () => {
  test("mutually compatible users match (Man wants Women, Woman wants Men)", () => {
    const aman = { identity: "Man", preferences: ["Women"] };
    const priya = { identity: "Woman", preferences: ["Men"] };
    assert.equal(isCompatible(aman, priya), true);
  });

  test("one-way acceptance fails (Ravi accepts Anyone, Sara accepts Women only)", () => {
    const sara = { identity: "Woman", preferences: ["Women"] };
    const ravi = { identity: "Man", preferences: ["Anyone"] };
    assert.equal(isCompatible(sara, ravi), false);
  });

  test("Prefer not to say is accepted by Anyone", () => {
    const userA = { identity: "Prefer not to say", preferences: ["Anyone"] };
    const userB = { identity: "Woman", preferences: ["Anyone"] };
    assert.equal(isCompatible(userA, userB), true);
  });

  test("Prefer not to say is NOT accepted by selecting Men, Women, and Non-binary people together", () => {
    const userA = { identity: "Prefer not to say", preferences: ["Anyone"] };
    const userB = { identity: "Woman", preferences: ["Men", "Women", "Non-binary people"] };
    assert.equal(isCompatible(userA, userB), false);
  });

  test("two Prefer not to say users match if both accept Anyone", () => {
    const userA = { identity: "Prefer not to say", preferences: ["Anyone"] };
    const userB = { identity: "Prefer not to say", preferences: ["Anyone"] };
    assert.equal(isCompatible(userA, userB), true);
  });

  test("null or undefined users return false", () => {
    assert.equal(isCompatible(null, undefined), false);
  });
});

describe("validateJoinPayload pure validation logic", () => {
  test("valid payload with single preference passes", () => {
    const result = validateJoinPayload({
      identity: "Man",
      preferences: ["Women"]
    });
    assert.equal(result.valid, true);
    assert.equal(result.identity, "Man");
    assert.deepEqual(result.preferences, ["Women"]);
  });

  test("rejects wrong identity", () => {
    const result = validateJoinPayload({
      identity: "Alien",
      preferences: ["Anyone"]
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /Invalid identity/);
  });

  test("rejects empty preferences array", () => {
    const result = validateJoinPayload({
      identity: "Woman",
      preferences: []
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /cannot be empty/);
  });

  test("rejects unknown preference item", () => {
    const result = validateJoinPayload({
      identity: "Woman",
      preferences: ["Ghosts"]
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /Unknown preference item/);
  });

  test("rejects non-array preferences", () => {
    const result = validateJoinPayload({
      identity: "Woman",
      preferences: "Men"
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /must be an array/);
  });

  test("rejects unexpected extra fields", () => {
    const result = validateJoinPayload({
      identity: "Woman",
      preferences: ["Men"],
      extraParam: "hack"
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /Unexpected fields/);
  });

  test("rejects oversized array (> 4 items)", () => {
    const result = validateJoinPayload({
      identity: "Woman",
      preferences: ["Men", "Women", "Non-binary people", "Anyone", "Men"]
    });
    assert.equal(result.valid, false);
    assert.match(result.error, /oversized/);
  });

  test("deduplicates preferences and collapses Anyone", () => {
    const result = validateJoinPayload({
      identity: "Non-binary",
      preferences: ["Men", "Anyone", "Men"]
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.preferences, ["Anyone"]);
  });
});

