#!/usr/bin/env node
// Live compatibility probe for the Bedrock provider.
//
// Nothing about the bedrock arm of src/provider.mjs has ever been exercised
// against a real endpoint. This script exists so that changes there rest on an
// observation rather than on documentation — the Fireworks provider was once
// "fixed" from a vendor compatibility page that turned out to be stale, and the
// workaround shipped before a single call was made. See CLAUDE.md.
//
// Bedrock serves Claude through two different endpoints, and which one
// bumptriage should target is the question this script exists to settle:
//
//   bedrock-runtime  the Invoke API. Bedrock's own request shape
//                    (anthropic_version in the body, model in the URL).
//                    Reached by CLAUDE_CODE_USE_BEDROCK=1.
//
//   bedrock-mantle   the Anthropic Messages API, unmodified, at
//                    /anthropic/v1/messages with the model in the body.
//                    Documented as accepting a Bedrock API key in x-api-key —
//                    which, if true, means this is reachable through the
//                    existing `anthropic` provider with only a base URL
//                    change, and needs no Bedrock-specific code at all.
//
// Both are probed for authentication, model addressing, and prompt caching,
// with negative controls throughout: an endpoint that ignores what it is sent
// and one that supports it look identical until something that ought to fail
// does.
//
// Uses plain fetch and signs SigV4 inline, so it needs no AWS SDK and runs with
// nothing installed. Deliberately not part of `npm test`: it needs a credential, the
// network, and money.
//
// Usage, bearer token (also accepts BEDROCK_API_KEY):
//   AWS_BEARER_TOKEN_BEDROCK=ABSK... AWS_REGION=us-west-2 node scripts/bedrock-smoke.mjs [model]
//
// Usage, SigV4 — note a bearer token in the environment takes precedence, so
// unset it to reach this path:
//   eval "$(aws configure export-credentials --format env)"
//   AWS_REGION=us-west-2 node scripts/bedrock-smoke.mjs [model]

import crypto from "node:crypto";
import process from "node:process";

// Two credential modes, because both are real deployment paths and they
// authenticate differently:
//
//   SigV4   ordinary AWS credentials — what an assumed OIDC role produces in
//           CI, and what the agent runtime signs with when given them. Load
//           them with `eval "$(aws configure export-credentials --format env)"`.
//   bearer  a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK, which bypasses the
//           credential chain entirely.
//
// A bearer token wins when both are present, because that is what the runtime
// does. In the agent binary:
//
//   if(!n && !process.env.AWS_BEARER_TOKEN_BEDROCK){ let o=await q6(); … }
//   P=process.env.AWS_BEARER_TOKEN_BEDROCK?.trim(), O=P?`Bearer ${P}`:k?x.value:…
//
// — with the token set, the SigV4 credential chain is never resolved at all.
// Preferring SigV4 here would be worse than merely inaccurate: the usage line
// tells you to export AWS credentials, so anyone who does that and then adds
// the API key they wanted to test would get an all-green SigV4 run that never
// touched the key.
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const sessionToken = process.env.AWS_SESSION_TOKEN;
const token = process.env.AWS_BEARER_TOKEN_BEDROCK ?? process.env.BEDROCK_API_KEY;
const mode = token ? "bearer" : "sigv4";

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, s) => crypto.createHmac("sha256", key).update(s, "utf8").digest();

/**
 * Minimal SigV4 for a JSON POST. Only what these probes need — no query
 * strings, no chunked payloads — kept here rather than pulled from the AWS SDK
 * so this script stays runnable with nothing installed.
 */
