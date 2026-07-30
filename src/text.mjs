// Text helpers shared by evidence assembly and validation transcripts.

/**
 * Truncate to a budget while keeping both ends.
 *
 * Keeping only the head would be the wrong half: a failing build's useful
 * output — the error, the stack, the summary line — is almost always at the
 * tail. Keeping both ends costs nothing and stops the model from reasoning
 * about a truncated success prefix of a failed command.
 */
export function bounded(value, max, { headRatio = 0.6 } = {}) {
  const text = String(value ?? "");
  if (text.length <= max) return text;

  const marker = "\n[… truncated …]\n";
  const budget = Math.max(0, max - marker.length);
  const headLength = Math.floor(budget * headRatio);
  const tailLength = budget - headLength;

  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

/** Split a comma- or newline-separated list into trimmed, non-empty entries. */
export function splitList(value) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Split a newline-separated list, preserving commas inside each entry. */
export function splitLines(value) {
  return String(value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse a boolean input. Unset or empty means false; only explicit truthy words enable. */
export function parseBoolean(value, fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  throw new Error(`Expected a boolean value, received ${JSON.stringify(value)}.`);
}

/** Parse a positive integer input, falling back when unset. */
export function parsePositiveInteger(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}.`);
  }
  return parsed;
}
