# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

A GitHub Action (also usable on Gitea) that reviews Renovate and Dependabot
dependency-update pull requests using the Claude Agent SDK. It reads PR metadata
and the diff, lets the model inspect the repository read-only, feeds it
validation transcripts produced in a sandbox, and posts one marked comment.

Ships as a **Docker container action**, not a JavaScript action. The Agent SDK is
a thin wrapper that resolves a large native `claude` binary from an OS/arch-gated
optional dependency and spawns it, which cannot be bundled into a single file.

## Commands

```bash
npm ci
npm test              # node:test, no daemon/network/credentials needed
docker build -t bumptriage .
```

## SOP: documentation is part of the change

**Before any commit, update the documentation the change affects. A commit that
alters behaviour and leaves the docs describing the old behaviour is
incomplete.** Documentation here is not decoration: this project's whole claim
is that it can be trusted with a token and a repository, and that claim rests on
the docs being an accurate description of what the code does.

Work through this every time, and say in the commit which of these applied:

| If the change… | Then update |
|---|---|
| does anything at all | `docs/PROGRESS.md` — **mandatory, every commit** |
| alters behaviour a user sees | `README.md` |
| adds, removes, or renames an input | `action.yml` **and** `README.md` **and** `examples/` |
| touches isolation, authorization, secrets, or supply chain | `SECURITY.md` |
| changes a load-bearing property below | `SECURITY.md` **and** this file |
| adds or changes a provider | `examples/providers.md` **and** the README table |
| changes the release or build process | `CONTRIBUTING.md` |
| is user-visible in any way | `CHANGELOG.md` under `Unreleased` |

`docs/PROGRESS.md` is mandatory because its purpose is to distinguish "written"
from "proven". It carries per-component evidence levels and a list of open
questions. Two rules:

- **Never raise an evidence level without having actually run the thing.**
  Moving a row to ✅ is a factual claim that it was executed and observed.
  Unit tests with the external system faked are 🟡, not ✅.
- **Record what you ran**, not just the outcome, so the claim can be rechecked.
- **Verify a claim before recording it — including one made by bumptriage's own
  review, and including one made by a vendor's own documentation.** Three have
  been wrong here: a fabricated validation image, a stale branch name a human
  then repeated back, and Fireworks' compatibility page. Each was settled in
  seconds or minutes against the runner log, the downloaded artifact, the diff,
  or one HTTP request. A plausible source is evidence to check, not a source to
  quote.
- **Never write a compatibility workaround before making one call against the
  thing it works around.** The Fireworks workaround was written from the
  vendor's own page plus a corroborating bug report, was committed, and was
  wrong in every particular. Its unit tests passed, because they asserted the
  workaround was present. A workaround that is wrong does not fail loudly — it
  quietly degrades something that already worked.

If a change resolves or invalidates an entry under Open questions, update that
table in the same commit.

## Architecture

`src/action.mjs` is wiring only. Logic lives in modules that take their
side-effecting collaborators as injectable parameters (`fetchImpl`, `spawnImpl`,
`execFileImpl`) so they can be tested in isolation.

- `inputs.mjs` — reads every input from `BUMPTRIAGE_*` environment variables.
  There is no argv parsing, on purpose.
- `auth.mjs` — the authorization gate. Fails closed everywhere.
- `botprofiles.mjs` — branch prefixes and conventional logins per bot.
- `forge.mjs` / `forge-github.mjs` / `forge-gitea.mjs` — get PR, list comments
  (fully paginated), create/update comment.
- `provider.mjs` — maps provider config to the SDK's environment and options.
- `sandbox.mjs` — sibling-container validation runner. Pure
  `buildDockerRunArgs()` is separated from execution so flags are testable.
- `evidence.mjs`, `prompt.mjs`, `verdict.mjs`, `comment.mjs`, `repository.mjs`,
  `output.mjs`, `text.mjs` — supporting pieces.
- `validate/` — a composite action for the untrusted job in the two-workflow
  setup. Imports `sandbox.mjs`, which has no dependencies outside Node's
  standard library, so it needs no install step.

## Providers

