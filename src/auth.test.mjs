import test from "node:test";
import assert from "node:assert/strict";

import { authorizeReview, AuthorizationError } from "./auth.mjs";
import { resolveProfiles } from "./botprofiles.mjs";

const profiles = resolveProfiles(["renovate", "dependabot"]);

function pullRequest(overrides = {}) {
  return {
    number: 7,
    user: { login: "renovate[bot]", type: "Bot", id: 29139614 },
    head: { ref: "renovate/lodash-4.x", repo: { full_name: "acme/widgets" } },
    base: { ref: "main", repo: { full_name: "acme/widgets" } },
    ...overrides,
  };
}

const baseArgs = {
  repository: "acme/widgets",
  trustedAuthors: ["renovate[bot]"],
  profiles,
};

test("authorizes a trusted bot on a matching branch", () => {
  const { profile, author } = authorizeReview({ pull: pullRequest(), ...baseArgs });
  assert.equal(profile.id, "renovate");
  assert.equal(author, "renovate[bot]");
});

test("matches the author case-insensitively in both directions", () => {
  const result = authorizeReview({
    pull: pullRequest({ user: { login: "Renovate[Bot]", type: "Bot" } }),
    ...baseArgs,
    trustedAuthors: ["RENOVATE[BOT]"],
  });
  assert.equal(result.profile.id, "renovate");
});

test("rejects an untrusted author regardless of branch", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ user: { login: "attacker" } }),
        ...baseArgs,
      }),
    AuthorizationError,
  );
});

test("rejects a trusted author on a non-bot branch", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ head: { ref: "feature/x", repo: { full_name: "acme/widgets" } } }),
        ...baseArgs,
      }),
    /does not start with an update-bot prefix/,
  );
});

test("attributes dependabot branches to the dependabot profile", () => {
  const { profile } = authorizeReview({
    pull: pullRequest({
      user: { login: "dependabot[bot]", type: "Bot" },
      head: { ref: "dependabot/npm_and_yarn/lodash-4.17.21", repo: { full_name: "acme/widgets" } },
    }),
    ...baseArgs,
    trustedAuthors: ["dependabot[bot]"],
  });
  assert.equal(profile.id, "dependabot");
});

test("rejects an empty author even when the trusted list has blank entries", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ user: { login: "   " } }),
        ...baseArgs,
        trustedAuthors: ["", "   "],
      }),
    AuthorizationError,
  );
});

test("rejects when trusted-authors is empty", () => {
  assert.throws(
    () => authorizeReview({ pull: pullRequest(), ...baseArgs, trustedAuthors: [] }),
    /trusted-authors is empty/,
  );
});

test("rejects a fork by default and allows it when opted in", () => {
  const forked = pullRequest({
    head: { ref: "renovate/lodash-4.x", repo: { full_name: "attacker/widgets" } },
  });

  assert.throws(() => authorizeReview({ pull: forked, ...baseArgs }), /originates from fork/);

  const result = authorizeReview({ pull: forked, ...baseArgs, allowForks: true });
  assert.equal(result.profile.id, "renovate");
});

test("rejects a pull request whose head repository is missing", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ head: { ref: "renovate/x", repo: null } }),
        ...baseArgs,
      }),
    /head repository is missing/,
  );
});

test("rejects a [bot] login the forge does not report as a bot account", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ user: { login: "renovate[bot]", type: "User" } }),
        ...baseArgs,
      }),
    /looks like an app account/,
  );
});

test("enforces trusted-author-ids when configured", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ user: { login: "renovate[bot]", type: "Bot", id: 999 } }),
        ...baseArgs,
        trustedAuthorIds: ["29139614"],
      }),
    /not in trusted-author-ids/,
  );

  const ok = authorizeReview({
    pull: pullRequest(),
    ...baseArgs,
    trustedAuthorIds: ["29139614"],
  });
  assert.equal(ok.profile.id, "renovate");
});

test("rejects when an id allowlist is set but the forge reports no id", () => {
  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest({ user: { login: "renovate[bot]", type: "Bot" } }),
        ...baseArgs,
        trustedAuthorIds: ["29139614"],
      }),
    /not in trusted-author-ids/,
  );
});

test("honours overridden branch prefixes", () => {
  const custom = resolveProfiles(["renovate"], ["deps/"]);
  const { profile } = authorizeReview({
    pull: pullRequest({ head: { ref: "deps/lodash", repo: { full_name: "acme/widgets" } } }),
    ...baseArgs,
    profiles: custom,
  });
  assert.equal(profile.id, "renovate");

  assert.throws(
    () =>
      authorizeReview({
        pull: pullRequest(),
        ...baseArgs,
        profiles: custom,
      }),
    /does not start with an update-bot prefix/,
  );
});