function signed(url, service, region, body, extraHeaders = {}) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    "content-type": "application/json",
    host: u.host,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    ...extraHeaders,
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  // SigV4 wants the canonical path URI-encoded twice for every service except
  // S3. u.pathname is already encoded once, so encoding each segment again is
  // what turns a colon in a versioned model id into %253A. Without this, a
  // model argument such as an inference-profile ARN fails on signature rather
  // than on anything this script is trying to test.
  const canonicalPath = u.pathname.split("/").map(encodeURIComponent).join("/");

  const canonicalRequest = [
    "POST",
    canonicalPath,
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  let key = hmac(`AWS4${secretAccessKey}`, dateStamp);
  for (const part of [region, service, "aws4_request"]) key = hmac(key, part);
  const signature = crypto.createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

// Sonnet 5's model card lists us-west-2 as Geo-yes / In-Region-no, so the bare
// form is expected to be refused there and the prefixed form accepted — see the
// control rows.
//
// The prefix is taken from the argument when it carries one, rather than always
// assuming `us.`: passing eu.anthropic.… would otherwise probe a European
// profile against a US region and get a rejection that proves nothing.
const GEO_PREFIX = /^(us|eu|au|apac|global|us-gov)\./;
const requestedModel = process.argv[2] ?? "anthropic.claude-sonnet-5";
const bareModel = requestedModel.replace(GEO_PREFIX, "");
const geoModel = `${requestedModel.match(GEO_PREFIX)?.[1] ?? "us"}.${bareModel}`;

if (mode === "sigv4" && !(accessKeyId && secretAccessKey)) {
  console.error(
    "No credential found. Either export AWS credentials —\n" +
      '  eval "$(aws configure export-credentials --format env)"\n' +
      "— or set AWS_BEARER_TOKEN_BEDROCK to a Bedrock API key. Nothing was sent.",
  );
  process.exit(2);
}
if (token && accessKeyId) {
  console.warn(
    "Both a bearer token and AWS credentials are set. Probing the bearer token, which is\n" +
      "what the runtime would use; the AWS credentials are ignored. Unset\n" +
      "AWS_BEARER_TOKEN_BEDROCK to exercise SigV4 instead.\n",
  );
}
if (token && /[\r\n]/.test(token)) {
  // Name the variable that was actually set: pointing someone at
  // AWS_BEARER_TOKEN_BEDROCK when they populated BEDROCK_API_KEY is the same
  // class of misdirection describeCredential exists to avoid.
  const source = process.env.AWS_BEARER_TOKEN_BEDROCK
    ? "AWS_BEARER_TOKEN_BEDROCK"
    : "BEDROCK_API_KEY";
  console.error(`${source} contains a line break — check for a trailing newline.`);
  process.exit(2);
}

/**
 * Report the credential's shape, never its value.
 *
 * Both endpoints reject a malformed key with a message about the key rather
 * than about the request ("Invalid API Key format: Base64 decoding failed"),
 * and a run where every row fails on authentication looks superficially like a
 * run where every row was refused on its merits. Printing the shape up front
 * makes that distinction immediate, and none of it is enough to reconstruct the
 * credential.
 */
function describeCredential() {
  if (mode === "sigv4") {
    console.log(
      `credential: SigV4, key id ${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-2)}` +
        `${sessionToken ? " with session token" : " (long-lived, no session token)"}\n`,
    );
    return;
  }
  const shape = [];
  if (token.startsWith("ABSK")) shape.push("ABSK… (long-term)");
  else if (token.startsWith("bedrock-api-key-")) shape.push("bedrock-api-key-… (short-term)");
  else shape.push(`unrecognised prefix ${JSON.stringify(token.slice(0, 4))}`);

  if (/^["']|["']$/.test(token)) shape.push("WRAPPED IN QUOTES — strip them");
  if (/\s/.test(token)) shape.push("CONTAINS WHITESPACE — probably truncated or re-wrapped");
  if (!/^[A-Za-z0-9+/=_.:-]+$/.test(token)) shape.push("contains characters outside base64url");

  console.log(`credential: bearer, ${token.length} chars, ${shape.join(", ")}\n`);
}
describeCredential();

const invokeHost = `https://bedrock-runtime.${region}.amazonaws.com`;
const mantleHost = `https://bedrock-mantle.${region}.api.aws/anthropic`;

/**
 * Claude Sonnet 5 needs 4,096 tokens before a cache checkpoint is created at
 * all; below that the request still succeeds and simply is not cached, which
 * would make a caching probe silently vacuous. This is comfortably above it,
 * and byte-identical between the two cache rows so the second one can hit.
 */
const filler =
  "This paragraph is filler used to exceed the minimum cacheable prefix length. ".repeat(400);

const messages = [{ role: "user", content: "Reply with the single word: ok" }];
const tool = {
  name: "noop",
  description: "does nothing",
  input_schema: { type: "object", properties: {} },
};

async function send(url, service, body, { auth = true, extraHeaders = {} } = {}) {
  // Sign the exact bytes that are sent: SigV4 covers a hash of the payload, so
  // stringifying twice would produce a signature for a different request.
  const payload = JSON.stringify(body);

  let headers;
  if (!auth) {
    headers = { "content-type": "application/json", ...extraHeaders };
  } else if (mode === "sigv4") {
    headers = signed(url, service, region, payload, extraHeaders);
  } else {
    // The Invoke API takes the key as a bearer token; Mantle takes the same key
    // in x-api-key, the header the Anthropic protocol already sends.
    const bearer =
      service === "bedrock" ? { authorization: `Bearer ${token}` } : { "x-api-key": token };
    headers = { "content-type": "application/json", ...bearer, ...extraHeaders };
  }

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: payload });
  } catch (error) {
    // Distinct from a rejection. A transport failure satisfies "the call did
    // not succeed" while proving nothing about the endpoint, and would
    // otherwise turn every negative control green.
    return { errored: true, ok: false, detail: `network error: ${error.message}`, usage: {} };
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON body is itself the finding; fall through with the raw prefix.
  }
  const usage = parsed?.usage ?? {};

  // Bedrock's Invoke API returns {"Message":"…"} with a capital M on a 4xx;
  // Mantle uses the lowercase Anthropic error shape. Reading both means `reason`
  // is the message rather than the raw JSON that happens to contain it.
  const reason = String(
    parsed?.Message ?? parsed?.message ?? parsed?.error?.message ?? text,
  ).replaceAll("\n", " ");

  // `reason` is kept whole and `detail` truncated only for display. The two must
  // stay separate: an inference-profile ARN passed as argv[2] pushes the
  // interesting part of a rejection past the display width, and matching on the
  // truncated form would fail a correct rejection while printing "expected the
  // reason to mention…" — the exact confusing failure the assertions exist to
  // prevent.
  const detail = response.ok
    ? `in=${usage.input_tokens ?? "?"} write=${usage.cache_creation_input_tokens ?? 0} ` +
      `read=${usage.cache_read_input_tokens ?? 0}`
    : reason.slice(0, 110);
  return { ok: response.ok, status: response.status, detail, reason, usage };
}

