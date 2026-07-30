// GitHub-Actions-style step outputs.

import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";

/**
 * Append a step output.
 *
 * Uses the heredoc form unconditionally so a value containing a newline or an
 * `=` cannot be misparsed, or be used to inject an additional output.
 */
export async function setOutput(name, value, { env = process.env } = {}) {
  const target = env.GITHUB_OUTPUT;
  if (!target) return false;

  const delimiter = `bumptriage_${randomUUID().replaceAll("-", "")}`;
  const text = String(value ?? "");
  if (text.includes(delimiter)) {
    throw new Error("Generated output delimiter collided with the value.");
  }

  try {
    await appendFile(target, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(`Could not write output ${name}: GITHUB_OUTPUT is not writable.`);
      return false;
    }
    throw error;
  }
}
