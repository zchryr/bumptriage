# bumptriage

A GitHub Action that reviews Renovate and Dependabot pull requests with an
agent: it reads the diff, traces whether the changed dependency is actually used
in your code, runs your build and tests in a sandbox, and posts one comment with
a verdict.

It exists because most dependency-update pull requests are approved on the
strength of a green check and a changelog nobody read. bumptriage tries to answer
the question you actually care about — *does this change affect this repository* —
and to show its work.

```markdown
Verdict: hold
Risk: medium

`fast-glob` 3.3.2 → 4.0.0 drops the `stats` option, which
`src/scanner.mjs:88` passes on every call. Tests pass because
the scanner's stat path has no coverage (`npm test` exits 0,
0 assertions over src/scanner.mjs).
```

> [!IMPORTANT]
> bumptriage runs code from the dependency update under review. Read
> [SECURITY.md](SECURITY.md) before installing it. The `recommendation` output is
> advisory and must not gate an unattended merge.

## How it works

Reviewing an update means running the update, so bumptriage splits the work across
two workflows with different privileges:

| | Validate workflow | Review workflow |
|---|---|---|
| Trigger | `pull_request` | `workflow_run` |
| Runs PR code | yes, in a sandbox | never |
| Credentials | none | model + forge |
| Token | read-only | write |
| Produces | validation transcripts | the review comment |

The untrusted job executes the update's build and tests but holds nothing worth
stealing. The privileged job holds the credentials but only ever reads: it
downloads the transcripts as data, reads repository files, and writes a comment.

This is also the only arrangement that works for Dependabot, whose
`pull_request` runs get a read-only token and no access to Actions secrets.

## Install

Copy both workflows for your bot into `.github/workflows/`:

- Renovate — [`bumptriage-renovate-validate.yml`](examples/bumptriage-renovate-validate.yml) and [`bumptriage-renovate-review.yml`](examples/bumptriage-renovate-review.yml)
- Dependabot — [`bumptriage-dependabot-validate.yml`](examples/bumptriage-dependabot-validate.yml) and [`bumptriage-dependabot-review.yml`](examples/bumptriage-dependabot-review.yml)

Replace `zchryr/bumptriage@v1` with this repository, and set `validation-commands`
to your build and test commands. The review workflow must exist on your default
branch — `workflow_run` will not fire otherwise.

A [single-job setup](examples/bumptriage-single-job.yml) also exists. It is simpler
and weaker: one job both holds the credentials and runs the update, with only the
sandbox between them. It does not work for Dependabot at all.

