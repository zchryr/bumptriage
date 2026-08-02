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
 * Reject a credential that cannot be sent as a header value.
 *
 * A key carrying a stray CR or LF — which is what a secret stored with a
 * trailing newline looks like — otherwise fails deep inside the runtime with an
 * error about the request rather than about the credential. This turns that into
 * one readable line at startup.
 */
function assertHeaderSafe(apiKey) {
  if (/[\r\n]/.test(apiKey)) {
    throw new Error(
      "The API key contains a line break, so it cannot be sent as a header. Check for a " +
        "trailing newline in the secret.",
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
    // Fireworks serves the Anthropic Messages API directly and accepts the same
    // `x-api-key` authentication, so it needs nothing beyond its own endpoint
    // and a model id in resource-name form. Verified on 2026-08-01 against a
    // live key: `x-api-key`, `Authorization: Bearer`, and `x-fireworks-api-key`
    // are all accepted on /v1/messages, and prompt caching is honoured rather
    // than rejected. It stays a distinct provider value so that "supported" is a
    // claim about a specific service, and so `inputs.mjs` can supply its
    // endpoint and enforce its model-id rule.
    case "anthropic":
    case "fireworks": {
      if (!inputs.apiKey) {
        throw new Error(`An API key is required for the ${provider} provider.`);
      }
      assertHeaderSafe(inputs.apiKey);
      env.ANTHROPIC_API_KEY = inputs.apiKey;
      if (inputs.baseUrl) env.ANTHROPIC_BASE_URL = inputs.baseUrl;
      break;
    }

    case "bedrock": {
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      for (const key of AWS_VARIABLES) {
        if (processEnv[key]) env[key] = processEnv[key];
      }

      // An `api-key` here is a Bedrock API key, which authenticates as a bearer
      // token and bypasses the AWS credential chain entirely. Set after the
      // passthrough loop so an explicitly configured key wins over one that
      // happened to be in the runner's environment.
      //
      // It also wins over SigV4 credentials sitting in the same environment,
      // but that is the runtime's doing rather than this assignment's: it skips
      // resolving the credential chain at all when AWS_BEARER_TOKEN_BEDROCK is
      // set. So configuring `api-key` on a runner that has already run
      // configure-aws-credentials silently ignores the role. That is the right
      // precedence — the explicit input should win — but it is worth knowing it
      // is not enforced here.
      //
      // Verified against a live endpoint on 2026-08-01: a long-term key
      // (ABSK…, from iam:CreateServiceSpecificCredential) authenticates on
      // /model/{id}/invoke. Note the key alone is not sufficient — the IAM user
      // behind it also needs `bedrock:CallWithBearerToken`, which is a separate
      // action from InvokeModel; without it every request fails 403. See
      // iam/bedrock-api-key-user.yaml.
      if (inputs.apiKey) {
        assertHeaderSafe(inputs.apiKey);
        env.AWS_BEARER_TOKEN_BEDROCK = inputs.apiKey;
      }

      if (inputs.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = inputs.baseUrl;

      if (!env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
        throw new Error(
          "AWS_REGION is required for the bedrock provider — the endpoint is derived from " +
            "it even when an api-key carries the authentication. Set it in the job's env, or " +
            "configure credentials before this step with aws-actions/configure-aws-credentials.",
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
          "No AWS credentials found for the bedrock provider. Pass a Bedrock API key as " +
            "api-key, or assume a role with OIDC, or supply static access keys, before this " +
            "step runs.",
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
