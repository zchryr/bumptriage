// The authorization gate.
//
// This is the only thing standing between "a bot opened a routine dependency
// update" and "an arbitrary pull request causes bumptriage to run an agent over
// the repository and publish a review comment". Every check here fails closed,
// and none of them may be relaxed without re-reading SECURITY.md.

import { matchProfileByBranch } from "./botprofiles.mjs";

export class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function normalizeLogin(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeRepository(value) {
  return normalizeLogin(value);
}

/**
 * Decide whether a pull request may be reviewed.
 *
 * @param {object} args
 * @param {object} args.pull Pull request as returned by the forge.
 * @param {string} args.repository Base repository in `owner/name` form.
 * @param {string[]} args.trustedAuthors Operator-configured account names.
 * @param {object[]} args.profiles Enabled bot profiles.
 * @param {boolean} [args.allowForks] Permit pull requests from forks.
 * @param {Array<number|string>} [args.trustedAuthorIds] Optional numeric account
 *   ids. When non-empty the author's id must appear here, which pins trust to a
 *   specific account rather than to a claimable display name.
 * @returns {{profile: object, author: string}}
 */
export function authorizeReview({
  pull,
  repository,
  trustedAuthors,
  profiles,
  allowForks = false,
  trustedAuthorIds = [],
}) {
  if (!Array.isArray(trustedAuthors) || trustedAuthors.length === 0) {
    throw new AuthorizationError(
      "trusted-authors is empty. Configure the exact account names your update bot uses.",
    );
  }

  const author = String(pull?.user?.login ?? pull?.user?.username ?? "").trim();
  if (!author) {
    throw new AuthorizationError("The pull request has no author; refusing to review.");
  }

  const allowed = new Set(trustedAuthors.map(normalizeLogin).filter(Boolean));
  if (!allowed.has(normalizeLogin(author))) {
    throw new AuthorizationError(
      `Pull request author ${JSON.stringify(author)} is not in trusted-authors.`,
    );
  }

  // A login ending in `[bot]` cannot belong to a human on GitHub — that
  // character is not legal in a username — so when the forge tells us the
  // account type, hold it to that claim. Self-hosted bots running under an
  // ordinary user account are unaffected, since their login has no suffix.
  const accountType = pull?.user?.type;
  if (author.toLowerCase().endsWith("[bot]") && accountType && accountType !== "Bot") {
    throw new AuthorizationError(
      `Author ${JSON.stringify(author)} looks like an app account but the forge reports type ${JSON.stringify(accountType)}.`,
    );
  }

  if (trustedAuthorIds.length > 0) {
    const ids = new Set(trustedAuthorIds.map((id) => String(id)));
    const actual = pull?.user?.id;
    if (actual === undefined || actual === null || !ids.has(String(actual))) {
      throw new AuthorizationError(
        `Author ${JSON.stringify(author)} has account id ${JSON.stringify(actual ?? null)}, which is not in trusted-author-ids.`,
      );
    }
  }

  const headRef = String(pull?.head?.ref ?? "");
  const profile = matchProfileByBranch(headRef, profiles);
  if (!profile) {
    const expected = profiles.flatMap((entry) => entry.branchPrefixes).join(", ");
    throw new AuthorizationError(
      `Head branch ${JSON.stringify(headRef)} does not start with an update-bot prefix (${expected}).`,
    );
  }

  // A fork's head repository is attacker-controlled, and a missing head repo
  // means the fork was deleted, so we can no longer prove where the code came
  // from. Both are refused unless the operator opted in.
  if (!allowForks) {
    const base = normalizeRepository(pull?.base?.repo?.full_name ?? repository);
    const head = normalizeRepository(pull?.head?.repo?.full_name ?? "");
    if (!head) {
      throw new AuthorizationError(
        "The pull request head repository is missing (deleted fork?); refusing to review.",
      );
    }
    if (head !== base) {
      throw new AuthorizationError(
        `Pull request originates from fork ${JSON.stringify(head)}; set allow-forks to review it.`,
      );
    }
  }

  return { profile, author };
}
