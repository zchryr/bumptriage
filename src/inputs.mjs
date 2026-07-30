// Input reading.
//
// Every input arrives as a `BUMPTRIAGE_*` environment variable, populated by
// `runs.env` in action.yml. Nothing is read from argv: process arguments are
// world-readable through `/proc/<pid>/cmdline`, so any child process — including
// a validation command running a dependency's install script — could recover
// the forge token and the model API key from them. Environment variables are not
// a strong boundary either, which is why validation runs in a separate container
// with its own PID namespace; keeping secrets out of argv removes the easiest
// path rather than the only one.

import { splitList, splitLines, parseBoolean, parsePositiveInteger } from "./text.mjs";
import { BOT_IDS } from "./botprofiles.mjs";

const PREFIX = "BUMPTRIAGE_";

function read(name, env) {
  const value = env[`${PREFIX}${name}`];
  return value === undefined ? "" : String(value).trim();
}

function require_(name, env, hint) {
  const value = read(name, env);
  if (!value) {
    throw new Error(
      `${PREFIX}${name} is required${hint ? ` — ${hint}` : ""}.`,
    );
  }
  return value;
}

export const SUPPORTED_PROVIDERS = Object.freeze([
  "anthropic",
  "bedrock",
  "fireworks",
]);

/**
 * Providers that name a specific vendor, and therefore have a knowable
 * endpoint. `anthropic` is not among them: it selects a wire protocol rather
 * than a service, and can point at a vendor, a gateway, or a self-hosted
 * server, so there is no endpoint bumptriage could pick on the caller's behalf.
 */
export const PROVIDER_DEFAULT_BASE_URLS = Object.freeze({
  fireworks: "https://api.fireworks.ai/inference",
});

export const SUPPORTED_FORGES = Object.freeze(["github", "gitea"]);

/**
 * Parse an optional JSON object mapping model names to provider-specific ids,
 * such as Bedrock inference-profile ARNs.
 */