- **Fireworks needs no compatibility workarounds, whatever its docs say.** Its
  Anthropic-compatibility page lists `cache_control` and `eager_input_streaming`
  as unsupported and a bug report shows both rejected with a 400. Both are
  accepted, `x-api-key` authenticates, and prompt caching genuinely engages —
  a real run returned non-zero `cache_read_input_tokens`. Setting
  `DISABLE_PROMPT_CACHING` here would switch off caching that works and charge
  the user for it. Run `scripts/fireworks-smoke.mjs` before touching the
  fireworks arm of `provider.mjs`; it carries a negative control (an invented
  field, which Fireworks *does* reject) so its assertions cannot pass vacuously.
- **Bedrock is proven on both credential modes, and its own docs were wrong four
  times.** Run `scripts/bedrock-smoke.mjs` before touching the bedrock arm of
  `provider.mjs` or the `iam/` templates. Load-bearing facts, each from a call:
  `model` must be an inference profile (`us.`-prefixed; the bare id is refused);
  prompt caching genuinely engages, so never disable it; `flex` is per-model and
  Sonnet 5 rejects it; and an API key needs **`bedrock:CallWithBearerToken`**,
  which is a separate IAM action from `bedrock:InvokeModel` — granting only the
  latter fails every request with a 403 that names the wrong problem. AWS's own
  guide also names the wrong response field for the key (`ServiceCredentialSecret`,
  not `ServiceApiKeyValue`), and AWS CLI below v2.36 creates an unretrievable
  credential rather than failing.
- **"Everything was accepted" is not evidence without a negative control.** An
  endpoint that ignores unknown fields and one that supports them look identical
  until you send something that ought to fail. The corollary bit here: when a
  probe run fails on the *credential*, every negative row passes for the wrong
  reason and the run proves nothing. `bedrock-smoke.mjs` prints the credential's
  shape first so that is obvious rather than inferred.
- **A provider can be exercised end to end locally** — no CI, no Docker, no
  release. Set the `BUMPTRIAGE_*` variables and run `node src/action.mjs` with
  `BUMPTRIAGE_POST_COMMENT=false`, a token from `gh auth token`, and
  `BUMPTRIAGE_VALIDATION_RESULTS` pointing at an artifact from an earlier
  validate run (`gh run download <id>`). That is the whole path minus the
  comment, against a real pull request, and it is what earns a ✅.
- **The agent runtime's behaviour is readable.** Which environment variables it
  honours and which fields it puts on the wire are strings in
  `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude`. Grepping it
  answers questions documentation only guesses at — but it tells you what is
  *sent*, never what the endpoint *accepts*. Only a call tells you that.

## Security model (load-bearing, not incidental)

Preserve these when editing. `SECURITY.md` documents them publicly; changing one
means changing that file too.

- **The agent cannot execute anything.** `tools: ["Read", "Glob", "Grep"]`.
  Validation runs *before* the agent and it only sees transcripts. Do not add
  Bash, write tools, or an MCP command-execution tool: any of them puts a model
  that reads attacker-influenced text back into the execution path.
- **Validation runs in a sibling container, never a child process.** A child
  shares this PID namespace and can read `/proc/<pid>/cmdline`, recovering
  secrets regardless of how its own environment is scrubbed.
- **Never `--privileged`, never mount the Docker socket** into a validation
  container. Tests assert this across all inputs.
- **The model environment is an allowlist.** `provider.mjs` must never spread
  `...process.env`; the forge token lives there.
- **No secrets in argv.** Inputs come through `runs.env` in `action.yml`.
- **PR bodies are untrusted.** Renovate and Dependabot embed the dependency's own
  changelog. Do not write a parser that extracts "facts" the model then trusts —
  pass the body through as bounded untrusted evidence.
- **Authorization is required, not advisory:** trusted author, bot branch prefix,
  no forks by default. `trusted-authors` has no default value.
