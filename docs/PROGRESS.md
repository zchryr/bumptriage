# Progress

Status of the project against what has actually been proven, rather than what
has been written. **Update this file in the same commit as the change it
describes** — see the SOP in `CLAUDE.md`.

Last updated: 2026-07-30 · Target: v0.1.0 · Not yet released

## Honest summary

All of the code is written and unit-tested. **None of it has reviewed a real
pull request.** The end-to-end path — forge API, agent run, comment upsert — has
never executed against live services. Treat v0.1 as unproven until the
end-to-end rows below are green.

The repository now dogfoods itself:
`.github/workflows/bumptriage-dependabot-{validate,review}.yml` run the
two-workflow topology against this repository's own Dependabot pull requests,
using the working tree (`uses: ./`) rather than a release tag. Wired, not yet
observed to produce a comment.

## Evidence levels

| Level | Meaning |
|---|---|
| ✅ verified | Executed and observed, either by a test or by hand |
| 🟡 unit only | Covered by tests with the external system faked |
| ⚪ untested | Written, never run |
| ❌ blocked | Cannot proceed without something external |

## Components

| Area | State | Evidence |
|---|---|---|
| Input reading (`inputs.mjs`) | ✅ verified | Unit tests; error path observed in the built image |
| Authorization gate (`auth.mjs`) | 🟡 unit only | 13 tests: case-insensitivity, forks, bot-account type, id allowlist |
| Bot profiles (`botprofiles.mjs`) | 🟡 unit only | Covered through the gate's tests |
| Sandbox flags (`buildDockerRunArgs`) | ✅ verified | Unit tests incl. negative assertions on `--privileged` and the Docker socket |
| Sandbox execution | ✅ verified | Ran against a real repository and daemon; see Isolation below |
| Provider — anthropic | 🟡 unit only | Env allowlist asserted; never called a live endpoint |
| Provider — fireworks | ⚪ untested | Endpoint documented as Anthropic-compatible; never called |
| Provider — bedrock | ⚪ untested | Env shape asserted; no live Bedrock call |
| Forge — GitHub | ⚪ untested | No live API call at all |
| Forge — Gitea | ⚪ untested | No live API call at all |
| Comment upsert | 🟡 unit only | Pagination proven against a faked forge |
| Evidence assembly / truncation | 🟡 unit only | Budget behaviour tested |
| Verdict parsing | 🟡 unit only | Several report shapes tested |
| Agent invocation | ⚪ untested | `query()` has never been called by this code |
| Action image | ✅ verified | Builds; fails closed with no configuration; tools present |
| Two-workflow topology | ⚪ untested | Never run on a runner |
| `validate/` composite action | ⚪ untested | Never run on a runner |
| CloudFormation templates | ❌ blocked | `bedrock-oidc-role.yaml` conditions on `workflow_ref`, which is not an AWS condition key — see [OIDC.md](OIDC.md) |
| Release / attestation workflow | ⚪ untested | Never run |

## Isolation properties

The reason the sandbox exists. Verified by running a validation command that
actively tried to escape, against a real Docker daemon, with secrets placed on
the parent process's command line.

| Property | State | How |
|---|---|---|
| Parent argv unreadable from sandbox | ✅ verified | `/proc/1/cmdline` inside showed the sandbox's own init, not the action |
| Parent environment unreadable | ✅ verified | `/proc/1/environ` showed only the scrubbed sandbox env |
| Runs unprivileged | ✅ verified | `id` reported `uid=65534(nobody)` |
| Root filesystem read-only | ✅ verified | Write to `/` refused; tmpfs writable |
| Workspace is the committed tree only | ✅ verified | No `.git`, no untracked files present |
| Workspace writable by the sandbox user | ✅ verified | Post-extraction `chown` confirmed working |
| Non-zero exit captured as evidence | ✅ verified | A command exiting 3 was recorded, not raised |
| `--network=none` blocks egress | ✅ verified | DNS resolution failed as expected |
| Never `--privileged` / no Docker socket | ✅ verified | Asserted across all input combinations |