export function parseModelOverrides(value) {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${PREFIX}MODEL_OVERRIDES is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${PREFIX}MODEL_OVERRIDES must be a JSON object.`);
  }
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") {
      throw new Error(
        `${PREFIX}MODEL_OVERRIDES value for ${JSON.stringify(key)} must be a string.`,
      );
    }
  }
  return parsed;
}

export function readInputs(env = process.env) {
  const provider = (read("PROVIDER", env) || "anthropic").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown provider ${JSON.stringify(provider)}. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }

  const forge = (read("FORGE", env) || "github").toLowerCase();
  if (!SUPPORTED_FORGES.includes(forge)) {
    throw new Error(
      `Unknown forge ${JSON.stringify(forge)}. Supported: ${SUPPORTED_FORGES.join(", ")}.`,
    );
  }

  const bots = splitList(read("BOTS", env) || BOT_IDS.join(","));
  const unknownBots = bots.filter((id) => !BOT_IDS.includes(id));
  if (unknownBots.length > 0) {
    throw new Error(
      `Unknown bots ${unknownBots.map((b) => JSON.stringify(b)).join(", ")}. Known: ${BOT_IDS.join(", ")}.`,
    );
  }

  const trustedAuthors = splitList(read("TRUSTED_AUTHORS", env));
  if (trustedAuthors.length === 0) {
    // Deliberately no default. A default naming accounts that may not exist on
    // a given forge invites an attacker to register one of them and satisfy the
    // gate; the operator has to state which accounts they actually trust.
    throw new Error(
      `${PREFIX}TRUSTED_AUTHORS is required — list the exact account names your update bot uses, e.g. "renovate[bot]".`,
    );
  }

  return {
    provider,
    apiKey: read("API_KEY", env),
    // No default, and required for every provider that talks to an endpoint
    // directly (see validateInputs). A baked-in endpoint would either point at
    // somebody else's server or silently stop working; callers state where
    // their model lives.
    baseUrl:
      read("BASE_URL", env).replace(/\/+$/, "") ||
      PROVIDER_DEFAULT_BASE_URLS[provider] ||
      "",
    model: require_("MODEL", env, "the model identifier your provider expects"),
    modelOverrides: parseModelOverrides(read("MODEL_OVERRIDES", env)),

    forge,
    token: read("TOKEN", env),
    serverUrl: read("SERVER_URL", env).replace(/\/+$/, ""),
    // GitHub serves its API from a different host than its web UI, and GitHub
    // Enterprise Server serves it from a subpath, so this is never derived.
    apiUrl: read("API_URL", env).replace(/\/+$/, ""),
    repository: require_("REPOSITORY", env, "in owner/name form"),
    pullNumber: require_("PR_NUMBER", env),

    trustedAuthors,
    trustedAuthorIds: splitList(read("TRUSTED_AUTHOR_IDS", env)),
    bots,
    branchPrefixes: splitList(read("BRANCH_PREFIXES", env)),
    allowForks: parseBoolean(read("ALLOW_FORKS", env), false),

    postComment: parseBoolean(read("POST_COMMENT", env), true),
    maxTurns: parsePositiveInteger(read("MAX_TURNS", env), 40),

    validationCommands: splitLines(read("VALIDATION_COMMANDS", env)),
    validationResultsPath: read("VALIDATION_RESULTS", env),
    validationImage: read("VALIDATION_IMAGE", env) || "node:24-bookworm-slim",
    validationNetwork: read("VALIDATION_NETWORK", env) || "bridge",
    validationTimeoutSeconds: parsePositiveInteger(
      read("VALIDATION_TIMEOUT_SECONDS", env),
      600,
    ),
    validationTotalTimeoutSeconds: parsePositiveInteger(
      read("VALIDATION_TOTAL_TIMEOUT_SECONDS", env),
      1800,
    ),
    validationMemory: read("VALIDATION_MEMORY", env) || "2g",
    validationCpus: read("VALIDATION_CPUS", env) || "2",
    validationPidsLimit: parsePositiveInteger(read("VALIDATION_PIDS_LIMIT", env), 512),
  };
}

/**
 * Providers that address an HTTP endpoint directly, and therefore must be told
 * which one. Bedrock is absent deliberately: its endpoint is derived from the
 * region by the AWS SDK, so a base URL there is an override for private-link or
 * gateway setups rather than an address anyone normally supplies. Requiring one
 * would mean demanding a value that is ignored.
 */
const PROVIDERS_REQUIRING_BASE_URL = Object.freeze(["anthropic"]);

/** Validate cross-field constraints that depend on the selected provider. */
export function validateInputs(inputs) {
  if (["anthropic", "fireworks"].includes(inputs.provider) && !inputs.apiKey) {
    throw new Error(
      `${PREFIX}API_KEY is required when provider is ${JSON.stringify(inputs.provider)}.`,
    );
  }
  if (PROVIDERS_REQUIRING_BASE_URL.includes(inputs.provider) && !inputs.baseUrl) {
    throw new Error(
      `${PREFIX}BASE_URL is required when provider is ${JSON.stringify(inputs.provider)}. ` +
        'For the hosted Anthropic API use "https://api.anthropic.com". See examples/providers.md.',
    );
  }
  if (!["none", "bridge"].includes(inputs.validationNetwork)) {
    throw new Error(
      `${PREFIX}VALIDATION_NETWORK must be "none" or "bridge", received ${JSON.stringify(inputs.validationNetwork)}.`,
    );
  }
  if (inputs.validationCommands.length > 0 && inputs.validationResultsPath) {
    throw new Error(
      "Set either VALIDATION_COMMANDS (run them here) or VALIDATION_RESULTS (consume transcripts produced elsewhere), not both.",
    );
  }
  if (inputs.postComment && !inputs.token) {
    throw new Error(`${PREFIX}TOKEN is required when post-comment is enabled.`);
  }
  return inputs;
}
