// Update bots that bumptriage knows how to recognise.
//
// A profile carries only structural facts: which branch prefixes the bot pushes
// to, and which account names it conventionally uses. It deliberately carries
// nothing about the *content* of the pull request. Renovate and Dependabot both
// embed the updated dependency's own upstream changelog in the PR body, which is
// attacker-influenced text; parsing it into "structured facts" the model then
// implicitly trusts would recreate the injection surface the system prompt warns
// against. The body is passed through as untrusted evidence instead.

/**
 * `logins` are conventional defaults used only for reporting and for the
 * README's suggested configuration. Authorization always uses the operator's
 * explicit `trusted-authors` list, never these.
 */
export const BOT_PROFILES = Object.freeze({
  renovate: Object.freeze({
    id: "renovate",
    label: "Renovate",
    logins: Object.freeze(["renovate[bot]", "renovate", "mend[bot]"]),
    branchPrefixes: Object.freeze(["renovate/"]),
  }),
  dependabot: Object.freeze({
    id: "dependabot",
    label: "Dependabot",
    logins: Object.freeze(["dependabot[bot]"]),
    branchPrefixes: Object.freeze(["dependabot/"]),
  }),
});

export const BOT_IDS = Object.freeze(Object.keys(BOT_PROFILES));

/**
 * Resolve the enabled profiles, optionally overriding their branch prefixes.
 *
 * Both bots allow the branch prefix to be reconfigured (Renovate's
 * `branchPrefix`, Dependabot's `pull-request-branch-name.separator` and
 * target-branch settings), so operators can override the defaults rather than
 * being locked out by a hardcoded string.
 *
 * @param {string[]} ids Enabled profile ids.
 * @param {string[]} [prefixOverrides] Replaces every profile's prefixes when non-empty.
 */
export function resolveProfiles(ids, prefixOverrides = []) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("At least one bot profile must be enabled.");
  }

  return ids.map((id) => {
    const profile = BOT_PROFILES[id];
    if (!profile) {
      throw new Error(
        `Unknown bot ${JSON.stringify(id)}. Known bots: ${BOT_IDS.join(", ")}.`,
      );
    }
    return prefixOverrides.length > 0
      ? { ...profile, branchPrefixes: [...prefixOverrides] }
      : profile;
  });
}

/**
 * Find the profile whose branch prefix matches this head ref, or null.
 * Branch refs are case-sensitive, so this comparison is too.
 */
export function matchProfileByBranch(headRef, profiles) {
  const ref = String(headRef ?? "");
  if (!ref) return null;
  return (
    profiles.find((profile) =>
      profile.branchPrefixes.some((prefix) => ref.startsWith(prefix)),
    ) ?? null
  );
}
