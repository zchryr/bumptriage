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

test("fireworks carries no compatibility workarounds", () => {
  // Probed against a live key on 2026-08-01: Fireworks accepts x-api-key, and
  // accepts cache_control and eager_input_streaming rather than rejecting them.
  // Nothing here should be suppressing either — an unnecessary
  // DISABLE_PROMPT_CACHING would turn off caching that demonstrably works and
  // charge the user for it. See scripts/fireworks-smoke.mjs.
  const { env } = buildProvider(fireworksInputs, {});
  assert.equal(env.DISABLE_PROMPT_CACHING, undefined);
  assert.equal(env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING, undefined);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("an API key containing a line break is refused", () => {
  for (const inputs of [anthropicInputs, fireworksInputs]) {
    assert.throws(
      () => buildProvider({ ...inputs, apiKey: "fw-key\r\n" }, {}),
      /line break/,
      inputs.provider,
    );
  }
});
