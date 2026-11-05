export const VALID_IDENTITIES = Object.freeze([
  "Man",
  "Woman",
  "Non-binary",
  "Prefer not to say"
]);

export const VALID_PREFERENCES = Object.freeze([
  "Men",
  "Women",
  "Non-binary people",
  "Anyone"
]);

function accepts(preferences, identity) {
  if (preferences.includes("Anyone")) return true;
  if (identity === "Prefer not to say") return false;
  if (identity === "Man") return preferences.includes("Men");
  if (identity === "Woman") return preferences.includes("Women");
  if (identity === "Non-binary") return preferences.includes("Non-binary people");
  return false;
}

export function isCompatible(userA, userB) {
  if (!userA || !userB) return false;
  return accepts(userA.preferences, userB.identity) && accepts(userB.preferences, userA.identity);
}

export function validateJoinPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, error: "Payload must be a non-null object" };
  }

  // Reject extra fields
  const allowedKeys = new Set(["identity", "preferences"]);
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.some((k) => !allowedKeys.has(k))) {
    return { valid: false, error: "Unexpected fields in payload" };
  }

  // Validate identity
  if (typeof payload.identity !== "string" || !VALID_IDENTITIES.includes(payload.identity)) {
    return { valid: false, error: "Invalid identity" };
  }

  // Validate preferences array
  if (!Array.isArray(payload.preferences)) {
    return { valid: false, error: "Preferences must be an array" };
  }

  if (payload.preferences.length === 0) {
    return { valid: false, error: "Preferences cannot be empty" };
  }

  // Oversized array guard (at most 4 valid preferences exist)
  if (payload.preferences.length > 4) {
    return { valid: false, error: "Preferences array is oversized" };
  }

  // Validate preference elements
  for (const pref of payload.preferences) {
    if (typeof pref !== "string" || !VALID_PREFERENCES.includes(pref)) {
      return { valid: false, error: "Unknown preference item" };
    }
  }

  // Deduplicate preferences
  const deduplicated = [...new Set(payload.preferences)];

  // If "Anyone" is chosen, normalize to ["Anyone"]
  const normalized = deduplicated.includes("Anyone") ? ["Anyone"] : deduplicated;

  return {
    valid: true,
    identity: payload.identity,
    preferences: normalized
  };
}

