import test from "node:test";
import assert from "node:assert/strict";

import { readInputs, validateInputs, parseModelOverrides } from "./inputs.mjs";

function env(overrides = {}) {
  return {
    BUMPTRIAGE_MODEL: "some-model",
    BUMPTRIAGE_REPOSITORY: "acme/widgets",
    BUMPTRIAGE_PR_NUMBER: "7",
    BUMPTRIAGE_TRUSTED_AUTHORS: "renovate[bot]",
    BUMPTRIAGE_TOKEN: "forge-token",
    BUMPTRIAGE_API_KEY: "model-key",
    BUMPTRIAGE_BASE_URL: "https://api.anthropic.com",
    ...overrides,
  };
}

test("reads inputs from the environment, never from argv", () => {
  const inputs = readInputs(env());
  assert.equal(inputs.model, "some-model");
  assert.equal(inputs.repository, "acme/widgets");
  assert.equal(inputs.pullNumber, "7");
  assert.deepEqual(inputs.trustedAuthors, ["renovate[bot]"]);
});

test("trusted-authors is required with no default", () => {
  assert.throws(
    () => readInputs(env({ BUMPTRIAGE_TRUSTED_AUTHORS: "" })),
    /TRUSTED_AUTHORS is required/,
  );
});

test("model is required", () => {
  assert.throws(() => readInputs(env({ BUMPTRIAGE_MODEL: "" })), /MODEL is required/);
});

test("base-url has no baked-in default and is required for endpoint providers", () => {
  assert.equal(
    readInputs(env({ BUMPTRIAGE_BASE_URL: "" })).baseUrl,
    "",
    "no default endpoint may ever be assumed",
  );

  assert.throws(
    () => validateInputs(readInputs(env({ BUMPTRIAGE_BASE_URL: "" }))),
    /BASE_URL is required/,
  );
});

test("bedrock does not require a base URL, since AWS derives it from the region", () => {
  const inputs = validateInputs(
    readInputs(
      env({ BUMPTRIAGE_PROVIDER: "bedrock", BUMPTRIAGE_API_KEY: "", BUMPTRIAGE_BASE_URL: "" }),
    ),
  );
  assert.equal(inputs.provider, "bedrock");
  assert.equal(inputs.baseUrl, "");
});

test("trailing slashes are stripped from URLs", () => {
  const inputs = readInputs(
    env({
      BUMPTRIAGE_BASE_URL: "https://models.example.test///",
      BUMPTRIAGE_API_URL: "https://api.example.test/",
    }),
  );
  assert.equal(inputs.baseUrl, "https://models.example.test");
  assert.equal(inputs.apiUrl, "https://api.example.test");
});

test("defaults enable both bots and disable fork review", () => {
  const inputs = readInputs(env());
  assert.deepEqual(inputs.bots, ["renovate", "dependabot"]);
  assert.equal(inputs.allowForks, false);
  assert.equal(inputs.postComment, true);
  assert.equal(inputs.validationNetwork, "bridge");
});

test("rejects unknown providers, forges, and bots", () => {
  assert.throws(() => readInputs(env({ BUMPTRIAGE_PROVIDER: "openai" })), /Unknown provider/);
  assert.throws(() => readInputs(env({ BUMPTRIAGE_FORGE: "gitlab" })), /Unknown forge/);
  assert.throws(() => readInputs(env({ BUMPTRIAGE_BOTS: "renovate,greenkeeper" })), /Unknown bots/);
});

test("validation commands and pre-computed results are mutually exclusive", () => {
  assert.throws(
    () =>
      validateInputs(
        readInputs(
          env({
            BUMPTRIAGE_VALIDATION_COMMANDS: "npm test",
            BUMPTRIAGE_VALIDATION_RESULTS: "/tmp/results.json",
          }),
        ),
      ),
    /not both/,
  );
});

test("an API key is required for anthropic but not for bedrock", () => {
  assert.throws(
    () => validateInputs(readInputs(env({ BUMPTRIAGE_API_KEY: "" }))),
    /API_KEY is required/,
  );

  const bedrock = validateInputs(
    readInputs(env({ BUMPTRIAGE_PROVIDER: "bedrock", BUMPTRIAGE_API_KEY: "" })),
  );
  assert.equal(bedrock.provider, "bedrock");
});

test("a token is required when comment posting is enabled", () => {
  assert.throws(
    () => validateInputs(readInputs(env({ BUMPTRIAGE_TOKEN: "" }))),
    /TOKEN is required/,
  );

  const readOnly = validateInputs(
    readInputs(env({ BUMPTRIAGE_TOKEN: "", BUMPTRIAGE_POST_COMMENT: "false" })),
  );
  assert.equal(readOnly.postComment, false);
});

test("only none and bridge are accepted network policies", () => {
  assert.throws(
    () => validateInputs(readInputs(env({ BUMPTRIAGE_VALIDATION_NETWORK: "host" }))),
    /must be "none" or "bridge"/,
  );
});

test("fireworks supplies its own endpoint, since the provider names a service", () => {
  const inputs = readInputs(
    env({ BUMPTRIAGE_PROVIDER: "fireworks", BUMPTRIAGE_BASE_URL: "" }),
  );
  assert.equal(inputs.baseUrl, "https://api.fireworks.ai/inference");
  assert.equal(validateInputs(inputs).provider, "fireworks");
});

test("an explicit base-url still overrides a provider default", () => {
  const inputs = readInputs(
    env({
      BUMPTRIAGE_PROVIDER: "fireworks",
      BUMPTRIAGE_BASE_URL: "https://gateway.example.test",
    }),
  );
  assert.equal(inputs.baseUrl, "https://gateway.example.test");
});

test("parseModelOverrides accepts an object and rejects anything else", () => {
  assert.deepEqual(parseModelOverrides(""), {});
  assert.deepEqual(parseModelOverrides('{"a":"b"}'), { a: "b" });
  assert.throws(() => parseModelOverrides("["), /not valid JSON/);
  assert.throws(() => parseModelOverrides('["a"]'), /must be a JSON object/);
  assert.throws(() => parseModelOverrides('{"a":1}'), /must be a string/);
});

test("validation commands keep commas inside a single command", () => {
  const inputs = readInputs(
    env({ BUMPTRIAGE_VALIDATION_COMMANDS: 'npm ci\nnpm test -- --grep "a,b"' }),
  );
  assert.deepEqual(inputs.validationCommands, ["npm ci", 'npm test -- --grep "a,b"']);
});
