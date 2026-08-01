# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial release. Agentic review of Renovate and Dependabot dependency-update
  pull requests, posting a single verdict comment.
- Two-workflow setup splitting untrusted validation from the privileged review,
  which is also what makes Dependabot support possible: its `pull_request` runs
  have a read-only token and no access to Actions secrets.
- Validation sandbox running each command in a sibling container — separate PID
  namespace, unprivileged user, read-only root filesystem, dropped capabilities,
  resource limits, and a `git archive` snapshot of the head commit.
- `anthropic`, `fireworks`, and `bedrock` model providers. `base-url` points
  `anthropic` at any Anthropic-Messages-compatible endpoint; `fireworks` serves
  that API directly and supplies its own.
- The `fireworks` provider authenticates with the `x-fireworks-api-key` header
  and disables prompt caching, because Fireworks rejects `cache_control` with a
  `400` rather than ignoring it. It also refuses an Anthropic-style model name up
  front, since Fireworks addresses models as `accounts/<account>/models/<id>`.
  `scripts/fireworks-smoke.mjs` verifies all of this against a real key.
- CloudFormation templates for a Bedrock role assumed via GitHub OIDC, and a
  static-key alternative. The OIDC template is **not yet usable** — see Known
  limitations.
- Gitea support behind a forge adapter, with GitHub as the tested target.
- Release automation publishing a multi-arch image to GHCR with signed build
  provenance and SBOM attestations, then pinning `action.yml` to the resulting
  digest. Release tags run a prebuilt image; the default branch still builds
  from source so forks need no registry setup.
- CodeQL analysis over both the JavaScript and the workflow definitions, and
  Dependabot for npm, GitHub Actions, and Docker.

### Security

- Inputs arrive as environment variables via `runs.env`, never as process
  arguments. Arguments are readable through `/proc/<pid>/cmdline` by any child
  process, including a dependency's install script.
- The reviewing agent has `Read`, `Glob`, and `Grep` only. It cannot execute
  anything: validation runs before the review and the agent sees transcripts.
  Prompt injection through a dependency's changelog can influence what the report
  says, but not what runs.
- `trusted-authors` is required with no default, so no account name is trusted
  merely because it appeared in an example.
- Pull requests from forks are rejected unless `allow-forks` is set.
- A login ending in `[bot]` must be a bot account where the forge reports a type.
- The model subprocess environment is a strict allowlist.
- The example and dogfooding workflows close a path from a fork pull request to
  the credential-holding review job. A branch-name `if` is a filter, not a
  boundary, so the validate workflows now also require the head repository to be
  the base repository. The review workflows take the pull request number from
  the `workflow_run` event rather than from the artifact produced by the job
  that ran pull request code — otherwise whoever produced that artifact chose
  which pull request was reviewed, passing every authorization check truthfully
  while supplying their own evidence. `SECURITY.md` documents this as the
  trigger boundary.
- `trusted-author-ids` is set in the examples, pinning trust to the update bot's
  numeric account id rather than to a claimable name.

### Known limitations

- Providers are limited to those serving the Anthropic Messages API. Anything
  speaking OpenAI's chat-completions format needs a translating proxy in front,
  which is out of scope here rather than planned.
- Only the `anthropic` provider and the GitHub forge have been exercised against
  a live pull request. Fireworks, Bedrock, and Gitea share the code path but have
  never been called; the release and attestation workflow has never run.
  `docs/PROGRESS.md` records which components are proven and which are merely
  written.
- `iam/bedrock-oidc-role.yaml` cannot be assumed. It conditions on
  `workflow_ref`, which is not an AWS IAM condition key, so the trust policy
  never matches. It fails closed, so the role is unusable rather than insecure.
  Use static access keys until the rewrite described in `docs/OIDC.md` lands.
- One validation image applies to every command; polyglot repositories should
  build a small image containing the toolchains they need.
- The sandbox isolates credentials and the host, not the network. Validation can
  still reach the internet unless `network: none` is set.
