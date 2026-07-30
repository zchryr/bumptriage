// Assembly of the untrusted evidence bundle handed to the model.
//
// Everything in here originates outside our trust boundary: pull request title
// and body (which embed the dependency's own upstream changelog), the diff,
// repository file contents, and validation command output. The system prompt
// tells the model not to follow instructions found inside any of it. That
// framing is load-bearing and must survive edits to this file.

import { bounded } from "./text.mjs";

export const DIFF_BUDGET = 120_000;
export const VALIDATION_OUTPUT_BUDGET = 40_000;
export const VALIDATION_TOTAL_BUDGET = 120_000;

/**
 * @param {object} args
 * @param {object} args.pull Forge pull request payload.
 * @param {string} args.author Authorized author login.
 * @param {object} args.profile Matched bot profile.
 * @param {string} args.diff Unified diff between base and head.
 * @param {string[]} args.changedFiles Repository-relative paths.
 * @param {object[]} args.validations Validation results, possibly empty.
 */
export function buildEvidence({ pull, author, profile, diff, changedFiles, validations }) {
  return {
    pull_request: {
      number: pull?.number ?? null,
      title: pull?.title ?? null,
      body: pull?.body ?? null,
      url: pull?.html_url ?? null,
      author,
      update_bot: profile.id,
      base: pull?.base?.ref ?? null,
      head: pull?.head?.ref ?? null,
      base_sha: pull?.base?.sha ?? null,
      head_sha: pull?.head?.sha ?? null,
    },
    changed_files: changedFiles,
    diff: bounded(diff, DIFF_BUDGET),
    validations: boundValidations(validations),
  };
}

/**
 * Bound validation transcripts individually and in aggregate, so one noisy
 * command cannot crowd out the rest of the evidence.
 */
export function boundValidations(validations = []) {
  const perCommand = Math.min(
    VALIDATION_OUTPUT_BUDGET,
    Math.floor(VALIDATION_TOTAL_BUDGET / Math.max(1, validations.length)),
  );

  return validations.map((validation) => ({
    command: validation.command,
    image: validation.image ?? null,
    network: validation.network ?? null,
    exit_code: validation.exitCode ?? null,
    succeeded: validation.exitCode === 0,
    timed_out: Boolean(validation.timedOut),
    duration_ms: validation.durationMs ?? null,
    output: bounded(validation.output ?? "", perCommand),
  }));
}

/** Split `git diff --name-only` output into paths. */
export function parseChangedFiles(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
