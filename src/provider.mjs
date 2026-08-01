// Model provider configuration.
//
// This builds the environment handed to the Agent SDK subprocess. The SDK
// *replaces* the subprocess environment with whatever it is given rather than
// merging it with the parent's, so this allowlist is the whole environment the
// model process sees. It must never be widened to a blanket `...process.env`
// spread: the forge token lives in this process's environment, and nothing the
// model runs has any use for it.

/** Variables the model subprocess needs to function at all. */
const PASSTHROUGH = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);

/**
 * Every model-selection variable the CLI consults.
 *
 * A deployment serving exactly one model has to pin all of them, not just the
 * primary: the CLI otherwise reaches for a differently-named small model for
 * background work such as summarisation and subagent turns, and that request
 * fails against a single-model endpoint.
 */
const MODEL_ALIASES = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
]);

/** Suppress traffic unrelated to serving this review. */
const EGRESS_HYGIENE = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
});

const AWS_VARIABLES = Object.freeze([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

/**
 * Fireworks' Anthropic-compatibility layer rejects two fields the runtime would
 * otherwise send, with a 400 rather than by ignoring them, so both have to be
 * suppressed before the first request rather than tolerated.
 *
 * `cache_control` — Fireworks lists it as unsupported and returns
 * `invalid_request_error` naming `tools[N].cache_control`. `DISABLE_PROMPT_CACHING`
 * is the runtime's own switch for omitting it everywhere. The cost is real: no
 * prompt caching, so a review re-sends its whole evidence bundle each turn.
 *
 * `eager_input_streaming` — attached to tool schemas when a feature gate is on.
 * The gate is remote and defaults off, which would make this work by luck;
 * setting the fine-grained-tool-streaming switch to a false value short-circuits
 * the check outright, so behaviour does not depend on a flag we do not control.
 *
 * Both variable names were confirmed against the pinned runtime binary rather
 * than taken from documentation written for a different client.
 */
const FIREWORKS_COMPATIBILITY = Object.freeze({
  DISABLE_PROMPT_CACHING: "1",
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "0",
});

/**
 * Reject a credential that could break out of the header it is embedded in.
 *
 * `ANTHROPIC_CUSTOM_HEADERS` is parsed by splitting on newlines and then on the
 * first colon, so a key containing CR or LF would inject additional headers into
 * every model request. The value here is operator-supplied rather than
 * attacker-supplied, which makes this a guard against a mangled secret — a
 * trailing newline survives a copy-paste or a `cat`-ed file more often than
 * anyone expects — rather than against an adversary.
 */
function assertHeaderSafe(apiKey) {
  if (/[\r\n]/.test(apiKey)) {
    throw new Error(
      "The API key contains a line break, which would inject extra headers into every " +
        "model request. Check for a trailing newline in the secret.",
    );
  }
}

/**
 * @returns {{env: Record<string,string>, options: object}} `options` is a
 *   fragment spread into the Agent SDK's `query()` options. Bedrock model
 *   selection travels there rather than through the environment, because
 *   inference-profile mapping is only expressible via `modelOverrides`.
 */
export function buildProvider(inputs, processEnv = process.env) {
  const { provider, model } = inputs;

  const env = {};
  for (const key of PASSTHROUGH) {
    if (processEnv[key]) env[key] = processEnv[key];
  }
  for (const key of MODEL_ALIASES) {
    env[key] = model;
  }
  Object.assign(env, EGRESS_HYGIENE);

  const options = {};

  switch (provider) {
    case "anthropic": {
      if (!inputs.apiKey) {
        throw new Error(`An API key is required for the ${provider} provider.`);
      }
      assertHeaderSafe(inputs.apiKey);
      env.ANTHROPIC_API_KEY = inputs.apiKey;
      if (inputs.baseUrl) env.ANTHROPIC_BASE_URL = inputs.baseUrl;
      break;
    }

    // Fireworks serves the Anthropic Messages API directly, so it shares the
    // wire protocol — but not the authentication or the accepted field set, so
    // it is not simply `anthropic` with a different URL.
    case "fireworks": {
      if (!inputs.apiKey) {
        throw new Error(`An API key is required for the ${provider} provider.`);
      }
      assertHeaderSafe(inputs.apiKey);

      // Fireworks reads `x-fireworks-api-key`; this is how the vendor's own
      // Claude Code integration authenticates, and the runtime has no other way
      // to send a header it does not know about. `ANTHROPIC_API_KEY` is set as
      // well, for a different reason: without a credential in the variable it
      // looks for, the runtime treats the session as unauthenticated and looks
      // for an interactive login, which never arrives in CI.
      env.ANTHROPIC_API_KEY = inputs.apiKey;
      env.ANTHROPIC_CUSTOM_HEADERS = `x-fireworks-api-key: ${inputs.apiKey}`;
      if (inputs.baseUrl) env.ANTHROPIC_BASE_URL = inputs.baseUrl;
      Object.assign(env, FIREWORKS_COMPATIBILITY);
      break;
    }

    case "bedrock": {
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      for (const key of AWS_VARIABLES) {
        if (processEnv[key]) env[key] = processEnv[key];
      }
      if (inputs.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = inputs.baseUrl;

      if (!env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
        throw new Error(
          "AWS_REGION is required for the bedrock provider. Configure credentials before " +
            "this step, for example with aws-actions/configure-aws-credentials.",
        );
      }
      const hasCredentials =
        env.AWS_ACCESS_KEY_ID ||
        env.AWS_WEB_IDENTITY_TOKEN_FILE ||
        env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
        env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
        env.AWS_BEARER_TOKEN_BEDROCK;
      if (!hasCredentials) {
        throw new Error(
          "No AWS credentials found in the environment for the bedrock provider. Assume a " +
            "role with OIDC, or supply static access keys, before this step runs.",
        );
      }

      // `model` is already a Bedrock model id or inference-profile ARN, and every
      // alias above points at it, so no mapping is needed in the common case.
      // `modelOverrides` exists for deployments that want to keep Anthropic-style
      // model names in configuration and translate them to profile ARNs here.
      if (inputs.modelOverrides && Object.keys(inputs.modelOverrides).length > 0) {
        options.modelOverrides = { ...inputs.modelOverrides };
      }
      break;
    }

    default:
      throw new Error(`Unknown provider ${JSON.stringify(provider)}.`);
  }

  return { env, options };
}
