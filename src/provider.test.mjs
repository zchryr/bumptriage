import test from "node:test";
import assert from "node:assert/strict";

import { buildProvider } from "./provider.mjs";

const anthropicInputs = {
  provider: "anthropic",
  model: "some-model-id",
  apiKey: "test-key",
  baseUrl: "",
  modelOverrides: {},
};

test("anthropic sets the key and every model alias", () => {
  const { env } = buildProvider(anthropicInputs, { PATH: "/usr/bin" });

  assert.equal(env.ANTHROPIC_API_KEY, "test-key");
  for (const alias of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    // Background and subagent work uses separately-named models; a
    // single-model endpoint must have these pinned too or those turns fail.
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
  ]) {
    assert.equal(env[alias], "some-model-id", alias);
  }
});

test("the model environment is an allowlist, not an inheritance of process.env", () => {
  const { env } = buildProvider(anthropicInputs, {
    PATH: "/usr/bin",
    HOME: "/root",
    // Things that must never reach the model subprocess.
    BUMPTRIAGE_TOKEN: "forge-token",
    GITHUB_TOKEN: "gh-token",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SOME_OTHER_SECRET: "nope",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/root");

  for (const leaked of [
    "BUMPTRIAGE_TOKEN",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SOME_OTHER_SECRET",
  ]) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the model process`);
  }

  assert.ok(
    !Object.values(env).includes("forge-token"),
    "the forge token must not appear anywhere in the model environment",
  );
});

test("anthropic omits the base URL when unset and applies it when given", () => {
  const withoutBase = buildProvider(anthropicInputs, {});
  assert.equal(withoutBase.env.ANTHROPIC_BASE_URL, undefined);

  const withBase = buildProvider(
    { ...anthropicInputs, baseUrl: "https://models.example.test" },
    {},
  );
  assert.equal(withBase.env.ANTHROPIC_BASE_URL, "https://models.example.test");
});

test("anthropic requires an API key", () => {
  assert.throws(
    () => buildProvider({ ...anthropicInputs, apiKey: "" }, {}),
    /API key is required/,
  );
});

test("telemetry and auto-update egress is disabled", () => {
  const { env } = buildProvider(anthropicInputs, {});
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.equal(env.DISABLE_TELEMETRY, "1");
  assert.equal(env.DISABLE_ERROR_REPORTING, "1");
});

const bedrockInputs = {
  provider: "bedrock",
  model: "us.anthropic.example-model-v1:0",
  apiKey: "",
  baseUrl: "",
  modelOverrides: {},
};

test("bedrock forwards credentials from the environment", () => {
  const { env } = buildProvider(bedrockInputs, {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_SESSION_TOKEN: "session",
  });

  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(env.AWS_REGION, "us-east-1");
  assert.equal(env.AWS_SESSION_TOKEN, "session");
  assert.equal(env.ANTHROPIC_MODEL, "us.anthropic.example-model-v1:0");
});

test("bedrock accepts web-identity credentials without static keys", () => {
  const { env } = buildProvider(bedrockInputs, {
    AWS_REGION: "eu-west-1",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/example",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/token",
  });
  assert.equal(env.AWS_ROLE_ARN, "arn:aws:iam::123456789012:role/example");
});

test("bedrock fails clearly when region or credentials are missing", () => {
  assert.throws(
    () => buildProvider(bedrockInputs, { AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" }),
    /AWS_REGION is required/,
  );
  assert.throws(
    () => buildProvider(bedrockInputs, { AWS_REGION: "us-east-1" }),
    /No AWS credentials found/,
  );
});

test("bedrock passes model overrides through as SDK options", () => {
  const overrides = { "claude-example": "arn:aws:bedrock:us-east-1:1:inference-profile/x" };
  const { options } = buildProvider(
    { ...bedrockInputs, modelOverrides: overrides },
    { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" },
  );
  assert.deepEqual(options.modelOverrides, overrides);
});

test("bedrock omits modelOverrides when none are configured", () => {
  const { options } = buildProvider(bedrockInputs, {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "x",
    AWS_SECRET_ACCESS_KEY: "y",
  });
  assert.equal(options.modelOverrides, undefined);
});

const fireworksInputs = {
  provider: "fireworks",
  model: "accounts/fireworks/models/example-model",
  apiKey: "fw-key",
  baseUrl: "https://api.fireworks.ai/inference",
  modelOverrides: {},
};

test("fireworks configures the Anthropic wire protocol against its own endpoint", () => {
  const { env } = buildProvider(fireworksInputs, {});
  assert.equal(env.ANTHROPIC_API_KEY, "fw-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.fireworks.ai/inference");
  assert.equal(env.ANTHROPIC_MODEL, "accounts/fireworks/models/example-model");
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test("fireworks requires an API key", () => {
  assert.throws(
    () => buildProvider({ ...fireworksInputs, apiKey: "" }, {}),
    /API key is required for the fireworks provider/,
  );
});

test("fireworks authenticates with the header Fireworks actually reads", () => {
  const { env } = buildProvider(fireworksInputs, {});
  // Fireworks reads x-fireworks-api-key. The runtime can only send a header it
  // does not know about through this variable, which it parses as newline-
  // separated `Name: Value` pairs split on the first colon.
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-fireworks-api-key: fw-key");
});

test("fireworks suppresses the two fields its endpoint rejects with a 400", () => {
  const { env } = buildProvider(fireworksInputs, {});
  // Not cosmetic: Fireworks returns invalid_request_error naming
  // `tools[N].cache_control` rather than ignoring the field, so leaving prompt
  // caching on fails every request rather than merely costing money.
  assert.equal(env.DISABLE_PROMPT_CACHING, "1");
  // Setting this to a false value short-circuits the runtime's check outright,
  // so eager_input_streaming cannot be attached by a remote feature gate
  // flipping on later.
  assert.equal(env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, "0");
});

test("neither compatibility switch leaks into the other providers", () => {
  for (const inputs of [anthropicInputs, bedrockInputs]) {
    const { env } = buildProvider(inputs, {
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "x",
      AWS_SECRET_ACCESS_KEY: "y",
    });
    assert.equal(env.DISABLE_PROMPT_CACHING, undefined, inputs.provider);
    assert.equal(
      env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING,
      undefined,
      inputs.provider,
    );
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined, inputs.provider);
  }
});

test("an API key containing a line break is refused rather than embedded", () => {
  // ANTHROPIC_CUSTOM_HEADERS is newline-delimited, so a key with a trailing
  // newline would append an attacker- or accident-controlled header to every
  // model request.
  for (const provider of ["anthropic", "fireworks"]) {
    const inputs = provider === "fireworks" ? fireworksInputs : anthropicInputs;
    assert.throws(
      () => buildProvider({ ...inputs, apiKey: "fw-key\nx-injected: value" }, {}),
      /line break/,
      provider,
    );
    assert.throws(
      () => buildProvider({ ...inputs, apiKey: "fw-key\r\n" }, {}),
      /line break/,
      provider,
    );
  }
});
