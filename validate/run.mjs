// Runs validation commands in the unprivileged half of the two-workflow setup
// and records the transcripts for the privileged review job to consume.
//
// This deliberately imports the same sandbox used by the action itself, which
// has no dependencies outside Node's standard library, so this composite action
// needs no install step.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runValidations, pruneStaleResources } from "../src/sandbox.mjs";
import { splitLines, parsePositiveInteger } from "../src/text.mjs";

const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const outputDirectory = required("BUMPTRIAGE_VALIDATE_OUTPUT_DIR");
const headSha = required("BUMPTRIAGE_VALIDATE_HEAD_SHA");
const prNumber = required("BUMPTRIAGE_VALIDATE_PR_NUMBER");
const commands = splitLines(env.BUMPTRIAGE_VALIDATE_COMMANDS ?? "");

await mkdir(outputDirectory, { recursive: true });

// The review job re-fetches authoritative pull request metadata from the forge;
// this file only carries the identifiers needed to find it, because everything
// produced by this job is untrusted.
await writeFile(
  path.join(outputDirectory, "pull-request.json"),
  `${JSON.stringify({ number: prNumber, head_sha: headSha }, null, 2)}\n`,
);

let results = [];

if (commands.length === 0) {
  console.log("No validation commands configured; recording an empty transcript.");
} else {
  await pruneStaleResources();
  const outcome = await runValidations({
    repositoryPath: env.BUMPTRIAGE_VALIDATE_REPOSITORY_PATH || process.cwd(),
    headSha,
    commands,
    image: env.BUMPTRIAGE_VALIDATE_IMAGE || "node:24-bookworm-slim",
    network: env.BUMPTRIAGE_VALIDATE_NETWORK || "bridge",
    memory: env.BUMPTRIAGE_VALIDATE_MEMORY || "2g",
    cpus: env.BUMPTRIAGE_VALIDATE_CPUS || "2",
    pidsLimit: parsePositiveInteger(env.BUMPTRIAGE_VALIDATE_PIDS_LIMIT, 512),
    timeoutSeconds: parsePositiveInteger(env.BUMPTRIAGE_VALIDATE_TIMEOUT_SECONDS, 600),
    totalTimeoutSeconds: parsePositiveInteger(
      env.BUMPTRIAGE_VALIDATE_TOTAL_TIMEOUT_SECONDS,
      1800,
    ),
  });
  results = outcome.results;
}

await writeFile(
  path.join(outputDirectory, "validations.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);

for (const result of results) {
  const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
  console.log(`${result.command} → ${status} (${result.durationMs}ms)`);
}

// A failing validation is evidence for the reviewer, not a reason to fail this
// job: the review still needs to run, and it needs to see the failure.
console.log(`Recorded ${results.length} validation result(s).`);
