#!/usr/bin/env node
// Live compatibility probe for the Fireworks provider.
//
// The Fireworks provider is configured from vendor documentation and from
// strings in the pinned runtime binary, not from a call that was ever made.
// This script makes the call. It exists so the open question in
// docs/PROGRESS.md can be closed with an observation rather than an argument,
// and so the two compatibility switches in provider.mjs can be shown to be
// necessary rather than superstitious.
//
// It is deliberately not part of `npm test`: it needs a credential and the
// network, and the test suite needs neither.
//
// Usage: FIREWORKS_API_KEY=fw_... node scripts/fireworks-smoke.mjs [model]

import process from "node:process";

const apiKey = process.env.FIREWORKS_API_KEY;
const model = process.argv[2] ?? "accounts/fireworks/models/kimi-k2p5";
const baseUrl = (process.env.FIREWORKS_BASE_URL ?? "https://api.fireworks.ai/inference").replace(
  /\/+$/,
  "",
);

if (!apiKey) {
  console.error("FIREWORKS_API_KEY is required. Nothing was sent.");
  process.exit(2);
}
if (/[\r\n]/.test(apiKey)) {
  console.error("FIREWORKS_API_KEY contains a line break — check for a trailing newline.");
  process.exit(2);
}

/**
 * @param {string} label
 * @param {object} body
 * @param {Record<string,string>} headers
 */
async function probe(label, body, headers) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { label, ok: false, status: 0, detail: `network error: ${error.message}` };
  }
  const text = await response.text();
  let detail = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.content?.[0]?.text ?? detail;
  } catch {
    // Leave the raw prefix in place; a non-JSON body is itself the finding.
  }
  return {
    label,
    ok: response.ok,
    status: response.status,
    ms: Date.now() - started,
    detail: String(detail).replaceAll("\n", " ").slice(0, 300),
  };
}

const minimal = {
  model,
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
};

// A tool definition carrying cache_control, which is what the runtime sends
// when prompt caching is left on. If this succeeds, DISABLE_PROMPT_CACHING is
// unnecessary and provider.mjs should be simplified.
const withCacheControl = {
  ...minimal,
  tools: [
    {
      name: "noop",
      description: "does nothing",
      input_schema: { type: "object", properties: {} },
      cache_control: { type: "ephemeral" },
    },
  ],
};

// Same, for the other field the runtime can attach to a tool schema.
const withEagerStreaming = {
  ...minimal,
  tools: [
    {
      name: "noop",
      description: "does nothing",
      input_schema: { type: "object", properties: {} },
      eager_input_streaming: true,
    },
  ],
};

const results = [];

// Authentication, three ways. Fireworks documents `Authorization: Bearer` for
// the raw API and `x-fireworks-api-key` for its Claude Code integration;
// `x-api-key` is what the Anthropic protocol sends by default. Which of these
// the endpoint actually honours decides what provider.mjs must set.
results.push(await probe("auth: x-fireworks-api-key", minimal, { "x-fireworks-api-key": apiKey }));
results.push(await probe("auth: Authorization Bearer", minimal, { authorization: `Bearer ${apiKey}` }));
results.push(await probe("auth: x-api-key", minimal, { "x-api-key": apiKey }));

const authHeader = { "x-fireworks-api-key": apiKey };
results.push(await probe("field: tools[].cache_control", withCacheControl, authHeader));
results.push(await probe("field: tools[].eager_input_streaming", withEagerStreaming, authHeader));

let width = 0;
for (const r of results) width = Math.max(width, r.label.length);
for (const r of results) {
  const verdict = r.ok ? "accepted" : `rejected ${r.status}`;
  console.log(`${r.label.padEnd(width)}  ${verdict.padEnd(13)}  ${r.detail}`);
}

console.log(
  "\nExpected from the documented behaviour: at least one auth header accepted, and both\n" +
    "field probes rejected with invalid_request_error. A field probe that is *accepted*\n" +
    "means the corresponding switch in src/provider.mjs is no longer needed.\n" +
    "Record what you observed in docs/PROGRESS.md — see the SOP in CLAUDE.md.",
);

// Exit non-zero only when no authentication method worked at all: the field
// probes are expected to fail, and their failing is the point.
process.exitCode = results.slice(0, 3).some((r) => r.ok) ? 0 : 1;