## Known defects

Shipped and wrong, as opposed to merely unproven.

| Defect | Effect | Fix |
|---|---|---|
| `iam/bedrock-oidc-role.yaml` conditions on `token.actions.githubusercontent.com:workflow_ref` | Not an AWS condition key, so the condition never matches and the role can never be assumed. Fails closed — unusable, not insecure. | Rewrite around `job_workflow_ref` + `repository_owner_id`; see [OIDC.md](OIDC.md) |
| `examples/bumptriage-{dependabot,renovate}-review.yml` download the transcripts *before* `actions/checkout` | Checkout cleans a non-empty workspace, so the review job very likely starts with the transcripts deleted. Reasoned from checkout's documented behaviour, not yet observed. | Reorder so checkout runs first, as the dogfooding workflows in `.github/workflows/` do |

## Open questions

Things that could still invalidate a design decision.

| Question | Impact if wrong | Resolution |
|---|---|---|
| Does `runs.image` accept a digest reference? | Release pinning falls back to a mutable tag | First release proves it |
| Is `/var/run/docker.sock` present inside a container action? | Single-job topology unusable; two-workflow unaffected | Minimal action running `docker ps` |
| Can Dependabot runs mint an OIDC token? | Nothing — the two-workflow split makes it moot | Canary on a real Dependabot PR |
| Does `runs.env` work on Gitea's act_runner? | Gitea users get missing-variable errors, which fail loudly | Run on a Gitea instance |
| Does Fireworks tolerate the `cache_control` the runtime sends? | Degraded caching, or hard failure | Live call against Fireworks |
| Do small local models hold tool-call format? | Endpoints fronted by a proxy may be unusable in practice | v0.2 compatibility probe |
| Can a `workflow_run`-triggered caller invoke a reusable workflow and still get `job_workflow_ref` in its token? | The org-wide IAM design in [OIDC.md](OIDC.md) depends on it | Canary workflow before rewriting the template |

## Roadmap

### v0.1.0 — unreleased

- [x] Authorization gate, bot profiles, forge adapters
- [x] Sandboxed validation in a sibling container
- [x] Secrets out of argv, allowlisted model environment
- [x] Anthropic, Fireworks, and Bedrock providers
- [x] Two-workflow topology and example workflows
- [x] CloudFormation for Bedrock OIDC and static keys
- [x] Unit tests, CodeQL, Dependabot
- [x] Release automation with provenance and SBOM attestation
- [ ] **End-to-end run against a real Renovate pull request**
- [ ] **End-to-end run against a real Dependabot pull request**
- [ ] Resolve the open questions above
- [ ] **Rewrite the Bedrock IAM role around `job_workflow_ref`** — see [OIDC.md](OIDC.md); the current template cannot be assumed
- [ ] Ship the review job as a reusable workflow, which the IAM rewrite requires
- [ ] Publish and verify the first attested image
- [ ] Confirm comment upsert on a pull request with more than one page of comments

### v0.2.0 — planned

- [ ] Compatibility probe for arbitrary Anthropic-compatible endpoints
- [ ] Per-command validation image override

Building an Anthropic ↔ OpenAI translation proxy was previously planned here and
has been dropped. It was the largest and riskiest item on the roadmap, and the
job is already done by proxies people can run themselves, which then look like an
ordinary Anthropic-compatible endpoint.

### Later

- [ ] Gitea coverage in CI, or drop the claim
- [ ] Published S3 bucket and Launch Stack links
- [ ] GitHub Marketplace listing

## Known limitations

Deliberate, documented, not defects.

- One validation image applies to every command; polyglot repositories build
  their own.
- The sandbox isolates credentials and the host, not the network. Validation can
  reach the internet unless `network: none` is set, which breaks installs.
- The snapshot excludes `.git`, so `git describe`-derived versioning fails.
- The `[bot]` account-type check is skipped where the forge reports no type,
  which includes Gitea.
- `recommendation` is advisory. It must not gate an unattended merge.