- **The trigger boundary lives in the workflows, not in `auth.mjs`.** A
  branch-name `if` is a filter, not a boundary — anyone can fork a public
  repository and push a `dependabot/`-prefixed branch. Two conditions carry it,
  and both must survive any edit to a review workflow or an example:
  - validate jobs require
    `github.event.pull_request.head.repo.full_name == github.repository`;
  - review jobs require
    `github.event.workflow_run.head_repository.full_name == github.repository`,
    and take the pull request number from
    `github.event.workflow_run.pull_requests[0].number` — **never** from the
    artifact, which was produced by a job that executed pull request code.

  `auth.mjs` cannot cover this, and was never defeated when it was missing: the
  gate validates the pull request it is *handed*, so naming a genuine bot pull
  request passes every check truthfully while the evidence bundle stays
  attacker-authored. See the trigger boundary section in `SECURITY.md`.

## This repository dogfoods itself

`.github/workflows/bumptriage-{dependabot,renovate}-{validate,review}.yml` run
the two-workflow topology against this repository's own bot pull requests, using
the working tree (`uses: ./` and `./validate`) rather than a release tag. They
are near-copies of `examples/`, so a fix to one usually belongs in both.

- **Renovate manages npm; Dependabot manages github-actions and docker.**
  `renovate.json` sets `enabledManagers: ["npm"]` and `.github/dependabot.yml`
  omits npm. Both bots watching one ecosystem means duplicate pull requests and
  a duplicate paid review every time. Do not re-add npm to Dependabot.
- **Any job using the model credential must declare `environment: model-access`.**
  The key is an environment secret behind a required reviewer, not a repository
  secret. Omitting the declaration fails quietly — the job just gets no key.
  Naming an environment that does not exist creates it with no protection.
- **`validation-image` and the Dockerfile base image move together, by hand.**
  Nothing updates an `image:` string in workflow YAML: Dependabot's docker
  ecosystem reads `Dockerfile` FROM lines, and Renovate here is scoped to npm.
  Miss it and validation quietly starts proving something about the runtime the
  change is migrating away from. The `validation-image` defaults in `action.yml`
  and `validate/action.yml` are deliberately *not* kept in step — they govern the
  image a consumer's code is validated in, not this action's runtime.
- **`actions/checkout` runs before `actions/download-artifact`** in review
  workflows. Checkout cleans a non-empty workspace and deletes the transcripts.
- **The reviewing model is a floor, not a preference.** `BUMPTRIAGE_MODEL` is a
  repository variable, currently Sonnet-class. Given a byte-identical evidence
  bundle, a small fast model reported a validation transcript's container image
  as the version the pull request was migrating *away* from and built a finding
  on it, while still returning `merge`. It degrades by inventing specific,
  checkable claims — not by giving up or malforming output. The floor is about
  capability, not vendor or model family: `kimi-k3` on Fireworks reviewed #2
  through the full path with no fabricated claims. That is n=1 on the easiest
  shape of pull request this tool sees, and does not license dropping the floor.
  `docs/PROGRESS.md` and `examples/providers.md` carry the detail.

## No private infrastructure

Hostnames, model file paths, and similar operator-specific values must never
appear here: they are useless to other users, and a baked-in endpoint would send
someone's API key to a server they did not choose. `model` has no default, and
`base-url` has none for `anthropic`, which selects a protocol rather than a
service.

The one permitted exception is a provider named after a specific public vendor,
where the endpoint is a documented property of that service rather than one
operator's choice — see `PROVIDER_DEFAULT_BASE_URLS` in `inputs.mjs`. Adding an
entry there is only legitimate when the provider value names the vendor.

Use `example.test` for illustrative hostnames in docs.

## Documentation map

`docs/PROGRESS.md` (status and evidence levels), `README.md` (usage),
`SECURITY.md` (threat model and supply chain), `CONTRIBUTING.md` (development
and releases), `examples/providers.md` (per-provider configuration),
`CHANGELOG.md`. See the SOP above for which to update when.

## Distribution

Consumed as `uses: zchryr/bumptriage@v1`, with the untrusted half at
`zchryr/bumptriage/validate@v1`. Inputs in `action.yml` must stay in sync with the
environment variables `inputs.mjs` reads. Pin to a release tag, not a branch.
