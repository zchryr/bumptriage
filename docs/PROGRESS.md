# Progress

Status of the project against what has actually been proven, rather than what
has been written. **Update this file in the same commit as the change it
describes** — see the SOP in `CLAUDE.md`.

Last updated: 2026-07-31 · Target: v0.1.0 · Not yet released

## Honest summary

**The end-to-end path works, for both bots.** On 2026-07-30 bumptriage reviewed
a real Dependabot pull request ([#3][pr3], run [30584609805][run3]) and a real
Renovate one ([#5][pr5], run [30587101886][run5]) — both its own
`@anthropic-ai/claude-agent-sdk` 0.3.195 → 0.3.220 bump — and posted a verdict
comment on each. Validation ran in the sandbox, the transcripts crossed the
`workflow_run` boundary as an artifact, the agent read the repository, and the
comment was created. `claude-haiku-4-5-20251001` over the `anthropic` provider.

[pr3]: https://github.com/zchryr/bumptriage/pull/3
[run3]: https://github.com/zchryr/bumptriage/actions/runs/30584609805
[pr5]: https://github.com/zchryr/bumptriage/pull/5
[run5]: https://github.com/zchryr/bumptriage/actions/runs/30587101886

The repository dogfoods itself:
`.github/workflows/bumptriage-{dependabot,renovate}-{validate,review}.yml` run
the two-workflow topology against this repository's own bot pull requests, using
the working tree (`uses: ./`) rather than a release tag. Renovate manages npm
and Dependabot manages github-actions and docker, so the two never open a
duplicate pull request and both bot profiles get exercised. Each bot's pair was
observed skipping the other's branches.

The trigger-boundary hardening is exercised on the happy path: run 30587101886
resolved the pull request number from the `workflow_run` event and matched it
against the artifact's copy. The **hostile** path — a fork pull request on a
bot-prefixed branch — has not been tested, and testing it needs a scratch fork.

The review credential is held in a `model-access` GitHub Environment with a
required reviewer, so every run above paused for manual approval before spending
anything. Verified by observation, including a run that failed closed on an
empty key.

**On review quality, the picture is worse than it first looked, and this is the
most important thing on this page.**

First pass on #1: the transcripts were produced on `node:24` while the pull
request moved the Dockerfile to `node:25`. The review said so, unprompted, and
traced the gap through `ci.yml` and both validate workflows. That looked like
exactly the behaviour this project claims.

Second pass on the same pull request, after the validate workflows were moved to
`node:25` in the same branch: the transcripts recorded
`image: "node:25-bookworm-slim"` for both commands, `evidence.mjs:56` put that
field in the bundle, and the review nonetheless reported *"npm ci → exit 0
(image: node:24-bookworm-slim)"* and concluded *"No test evidence from the target
version exists."* Verified three ways — the runner log shows only `node:25`, the
downloaded `validations.json` records `node:25` for both commands, and the field
is demonstrably passed to the model.

The same conclusion was reached with the evidence pointing both ways, which
means it came from the diff's `node:24 → node:25` strings rather than from the
transcript. The first pass was right by coincidence, not by reading.

Third pass, rerunning the *same* run so the artifact and prompt were byte-identical
and only `BUMPTRIAGE_MODEL` changed, from `claude-haiku-4-5-20251001` to
`claude-sonnet-5`. It read the field correctly and cited it by name — *"matching
the new image per the `validations[].image` field"*. It also, unprompted:

- noticed this pull request is **not** a pure Dependabot bump, reasoning from
  `.github/dependabot.yml` that the docker ecosystem watches only the Dockerfile,
  therefore the workflow and docs hunks were human-authored despite the pull
  request being attributed to `dependabot[bot]` — correct, and the right thing to
  flag on a bot-attributed change;
- ran the prompt-injection check and reported the negative explicitly;
- found that `sandbox.test.mjs` injects a fake `spawnImpl`, so no real
  `child_process` behaviour is exercised under the new runtime.

**Conclusion: this was a model ceiling, not a prompt or plumbing defect.** The
same bundle produced a fabricated finding on Haiku 4.5 and an accurate,
substantially sharper review on Sonnet 5. Treat Sonnet-class as the floor for
this task; the reviewing model is doing long-context, many-turn reasoning over
structured evidence, and a cheaper model degrades by inventing evidence rather
than by admitting uncertainty — which is the worst available failure mode.

The advisory-only framing of `recommendation` in `README.md` and `SECURITY.md`
is not boilerplate either: the Haiku run fabricated a specific, checkable, false
claim about its own evidence while returning `merge`.

Still unproven: Gitea, Fireworks, Bedrock, the release and attestation workflow,
and comment upsert across more than one page of comments. Treat those rows, not
the project as a whole, as the remaining risk.

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
| Authorization gate (`auth.mjs`) | ✅ verified | 13 tests, plus admitted a real `dependabot[bot]` PR in run 30584609805 |
| Bot profiles (`botprofiles.mjs`) | ✅ verified | The `dependabot/` prefix matched a real head branch in the same run |
| Sandbox flags (`buildDockerRunArgs`) | ✅ verified | Unit tests incl. negative assertions on `--privileged` and the Docker socket |
| Sandbox execution | ✅ verified | Ran against a real repository and daemon; see Isolation below |
| Provider — anthropic | ✅ verified | Live call to `api.anthropic.com` with `claude-haiku-4-5-20251001`, run 30584609805 |
| Provider — fireworks | ⚪ untested | Endpoint documented as Anthropic-compatible; never called |
| Provider — bedrock | ⚪ untested | Env shape asserted; no live Bedrock call |
| Forge — GitHub | ✅ verified | Read PR #3 and posted a comment, run 30584609805 |
| Forge — Gitea | ⚪ untested | No live API call at all |
| Comment upsert | ✅ verified | Create path on #3/#4/#5; **update** path on #1 — comment id 5137399011 edited in place on a second review rather than duplicated. >1 page of comments still unproven |
| Evidence assembly / truncation | 🟡 unit only | Real transcripts reached the model and were quoted back; the truncation budget was never approached |
| Verdict parsing | 🟡 unit only | Several report shapes tested; the `recommendation` output value was not inspected on the live run |
| Agent invocation | ✅ verified | `query()` ran to completion and produced a report, run 30584609805 |
| Action image | ✅ verified | Builds; fails closed with no configuration; built on a runner from `image: Dockerfile` |
| Two-workflow topology | ✅ verified | `pull_request` → artifact → `workflow_run` → comment, end to end on GitHub |
| `validate/` composite action | ✅ verified | Ran `npm ci` and `npm test` in the sandbox and produced consumable transcripts |
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
| `examples/bumptriage-{dependabot,renovate}-review.yml` downloaded the transcripts *before* `actions/checkout` | Checkout cleans a non-empty workspace, so the review job very likely started with the transcripts deleted. Reasoned from checkout's documented behaviour, not observed. | **Fixed 2026-07-30** — checkout now runs first in all review workflows |
| The example workflows let a fork pull request reach the privileged review job | A branch-name `if` is not a boundary: anyone could fork a public repository, push a `dependabot/`-prefixed branch, and produce the artifact that triggers `workflow_run`. The review job then ran with the owner's model credential. | **Fixed 2026-07-30** — validate and single-job now require `head.repo.full_name == github.repository`, and review requires `workflow_run.head_repository.full_name == github.repository` |
| The review workflows read the pull request number from the untrusted artifact | Whoever produced the artifact chose which pull request was reviewed. Naming a genuine bot pull request passed every `auth.mjs` check truthfully while the evidence bundle stayed attacker-authored — an owner-funded model call and an injected comment posted with `pull-requests: write`. Never observed in the wild; this repository's fork-approval default gated it. | **Fixed 2026-07-30** — the number now comes from `workflow_run.pull_requests[0].number`, with the artifact's copy compared as a tamper signal. See the trigger boundary section in `SECURITY.md` |

## Open questions

Things that could still invalidate a design decision.

| Question | Impact if wrong | Resolution |
|---|---|---|
| Does `runs.image` accept a digest reference? | Release pinning falls back to a mutable tag | First release proves it |
| Can Dependabot runs mint an OIDC token? | Nothing — the two-workflow split makes it moot | Canary on a real Dependabot PR |
| Does `runs.env` work on Gitea's act_runner? | Gitea users get missing-variable errors, which fail loudly | Run on a Gitea instance |
| Does Fireworks tolerate the `cache_control` the runtime sends? | Degraded caching, or hard failure | Live call against Fireworks |
| Do small local models hold tool-call format? | Endpoints fronted by a proxy may be unusable in practice | v0.2 compatibility probe |
| Can a `workflow_run`-triggered caller invoke a reusable workflow and still get `job_workflow_ref` in its token? | The org-wide IAM design in [OIDC.md](OIDC.md) depends on it | Canary workflow before rewriting the template |

**Resolved 2026-07-30.** `permissionMode: "dontAsk"` (`action.mjs:149`) is a
value the agent SDK recognises. In 0.3.220 the type is
`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`,
so the v0.3.214 change rejecting unrecognised modes does not affect it. Checked
by installing 0.3.220 and reading `sdk.d.ts:2092`. Raised by the review on #5,
which flagged the SDK change without claiming `dontAsk` was invalid — the
hedging was correct.

**Resolved 2026-07-30.** `/var/run/docker.sock` *is* mounted into a container
action on a GitHub-hosted runner — it appears in the `docker run` invocation the
runner logged for run 30584609805, without the action requesting it. The
single-job topology is therefore viable on GitHub. Note this is the runner
mounting the socket into the *action*, which is what lets it start sibling
validation containers; validation containers themselves still never receive it.

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
- [x] **End-to-end run against a real Renovate pull request** — #5, run
      30587101886, 2026-07-30
- [x] **End-to-end run against a real Dependabot pull request** — #3, run
      30584609805, 2026-07-30
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
- `validation-image` is a plain string in the workflow, so no updater maintains
  it. Dependabot's docker ecosystem reads `Dockerfile` FROM lines, not workflow
  inputs, and Renovate here is scoped to npm. It therefore drifts away from the
  runtime the action actually ships on, and validation quietly starts proving
  something about the wrong version. Surfaced by the review on #1, which noticed
  that its own evidence had been produced on `node:24` while the pull request
  moved the Dockerfile to `node:25`.
- The sandbox isolates credentials and the host, not the network. Validation can
  reach the internet unless `network: none` is set, which breaks installs.
- The snapshot excludes `.git`, so `git describe`-derived versioning fails.
- The `[bot]` account-type check is skipped where the forge reports no type,
  which includes Gitea.
- `recommendation` is advisory. It must not gate an unattended merge.
