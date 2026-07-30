# OIDC and IAM role design

Status: **contains a known defect and an unimplemented recommendation.** Read
this before touching `iam/` or the example workflows.

## Summary

1. `iam/bedrock-oidc-role.yaml` as shipped **cannot work**. It conditions on a
   claim AWS does not accept as a condition key.
2. The fix and the org-wide scaling problem have the same answer: pin trust to a
   **reusable workflow** via `job_workflow_ref`, scoped to the org by
   `repository_owner_id`. That is one role for every repository, not one role
   per repository.
3. Implementing it requires shipping the review job as a reusable workflow,
   which the examples currently do not do.

## The defect

`iam/bedrock-oidc-role.yaml` contains:

```yaml
token.actions.githubusercontent.com:workflow_ref: !Sub "${GitHubOwner}/..."
```

**`workflow_ref` is not an AWS IAM condition key.** AWS documents
`job_workflow_ref` — with the `job_` prefix, and different semantics. There is no
plain `workflow_ref`.

The condition can therefore never match, so the role can never be assumed. It
fails closed, so this is not a security hole; it is a role nobody can use. It
would surface on the first real release, not before, which is why `iam/` is
tracked as untested in [PROGRESS.md](PROGRESS.md).

## Condition keys AWS actually supports

From the AWS IAM documentation, "Available keys for AWS OIDC federation",
addressed as `token.actions.githubusercontent.com:<claim>`:

| Key | Use |
|---|---|
| `aud` | Always pin to `sts.amazonaws.com` |
| `sub` | Composite subject; format varies by trigger |
| `job_workflow_ref` | **Reference path to the reusable workflow a job uses** |
| `repository` | `OWNER/REPO`, mutable — a rename changes it |
| `repository_id` | Immutable numeric repository id |
| `repository_owner_id` | **Immutable numeric org id** |
| `enterprise_id` | Immutable numeric enterprise id |
| `workflow` | Workflow *name*, not its path |
| `ref`, `environment`, `actor`, `actor_id`, `amr` | Situational |

Support for these provider-specific claims is recent — AWS STS added GitHub
claim validation in January 2026. Anything written against older guidance will
assume only `aud` and `sub` are available.

Note what is absent: `workflow_ref` and `repository_owner` (the *name*). Use
`job_workflow_ref` and `repository_owner_id` instead. The id-based keys are also
the better choice on their own merits, since names can be renamed or, once
released, registered by someone else.

## Recommended design: one role per org

```yaml
Condition:
  StringEquals:
    token.actions.githubusercontent.com:aud: sts.amazonaws.com
    # Immutable org id. Survives a rename and cannot be claimed by anyone
    # registering a recycled org name.
    token.actions.githubusercontent.com:repository_owner_id: "123456"
    # The exact reusable workflow, at an exact ref.
    token.actions.githubusercontent.com:job_workflow_ref: >-
      MYORG/.github/.github/workflows/bumptriage-review.yml@refs/tags/v1.0.0
```

One role. Every repository in the org. Nothing per-repo.

The property that makes this safe is *where* `job_workflow_ref` points: AWS
defines it as the path to the **reusable** workflow, which lives in one
repository you control. A consuming repository can call that workflow but cannot
alter what it does. GitHub documents this as the intended mechanism for
organisation-wide trust.

This is stronger than per-repo roles, not a convenience trade. It also sidesteps
the immutable-subject-claim format change of July 2026 entirely, because it never
conditions on `sub`.

### Do not wildcard the repository instead

The shortcut below is a privilege escalation path and must not ship:

```yaml
# WRONG
token.actions.githubusercontent.com:job_workflow_ref: "MYORG/*/.github/workflows/bumptriage-review.yml@*"
```

Anyone who can create a repository or add a workflow file anywhere in the org
can name a file `bumptriage-review.yml`, put arbitrary steps in it, and assume
the role. Across hundreds of repositories that is a large set of people.

## What implementing this requires

The examples today are standalone workflows that consumers copy. `job_workflow_ref`
is only present in the token when a job uses a reusable workflow, so the review
job has to become one.

Consuming repositories would then shrink to roughly:

```yaml
jobs:
  review:
    uses: MYORG/.github/.github/workflows/bumptriage-review.yml@v1
    secrets: inherit
```

This pays for itself independently of IAM: one file changes when bumptriage
changes, rather than one per repository.

### Implementation checklist

- [ ] Add a reusable workflow (`on: workflow_call`) wrapping the review job,
      with inputs for model, provider, bots, and trusted authors, and
      `secrets: inherit` from the caller.
- [ ] Confirm a `workflow_run`-triggered caller can invoke a reusable workflow
      and that `job_workflow_ref` appears in the resulting token. Both are
      expected to work; neither has been observed.
- [ ] Replace `WorkflowFileName` in `iam/bedrock-oidc-role.yaml` with
      `ReusableWorkflowRef` and `GitHubOwnerId`, and rewrite the trust policy as
      above. Remove the `workflow_ref` condition and the `sub` wildcard.
- [ ] Decide whether the per-bot role split survives. `job_workflow_ref` can
      distinguish two reusable workflows, so per-bot roles remain possible — but
      with one org-wide role the case for splitting is weaker than it was when
      roles were per-repo.
- [ ] Update `examples/` to the reusable-workflow shape, and the README and
      SECURITY sections that describe `workflow_ref` pinning.
- [ ] Deploy the stack and assume the role for real before marking anything
      verified.

### Two decisions to make first

**Floating tag or exact version.** Pinning `job_workflow_ref` to `@refs/tags/v1`
means the trust policy accepts whatever `v1` currently points at, so moving that
tag silently changes what can assume the role. Pinning `@refs/tags/v1.0.0` is
immutable but requires an IAM update per release. The floating form is defensible
here only because you control the tag.

**Where the reusable workflow lives.** An org's `.github` repository is the
conventional home. Keep `repository_owner_id` in the policy regardless: if that
repository is ever public, a fork outside the org could otherwise produce a
matching `job_workflow_ref`.

## References

- AWS IAM — "Available keys for AWS OIDC federation" in the condition context
  keys reference
- AWS STS provider-specific claim validation, announced January 2026
- GitHub — OIDC token claims reference, and "using OpenID Connect with reusable
  workflows"
