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
