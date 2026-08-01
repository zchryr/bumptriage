#!/usr/bin/env node
// Live compatibility probe for the Fireworks provider.
//
// Fireworks' Anthropic-compatibility documentation lists `cache_control` and
// `eager_input_streaming` as unsupported, and a bug report against another
// Anthropic-protocol client shows them being rejected with a 400. Both were
// accepted when this script was last run (2026-08-01), on three different
// models. The documentation is stale, and a workaround written from it would
// disable prompt caching that demonstrably works.
//
// So this is a regression probe, not an exploration: it asserts that the
// provider needs no workarounds, and fails if that stops being true. Run it
// before changing anything in the fireworks arm of src/provider.mjs.
//
// It is deliberately not part of `npm test`: it needs a credential and the
// network, and the test suite needs neither.
//
// Usage: FIREWORKS_API_KEY=fw_... node scripts/fireworks-smoke.mjs [model]

import process from "node:process";

const apiKey = process.env.FIREWORKS_API_KEY;
const model = process.argv[2] ?? "accounts/fireworks/models/kimi-k3";
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

async function probe(label, body, headers, expect) {
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { label, expect, ok: false, detail: `network error: ${error.message}` };
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is itself the finding; fall through with the raw prefix.
  }
  const detail = response.ok
    ? `in=${parsed?.usage?.input_tokens ?? "?"} cache_read=${parsed?.usage?.cache_read_input_tokens ?? 0}`
    : String(parsed?.error?.message ?? text)
        .replaceAll("\n", " ")
        .slice(0, 120);
  return { label, expect, ok: response.ok, status: response.status, detail };
}

const tool = { name: "noop", description: "does nothing", input_schema: { type: "object", properties: {} } };
const base = {
  model,
  max_tokens: 8,
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
};
const auth = { "x-fireworks-api-key": apiKey };

const results = [];

// Authentication. `x-api-key` is what the Anthropic protocol — and therefore
// ANTHROPIC_API_KEY — sends, so that row is the one src/provider.mjs relies on.
results.push(await probe("auth: x-api-key", base, { "x-api-key": apiKey }, "accept"));
results.push(await probe("auth: Authorization Bearer", base, { authorization: `Bearer ${apiKey}` }, "accept"));
results.push(await probe("auth: x-fireworks-api-key", base, auth, "accept"));
results.push(await probe("auth: none", base, {}, "reject"));

// The two fields the documentation calls unsupported. Both are sent by the
// runtime; if either starts being rejected, every review against Fireworks
// breaks and the fix is a switch in the fireworks arm of provider.mjs.
results.push(
  await probe(
    "field: tools[].cache_control",
    { ...base, tools: [{ ...tool, cache_control: { type: "ephemeral" } }] },
    auth,
    "accept",
  ),
);
results.push(
  await probe(
    "field: tools[].eager_input_streaming",
    { ...base, tools: [{ ...tool, eager_input_streaming: true }] },
    auth,
    "accept",
  ),
);

// Control. Fireworks validates tool schemas strictly and rejects genuinely
// unknown fields, which is what makes the two rows above meaningful: they are
// accepted because they are supported, not because the parser is lax. If this
// row starts passing, the probe above has stopped proving anything.
results.push(
  await probe(
    "control: unknown tool field",
    { ...base, tools: [{ ...tool, totally_made_up_field: true }] },
    auth,
    "reject",
  ),
);

const width = Math.max(...results.map((r) => r.label.length));
let failures = 0;
for (const r of results) {
  const matched = r.expect === (r.ok ? "accept" : "reject");
  if (!matched) failures += 1;
  const verdict = r.ok ? "accepted" : `rejected ${r.status ?? ""}`.trim();
  console.log(
    `${matched ? "ok  " : "FAIL"}  ${r.label.padEnd(width)}  ${verdict.padEnd(13)}  ${r.detail}`,
  );
}

console.log(
  failures === 0
    ? "\nAll probes matched. The fireworks provider needs no compatibility workarounds."
    : `\n${failures} probe(s) did not match. Fireworks' behaviour has changed — reconcile ` +
        "src/provider.mjs and the provider row in docs/PROGRESS.md before shipping.",
);

process.exitCode = failures === 0 ? 0 : 1;