/**
 * Provenance for the `because` strings below.
 *
 * Since a negative row only counts when the rejection says what the row is
 * about, these four fragments decide whether the probe proves anything — so
 * they are quotations, and CLAUDE.md's "record what you ran" applies to them
 * harder than to anything else here. Each was copied from a response observed
 * on 2026-08-01, `us-west-2`, `us.anthropic.claude-sonnet-5`, both credential
 * modes:
 *
 *   no credential      403  {"Message":"Authorization header is missing"}
 *   bare model id      400  Invocation of model ID anthropic.claude-sonnet-5
 *                           with on-demand throughput isn’t supported. Retry…
 *   flex tier          400  The provided service tier is not supported for
 *                           this model.
 *   unknown body field 400  totally_made_up_field: Extra inputs are not
 *                           permitted
 *
 * Note the apostrophe in the third one is U+2019, not ASCII. Five files in this
 * repository quoted it as ASCII until the mismatch was caught; the docs were
 * wrong and this string is right. If AWS rewords any of these, the row fails
 * loudly with the expected fragment printed, which is the intended behaviour —
 * re-observe and update, do not relax the match.
 */
const results = [];

async function invoke(label, { model = geoModel, body = {}, expect, because, ...opts }) {
  const r = await send(
    `${invokeHost}/model/${encodeURIComponent(model)}/invoke`,
    "bedrock",
    { anthropic_version: "bedrock-2023-05-31", max_tokens: 8, messages, ...body },
    opts,
  );
  results.push({ label: `invoke  ${label}`, expect, because, ...r });
}

async function mantle(label, { model = bareModel, body = {}, expect, because, ...opts }) {
  const r = await send(
    `${mantleHost}/v1/messages`,
    "bedrock-mantle",
    { model, max_tokens: 8, messages, ...body },
    { ...opts, extraHeaders: { "anthropic-version": "2023-06-01", ...opts.extraHeaders } },
  );
  results.push({ label: `mantle  ${label}`, expect, because, ...r });
}

const cached = {
  system: [{ type: "text", text: filler, cache_control: { type: "ephemeral" } }],
};

// ---- bedrock-runtime, the Invoke API -------------------------------------

// Authentication. This is what AWS_BEARER_TOKEN_BEDROCK sends.
await invoke(`auth: ${mode}`, { expect: "accept" });
await invoke("control: no credential", {
  auth: false,
  expect: "reject",
  because: "Authorization header is missing",
});

// Model addressing. Sonnet 5 in us-west-2 is Geo-yes, In-Region-no, so the
// prefixed form should work and the bare form should not. If both are accepted
// the geography prefix is not doing what the model card says it does.
await invoke("model: us. geo prefix", { expect: "accept" });
// The exact wording matters: README.md and examples/providers.md quote it. If
// the bare id were refused as an unknown model instead, the row would still go
// green while the documentation became wrong.
await invoke("control: bare in-region id", {
  model: bareModel,
  expect: "reject",
  because: "on-demand throughput isn’t supported",
});

