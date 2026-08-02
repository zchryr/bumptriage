# Provider configurations

Every example below shows only the `uses:` step. Drop it into the review half of
a two-workflow setup (see the other files in this directory) or into the
single-job workflow.

Every supported provider serves the Anthropic Messages API. `base-url` is
required for `anthropic`, because it names a protocol rather than a service and
could point anywhere; there is no value bumptriage could pick that is right for
you, and a wrong guess would send your API key somewhere you did not choose.

For anything that speaks OpenAI's chat-completions format instead, see
[Other providers, through a gateway](#other-providers-through-a-gateway).

| Provider | `base-url` | Credentials | Status |
|---|---|---|---|
| `anthropic` | `https://api.anthropic.com` | `api-key` | supported |
| `anthropic` (self-hosted) | your endpoint | `api-key` | supported |
| `fireworks` | defaulted | `api-key` | supported |
| `bedrock` | not required | `api-key`, or AWS credential chain | supported |

---

## Anthropic

```yaml
- uses: zchryr/bumptriage@v1
  with:
    provider: anthropic
    base-url: https://api.anthropic.com
    model: claude-sonnet-4-5
    api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    token: ${{ secrets.GITHUB_TOKEN }}
    repository: ${{ github.repository }}
    pr-number: ${{ steps.pr.outputs.number }}
    trusted-authors: renovate[bot]
    validation-results: bumptriage-validation/validations.json
```

## Anthropic-compatible endpoint

Anything implementing the Anthropic Messages API works through the `anthropic`
provider — a gateway, a proxy, or a local server. Only the URL changes.

```yaml
- uses: zchryr/bumptriage@v1
  with:
    provider: anthropic
    base-url: https://models.internal.example.test
    model: your-model-id
    api-key: ${{ secrets.MODEL_API_KEY }}
    # …forge inputs as above
```

Two notes for single-model deployments:

- bumptriage pins every model alias the agent runtime consults — including the
  separate small model it reaches for during background and subagent turns — to
  the one `model` you supply. A single-model endpoint therefore does not need to
  implement several model names.
- `base-url` omits the `/v1` suffix. The runtime appends `/v1/messages` itself.

## Fireworks AI

Fireworks serves the Anthropic Messages API directly, so it runs through the same
path as Anthropic with no translation layer. `base-url` defaults to their
endpoint, since the provider names one specific service.

```yaml
- uses: zchryr/bumptriage@v1
  with:
    provider: fireworks
    model: accounts/fireworks/models/<model-id>
    api-key: ${{ secrets.FIREWORKS_API_KEY }}
    token: ${{ secrets.GITHUB_TOKEN }}
    repository: ${{ github.repository }}
    pr-number: ${{ steps.pr.outputs.number }}
    trusted-authors: renovate[bot]
    validation-results: bumptriage-validation/validations.json
```

Notes:

- `model` must be a Fireworks model resource name
  (`accounts/fireworks/models/<id>`, or `accounts/fireworks/routers/<id>` for a
  router), not an Anthropic model name. Look up the exact id in their model
  catalogue. An Anthropic-style name is rejected before any request is made,
  with a message saying so.
- Requests must go to `api.fireworks.ai/inference`, which is the default here.
  Direct per-model route endpoints do not serve this API.
- **Prompt caching works.** Fireworks' compatibility documentation lists
  `cache_control` as unsupported, but as of 2026-08-01 it is accepted and
  honoured: a full agent run through this configuration reported
  `cache_read_input_tokens: 2048`. bumptriage therefore does nothing special
  here, and you should be suspicious of any advice — including that
  documentation — telling you to disable caching for Fireworks.
- Authentication is the ordinary `x-api-key` the Anthropic protocol sends, so
  passing `api-key` is all that is required. `Authorization: Bearer` and
  `x-fireworks-api-key` are also accepted; none of them needs configuring.

### Verifying it against your own key

```bash
FIREWORKS_API_KEY=fw_... node scripts/fireworks-smoke.mjs
```

The probe asserts that your key authenticates and that neither `cache_control`
nor `eager_input_streaming` is rejected. It also sends an invented field that
Fireworks *does* reject, as a control — without it, "everything was accepted"
would be indistinguishable from an endpoint that ignores whatever it is sent.
A `FAIL` row means Fireworks' behaviour has changed and `src/provider.mjs`
needs revisiting.

## AWS Bedrock

Three things apply to every Bedrock configuration below, each established
against a live endpoint on 2026-08-01 rather than from documentation. Re-check
them with `AWS_BEARER_TOKEN_BEDROCK=… AWS_REGION=… node scripts/bedrock-smoke.mjs`,
which carries controls so its assertions cannot pass vacuously.

- **`model` must name an inference profile.** `us.anthropic.claude-sonnet-5` is
  accepted; the bare `anthropic.claude-sonnet-5` is refused with *"Invocation of
  model ID … with on-demand throughput isn’t supported"*. Use the geography
  prefix for your region, or an application-inference-profile ARN.
- **Prompt caching works.** A probe wrote 10,404 tokens to cache and read all
  10,404 back on the next call. Do not set `DISABLE_PROMPT_CACHING`.
- **Service tiers are per-model.** `flex` is roughly half price and looks ideal
  for a review nobody is waiting on, but Sonnet 5 rejects it with *"The provided
  service tier is not supported for this model"*. Check the model card first.

### Bedrock with an API key

The simplest option: one secret, no credential plumbing, and it works from
anywhere. Create the scoped IAM user with
[`iam/bedrock-api-key-user.yaml`](../iam/bedrock-api-key-user.yaml), then run the
`CreateKeyCommand` from the stack outputs.

```yaml
- uses: zchryr/bumptriage@v1
  with:
    provider: bedrock
    model: us.anthropic.claude-sonnet-5
    api-key: ${{ secrets.BEDROCK_API_KEY }}
    token: ${{ secrets.GITHUB_TOKEN }}
    repository: ${{ github.repository }}
    pr-number: ${{ steps.pr.outputs.number }}
    trusted-authors: renovate[bot]
    validation-results: bumptriage-validation/validations.json
```

The job still needs `AWS_REGION` (or `AWS_DEFAULT_REGION`) in its environment,
because the endpoint is derived from the region even when the key carries the
authentication.

Three things that will otherwise cost you an afternoon:

- **The IAM user needs `bedrock:CallWithBearerToken`.** Bearer authentication is
  a separate action from `bedrock:InvokeModel`. Granting only the latter fails
  every request with `403 … not authorized to perform: bedrock:CallWithBearerToken`,
  which reads like a model-access problem and is not one. The template grants it.
- **The key is the `ServiceCredentialSecret` field**, an `ABSK…` string, not
  `ServiceApiKeyValue` as the Amazon Bedrock user guide states. Querying the
  documented name returns null.
- **AWS CLI v2.36 or later.** Earlier versions reject `--credential-age-days`,
  and v2.25 created the credential while returning no key value at all, leaving
  an unusable credential behind that has to be deleted by id.

This is a long-lived credential, which is why OIDC below is still preferable
where it is available. Mint it with the shortest `--credential-age-days` you can
tolerate, keep it in a GitHub Environment behind a required reviewer, and revoke
with `aws iam delete-service-specific-credential` rather than by deleting the
stack.

## AWS Bedrock with OIDC

Preferred. Nothing is stored in the repository and credentials last an hour.
`base-url` is not required: the AWS SDK derives the endpoint from the region.

```yaml
- uses: aws-actions/configure-aws-credentials@v6
  with:
    role-to-assume: ${{ vars.BUMPTRIAGE_RENOVATE_ROLE_ARN }}
    aws-region: us-east-1
    role-session-name: bumptriage-renovate

- uses: zchryr/bumptriage@v1
  with:
    provider: bedrock
    model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
    token: ${{ secrets.GITHUB_TOKEN }}
    # …forge inputs as above
```

The job needs `permissions: id-token: write`. Deploy the role with
[`iam/bedrock-oidc-role.yaml`](../iam/bedrock-oidc-role.yaml), once per bot.

> **The shipped template cannot be assumed yet.** It conditions on
> `workflow_ref`, which is not an AWS IAM condition key, so the trust policy
> never matches. Use static access keys below until it is rewritten — see
> [`docs/OIDC.md`](../docs/OIDC.md).

### Bedrock with an inference profile ARN

Pass the ARN as `model` directly:

```yaml
    model: arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Or keep readable names in configuration and map them with `model-overrides`:

```yaml
    model: claude-sonnet-4-5
    model-overrides: >-
      {"claude-sonnet-4-5":"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"}
```

### Bedrock with static access keys

For environments that cannot use OIDC. Create them with
[`iam/bedrock-user.yaml`](../iam/bedrock-user.yaml).

```yaml
- uses: aws-actions/configure-aws-credentials@v6
  with:
    aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
    aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    aws-region: us-east-1

- uses: zchryr/bumptriage@v1
  with:
    provider: bedrock
    model: us.anthropic.claude-sonnet-4-5-20250929-v1:0
    token: ${{ secrets.GITHUB_TOKEN }}
```

---

## Other providers, through a gateway

There is no `openai` or `ollama` provider value, and there will not be one. The
agent runtime speaks the Anthropic Messages API and has a closed provider list
with no hook for a custom transport, so anything speaking OpenAI's
chat-completions format has to be translated somewhere.

That somewhere does not have to be bumptriage. A self-hosted translating proxy —
[LiteLLM](https://docs.litellm.ai/docs/anthropic_unified/) among others — exposes
`/v1/messages` and forwards to OpenAI, a local Ollama, or whatever else you run.
From here that is simply an Anthropic-compatible endpoint:

```yaml
- uses: zchryr/bumptriage@v1
  with:
    provider: anthropic
    base-url: https://litellm.internal.example.test
    model: <the name your proxy exposes>
    api-key: ${{ secrets.MODEL_API_KEY }}
```

This is untested from here and comes with no promises. Two things to weigh before
relying on it:

- **Everything you route passes through the proxy.** bumptriage sends diffs and
  repository file contents to whichever endpoint you configure. A self-hosted
  proxy keeps that on infrastructure you control; a hosted one adds a party.
- **Small local models are weak at this task.** Reviewing a dependency update is
  long-context, many-turn, strict-tool-format agentic work. Models in the size
  range people typically run locally tend to drift out of tool-call format part
  way through. The plumbing is the easy part; holding the format for a whole
  review is not.

## Choosing a model

Whatever provider you use, this task rewards a capable model, and it is worth
knowing *how* a weaker one fails here.

Running the same pull request twice with a byte-identical evidence bundle and
only the model changed, a small fast model reported a validation transcript's
container image as the version the pull request was migrating *away* from, and
built a "no test evidence from the target version exists" finding on that — while
still returning `merge`. The image was recorded correctly in the evidence it was
given. A larger model read the same field correctly, cited it by name, and
additionally flagged that the pull request contained hand-authored changes
despite being attributed to a bot.

The failure mode to plan for is not a model that gives up or malforms its output.
It is a model that invents a specific, checkable claim about evidence it was
handed, stated with the same confidence as the true parts of the report. Budget
accordingly, and never gate an unattended merge on `recommendation`.