On a public repository, do two more things before adding a model credential: put
it in a GitHub Environment with yourself as a required reviewer, and set fork
pull request workflows to require approval for all outside collaborators. The
review job spends money, and a branch name is chosen by whoever opens the pull
request. [SECURITY.md](SECURITY.md#the-trigger-boundary) explains what that
protects against.

## Model providers

| Provider | `base-url` | Credentials | Status |
|---|---|---|---|
| `anthropic` | `https://api.anthropic.com` | `api-key` | supported |
| `anthropic` (self-hosted) | your endpoint | `api-key` | supported |
| `fireworks` | defaulted | `api-key` | supported |
| `bedrock` | not required | AWS credential chain | supported, never called live |

Copy-paste configurations for each are in
[`examples/providers.md`](examples/providers.md).

`base-url` is required for any provider that addresses an endpoint directly, so
nothing silently sends your key somewhere you did not choose. Two exceptions,
for opposite reasons: `bedrock` derives its endpoint from the AWS region, and
`fireworks` names one specific service whose endpoint is therefore knowable.
`anthropic` selects a *protocol* rather than a service — it can point at a
vendor, a gateway, or your own server — so it has no default and never will.

Fireworks serves the Anthropic Messages API directly, so it works through the
same code path as Anthropic with no translation and no workarounds — including
prompt caching. The one difference is that models are addressed by resource name
(`accounts/fireworks/models/<id>`) rather than by an Anthropic model name, and an
Anthropic-style name is rejected before any request is made.
`scripts/fireworks-smoke.mjs` re-checks that against your own key.

OpenAI and Ollama speak the chat-completions format, which the agent
runtime does not implement — its provider list is closed and there is no
custom-transport hook. Supporting them needs a translation proxy, planned for
v0.2. Until then they fail immediately with an explanatory error rather than
misbehaving.

### AWS Bedrock

Two ways in. OIDC is better — nothing is stored in your repository and
credentials expire in an hour.

**OIDC.** Deploy one role per bot, so a compromise of one workflow does not reach
the other's model access:

```bash
aws cloudformation deploy \
  --template-file iam/bedrock-oidc-role.yaml \
  --stack-name bumptriage-renovate-review \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      GitHubOwner=zchryr \
      GitHubRepository=REPO \
      WorkflowFileName=bumptriage-renovate-review.yml \
      RoleName=bumptriage-renovate-review
```

<!-- Once the templates are published to S3, replace BUCKET below with the
     bucket name and uncomment. CloudFormation only accepts S3-hosted templates,
     so this link cannot point at GitHub. -->
<!--
[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=https%3A%2F%2Fs3.us-east-1.amazonaws.com%2FBUCKET%2Flatest%2Fbedrock-oidc-role.yaml&stackName=bumptriage-renovate-review&param_WorkflowFileName=bumptriage-renovate-review.yml)
-->

Set the resulting ARN as the `BUMPTRIAGE_RENOVATE_ROLE_ARN` repository variable,
plus `BUMPTRIAGE_AWS_REGION` and `BUMPTRIAGE_MODEL`.

> [!WARNING]
> **This template does not currently work.** Its trust policy conditions on
> `workflow_ref`, which is not an AWS IAM condition key — AWS provides
> `job_workflow_ref`. The condition never matches, so the role can never be
> assumed. It fails closed, so this is an unusable role rather than an insecure
> one. Use static keys below until it is rewritten; see
> [`docs/OIDC.md`](docs/OIDC.md) for the fix and the org-wide design.

The policy deliberately does **not** pin on branch name: for `pull_request`
events the OIDC `sub` claim contains no branch, and the `head_ref` claim is
chosen by whoever opened the pull request.

**Static keys.** [`iam/bedrock-user.yaml`](iam/bedrock-user.yaml) creates a user
and access key for environments that cannot use OIDC. Store them as the
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets and configure them with
`aws-actions/configure-aws-credentials` before this action.

## Validation

Validation commands run in a container, one image for all of them, against a
snapshot of the head commit. Defaults: `node:24-bookworm-slim`, unprivileged
user, read-only root filesystem, all capabilities dropped, memory/CPU/PID limits,
network on.

If your repository needs more than one toolchain — say Node and Go — build a
small image containing both and pass it as `image`. bumptriage does not ship
language runtimes it cannot know you need.

Network access is on by default because installing dependencies requires it.
Setting `network: none` is stronger but breaks `npm ci` and anything like it; it
suits repositories with vendored dependencies. When a command fails in a way that
looks like the network policy, the transcript says so.

**The sandbox isolates credentials and the host, not the network.** A malicious
package can still reach the internet. What it cannot do is reach your tokens or
the runner. See [SECURITY.md](SECURITY.md).

The snapshot is built with `git archive`, so it contains exactly the committed
tree: no `.git` directory and no untracked files. Tooling that derives a version
from `git describe` will not find one.

## Startup cost and supply chain

The action ships as a container image because the agent runtime is a ~240MB
native binary that cannot be bundled into a JavaScript action. That binary sets
the floor: roughly 900MB on disk, **205MB compressed** to pull.

Where that cost lands depends on one line in `action.yml`, and the two options
differ in more than speed:

| | `image: Dockerfile` | `image: docker://…@sha256:…` |
|---|---|---|
| Used by | the default branch | every release tag |
| Per-run cost | full rebuild, every job | one cached pull |
| What you get | whatever the source builds to | one immutable, attested image |

A container action declared as `image: Dockerfile` is **rebuilt on the runner at
the start of every consuming job**. Ephemeral runners keep no layer cache, so
each run re-installs the agent binary from npm before any review work begins.

Release automation therefore publishes the image to GHCR and rewrites that line
to a **digest**, not a tag. A tag can be moved by anyone who can push to the
registry; a digest cannot. Pinning `uses: zchryr/bumptriage@v1.2.3` transitively
pins the exact image bytes.

The default branch keeps the source build so a fork works with no registry setup
and contributors test their own code.

### Verifying a release

Images carry signed build-provenance and SBOM attestations:

```bash
gh attestation verify oci://ghcr.io/zchryr/bumptriage:1.2.3 --repo zchryr/bumptriage
```

This establishes which workflow, repository, and commit built the image. It does
**not** establish that the image is safe — provenance is about origin, not
behaviour. [SECURITY.md](SECURITY.md#supply-chain) sets out what each control is
and is not worth, including what is deliberately not covered.

## Inputs

See [`action.yml`](action.yml) for the full list. The ones that matter most:

| Input | Required | Notes |
|---|---|---|
| `model` | yes | Model id, or a Bedrock inference-profile ARN |
| `token` | yes | Reads pull request metadata, writes the comment |
| `repository`, `pr-number` | yes | What to review |
| `trusted-authors` | yes | Exact account names. No default, on purpose |
| `provider` | no | `anthropic` (default) or `bedrock` |
| `base-url` | no | Any Anthropic-Messages-compatible endpoint |
| `bots` | no | `renovate`, `dependabot`, or both |
| `branch-prefixes` | no | Override if you reconfigured the bot's `branchPrefix` |
| `allow-forks` | no | Off by default |
| `validation-commands` | no | Run here. Mutually exclusive with the next |
| `validation-results` | no | Consume transcripts from the validate workflow |

`trusted-authors` has no default deliberately. A default naming accounts that
might not exist on your forge is an invitation to register one of them and walk
through the gate.

Outputs: `report-path`, `recommendation`, `update-bot`.

## Gitea

Gitea works — set `forge: gitea` and `api-url`. GitHub is the tested and
documented target; Gitea shares the code path but not the CI coverage.

One caveat specific to self-hosted forges: GitHub guarantees that a login ending
in `[bot]` belongs to an app, because `[` is not a legal username character.
Gitea makes no such promise, so anyone able to register an account could claim
the name your `trusted-authors` list trusts. Restrict registration, or pin
`trusted-author-ids` to the numeric account id.

## Development

```bash
npm ci
npm test          # unit tests, no daemon or network required
docker build -t bumptriage .
```

## License

Apache-2.0. See [LICENSE](LICENSE).
