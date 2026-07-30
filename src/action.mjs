// Entrypoint. This file is wiring only; the logic it calls lives in modules that
// can be tested without a forge, a Docker daemon, or a model endpoint.

import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { readInputs, validateInputs } from "./inputs.mjs";
import { createForge } from "./forge.mjs";
import { resolveProfiles } from "./botprofiles.mjs";
import { authorizeReview } from "./auth.mjs";
import { findRepositoryPath, checkoutRepository, diffBetween } from "./repository.mjs";
import { runValidations, pruneStaleResources } from "./sandbox.mjs";
import { buildEvidence, parseChangedFiles } from "./evidence.mjs";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.mjs";
import { buildProvider } from "./provider.mjs";
import { recommendationFrom } from "./verdict.mjs";
import { upsertComment, MARKER } from "./comment.mjs";
import { setOutput } from "./output.mjs";

/** Read validation transcripts produced by an earlier, unprivileged job. */
async function readValidationResults(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON array of validation results.`);
  }
  return parsed.map((entry) => ({
    command: String(entry.command ?? "unknown"),
    image: entry.image ?? null,
    network: entry.network ?? null,
    exitCode: entry.exitCode ?? entry.exit_code ?? null,
    timedOut: Boolean(entry.timedOut ?? entry.timed_out),
    durationMs: entry.durationMs ?? entry.duration_ms ?? null,
    output: String(entry.output ?? ""),
  }));
}

async function loadPullRequest({ forge, inputs }) {
  if (inputs.token) {
    return forge.getPullRequest({
      repository: inputs.repository,
      number: inputs.pullNumber,
    });
  }

  const eventPath = process.env.GITHUB_EVENT_PATH ?? process.env.GITEA_EVENT_PATH;
  if (!eventPath) {
    throw new Error("A forge token is required to read pull request metadata.");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const pull = event?.pull_request;
  if (!pull) {
    throw new Error(
      "The event payload contains no pull request; supply a token so metadata can be fetched.",
    );
  }
  return pull;
}

async function main() {
  const inputs = validateInputs(readInputs());

  const forge = createForge({
    kind: inputs.forge,
    serverUrl: inputs.serverUrl,
    apiUrl: inputs.apiUrl,
    token: inputs.token,
  });

  const pull = await loadPullRequest({ forge, inputs });

  const profiles = resolveProfiles(inputs.bots, inputs.branchPrefixes);
  const { profile, author } = authorizeReview({
    pull,
    repository: inputs.repository,
    trustedAuthors: inputs.trustedAuthors,
    trustedAuthorIds: inputs.trustedAuthorIds,
    profiles,
    allowForks: inputs.allowForks,
  });

  const baseSha = pull?.base?.sha;
  const headSha = pull?.head?.sha;
  if (!baseSha || !headSha) {
    throw new Error("The pull request is missing base or head commit information.");
  }

  const repositoryPath =
    (await findRepositoryPath({ baseSha, headSha })) ??
    (await checkoutRepository({
      serverUrl: inputs.serverUrl,
      repository: inputs.repository,
      token: inputs.token,
      username: await forge.authenticatedUsername(),
      baseSha,
      headSha,
    }));

  const { diff, changedFiles } = await diffBetween(repositoryPath, baseSha, headSha);

  let validations = [];
  if (inputs.validationResultsPath) {
    validations = await readValidationResults(inputs.validationResultsPath);
  } else if (inputs.validationCommands.length > 0) {
    await pruneStaleResources();
    const outcome = await runValidations({
      repositoryPath,
      headSha,
      commands: inputs.validationCommands,
      image: inputs.validationImage,
      network: inputs.validationNetwork,
      memory: inputs.validationMemory,
      cpus: inputs.validationCpus,
      pidsLimit: inputs.validationPidsLimit,
      timeoutSeconds: inputs.validationTimeoutSeconds,
      totalTimeoutSeconds: inputs.validationTotalTimeoutSeconds,
    });
    validations = outcome.results;
  }

  const evidence = buildEvidence({
    pull,
    author,
    profile,
    diff,
    changedFiles: parseChangedFiles(changedFiles),
    validations,
  });

  const { env, options } = buildProvider(inputs);

  let result;
  for await (const message of query({
    prompt: buildPrompt({ evidence, profile }),
    options: {
      ...options,
      cwd: repositoryPath,
      env,
      model: inputs.model,
      systemPrompt: SYSTEM_PROMPT,
      // The base tool set, not just the permission list: this is what decides
      // which tools exist at all. The reviewing agent reads and searches; it has
      // no shell, no write tools, and no way to execute anything.
      tools: ["Read", "Glob", "Grep"],
      allowedTools: ["Read", "Glob", "Grep"],
      // Deny anything not pre-approved rather than prompting, since there is no
      // human present to answer.
      permissionMode: "dontAsk",
      maxTurns: inputs.maxTurns,
      // Ignore ambient settings files so behaviour depends only on this config.
      settingSources: [],
    },
  })) {
    if (message.type === "result") result = message;
  }

  if (!result || result.subtype !== "success") {
    throw new Error(`The review did not complete: ${result?.subtype ?? "no result"}`);
  }

  const report = `${MARKER}\n## bumptriage review\n\n${result.result}`;
  const reportDirectory = await mkdtemp(path.join(tmpdir(), "bumptriage-report-"));
  const reportPath = path.join(reportDirectory, "review.md");
  await writeFile(reportPath, report);

  const recommendation = recommendationFrom(result.result);
  await setOutput("report-path", reportPath);
  await setOutput("recommendation", recommendation);
  await setOutput("update-bot", profile.id);

  if (inputs.postComment) {
    await upsertComment({
      forge,
      repository: inputs.repository,
      number: pull.number ?? inputs.pullNumber,
      body: report,
    });
  }

  console.log(report);
}

try {
  await main();
} catch (error) {
  // Surface a readable one-line failure rather than a raw stack trace. Messages
  // raised in this codebase never interpolate a token or key; the stack is
  // available behind an opt-in so a debug session does not require a code change.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error title=bumptriage::${message.replaceAll("\n", " ")}`);

  if (error?.name === "AuthorizationError") {
    console.error(
      "This is the authorization gate refusing to review a pull request. " +
        "Check trusted-authors, the head branch prefix, and allow-forks.",
    );
  }

  if (process.env.BUMPTRIAGE_DEBUG && error instanceof Error) {
    console.error(error.stack);
  }

  process.exitCode = 1;
}
