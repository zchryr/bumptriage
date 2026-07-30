// Extraction of the machine-readable recommendation from the model's report.

export const RECOMMENDATIONS = Object.freeze(["merge", "hold", "reject"]);
export const UNKNOWN_RECOMMENDATION = "unknown";

const VERDICT_PATTERN =
  /(?:^|\n)\s*(?:#+\s*)?(?:\**)?verdict(?:\**)?\s*:\s*(merge|hold|reject)\b/i;

/**
 * Read the `Verdict:` line out of a Markdown report.
 *
 * Returns `"unknown"` when absent or unparseable. Callers must treat the result
 * as advisory: the report is model output derived in part from untrusted text,
 * so this value must never gate an unattended merge on its own.
 */
export function recommendationFrom(report) {
  const match = String(report ?? "").match(VERDICT_PATTERN);
  return match ? match[1].toLowerCase() : UNKNOWN_RECOMMENDATION;
}