// Prompt caching. Two calls with a byte-identical prefix: the first writes the
// cache, the second should read it. A non-zero read on the second row is the
// only thing separating working caching from a field that is accepted and
// discarded.
await invoke("cache: write (1st)", { body: cached, expect: "accept" });
await invoke("cache: read (2nd)", { body: cached, expect: "accept" });
await invoke("cache: tools[].cache_control", {
  body: { tools: [{ ...tool, cache_control: { type: "ephemeral" } }] },
  expect: "accept",
});

// Service tier. Sonnet 5's model card marks Flex as unsupported, so this is
// expected to be refused — recorded to catch the card being stale, and to stop
// anyone reading the flex discount as available on every model.
await invoke("tier: flex (card says unsupported)", {
  extraHeaders: { "x-amzn-bedrock-service-tier": "flex" },
  expect: "reject",
  because: "service tier is not supported",
});

// Control. If an invented field is accepted, every "accepted" row above proves
// only that the endpoint is permissive, not that the field is supported.
await invoke("control: unknown body field", {
  body: { totally_made_up_field: true },
  expect: "reject",
  because: "Extra inputs are not permitted",
});

// ---- bedrock-mantle, the Anthropic Messages API ---------------------------

// Recorded as `info`, not asserted: bumptriage does not target Mantle, and
// these rows exist to document why. On 2026-08-01 the endpoint was live and
// authenticated the same credential, then refused with 404 "model does not
// exist" under an admin identity and 403 "not authorized to perform
// bedrock-mantle:CreateInference" under the scoped key. Mantle therefore needs
// both a separate IAM action and a separate model grant, which is what stops it
// being a general path — if it were reachable, Bedrock would run through the
// existing `anthropic` arm on nothing but a base URL.
await mantle(`auth: ${mode}`, { expect: "info" });
await mantle("control: no credential", { auth: false, expect: "info" });
await mantle("model: bare anthropic. id", { expect: "info" });
await mantle("cache: write (1st)", { body: cached, expect: "info" });
await mantle("cache: read (2nd)", { body: cached, expect: "info" });

// ---- report ---------------------------------------------------------------

const width = Math.max(...results.map((r) => r.label.length));
let failures = 0;
for (const r of results) {
  // A rejection only counts when it is the rejection the row is about. Without
  // the `because` check, an expired credential, a 429, or a model id the
  // endpoint has never heard of all satisfy every negative control at once —
  // which is exactly what happened on the first run of this script against a
  // malformed key, where nine rows went green while proving nothing.
  const outcome = r.errored ? "errored" : r.ok ? "accept" : "reject";
  const matched =
    r.expect === "info" ||
    (r.expect === outcome && (!r.because || String(r.reason ?? "").includes(r.because)));
  if (!matched) failures += 1;
  const verdict = r.errored ? "ERRORED" : r.ok ? "accepted" : `rejected ${r.status ?? ""}`.trim();
  const marker = r.expect === "info" ? "--  " : matched ? "ok  " : "FAIL";
  console.log(`${marker}  ${r.label.padEnd(width)}  ${verdict.padEnd(13)}  ${r.detail}`);
  if (!matched && r.because && !String(r.reason ?? "").includes(r.because)) {
    console.log(`${" ".repeat(width + 6)}  expected the reason to mention: ${r.because}`);
  }
}

const cacheRead = (prefix) =>
  Number(
    results.find((r) => r.label.startsWith(prefix) && r.label.includes("cache: read"))?.usage
      ?.cache_read_input_tokens ?? 0,
  );

// Asserted, not merely reported. CLAUDE.md and the README both state that
// prompt caching engages on Bedrock and that it must not be disabled; this is
// the only thing standing behind that claim, so a zero read has to fail the run
// rather than print a warning above an "all probes matched" line.
//
// Only the invoke endpoint counts. Mantle is recorded as `info` because
// bumptriage does not target it, and a hit there would say nothing about the
// endpoint a review actually uses.
const invokeCacheRead = cacheRead("invoke");
console.log(
  `\ncache_read_input_tokens on the repeat call — invoke: ${invokeCacheRead}, ` +
    `mantle: ${cacheRead("mantle")} (not counted)`,
);
if (invokeCacheRead > 0) {
  console.log("Prompt caching engages on bedrock-runtime; leave it enabled.");
} else {
  failures += 1;
  console.log(
    "FAIL  prompt caching did NOT engage on bedrock-runtime. cache_control was accepted " +
      "and discarded, or the prefix fell under the model's minimum checkpoint size. The " +
      "caching claims in README.md, examples/providers.md and CLAUDE.md rest on this row.",
  );
}
console.log(
  failures === 0
    ? "All probes matched. Record what ran in docs/PROGRESS.md before raising an evidence level."
    : `${failures} probe(s) did not match — read them before treating any row as evidence.`,
);

process.exitCode = failures === 0 ? 0 : 1;
