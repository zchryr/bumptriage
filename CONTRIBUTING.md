# Contributing

Thanks for your interest. Issues and pull requests are welcome.

## Getting set up

```bash
npm ci
npm test
```

Tests use Node's built-in runner and need no daemon, network, or credentials.
Anything with an external effect — Docker, `fetch`, `git` — is injected, so it
can be faked in a test.

```bash
docker build -t bumptriage .   # the action ships as a container image
```

## Things that are load-bearing

A few properties are the reason this project is safe to run at all. Changing them
needs a corresponding change to [SECURITY.md](SECURITY.md) and a clear
explanation in the pull request:

- **The agent has no execution tools.** `tools` is `["Read", "Glob", "Grep"]`.
  Adding a shell, a write tool, or any command-running tool puts a model that
  reads attacker-influenced text back into the execution path.
- **Validation runs in a sibling container, never a child process.** The PID
  namespace boundary is what stops a validation command from reading this
  process's arguments and environment.
- **The model environment is an allowlist.** `src/provider.mjs` never spreads
  `process.env`. The forge token lives in this process's environment.
- **No secrets on the command line.** Inputs arrive through `runs.env`.
- **The authorization gate fails closed.** Every check in `src/auth.mjs` rejects
  on missing or malformed input rather than falling through.

Tests assert several of these directly, including that the sandbox arguments
never contain `--privileged` or the Docker socket under any input. If you find
yourself editing a test to make a change pass, stop and ask whether the change is
right.

## No private infrastructure

Keep operator-specific hostnames and model file paths out of the tree. They are
useless to other users, and a baked-in endpoint would send someone's API key to
a server they did not choose — which is why `model` has no default and
`base-url` has none for `anthropic`. Use `example.test` for illustrative
hostnames in docs and examples.

## Releasing

1. Run the **Release** workflow with the version (for example `0.2.0`). It runs
   the checks, builds and pushes a multi-arch image to GHCR, attests build
   provenance and an SBOM, and opens a pull request pinning `action.yml` to the
   published digest.
2. Verify the attestation named in that pull request before merging:
   ```bash
   gh attestation verify oci://ghcr.io/zchryr/bumptriage@sha256:… --repo zchryr/bumptriage
   ```
3. Merge, tag the merge commit `vX.Y.Z`, and move the `vX` tag.
4. Publish the GitHub release. That triggers the CloudFormation templates being
   synced to S3.

`main` keeps `image: Dockerfile` so forks and contributors build from source;
only release tags carry the pinned digest. `node scripts/pin-image.mjs --unpin`
restores the source build if you need to undo a pin locally.

## Dependency updates

Third-party actions are pinned by commit SHA and base images by digest, in this
repository's own workflows and Dockerfile. Keep it that way — a tag can be moved
by whoever controls it. Dependabot raises the updates, so pinning does not decay
into staleness. Agent SDK updates come as their own pull request rather than in a
batch, because that dependency's behaviour is the product.

## Style

Match the surrounding code. Comments should explain why something is the way it
is, particularly where the reason is a security property that is not obvious from
reading the code. Prefer a short comment on a subtle decision over a long one
restating what the code does.

## Pull requests

- Keep the change focused; unrelated cleanups belong in their own pull request.
- Add tests for behaviour changes, and for any bug you fix.
- Update `CHANGELOG.md` under `Unreleased`.
- Say plainly in the description if you changed anything listed above.

By contributing you agree that your contributions are licensed under Apache-2.0.
