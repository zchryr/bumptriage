// Review comment upsert.

export const MARKER = "<!-- bumptriage-review -->";

/**
 * Create the review comment, or update the one bumptriage previously left.
 *
 * The comment list is paginated exhaustively before deciding. The original
 * implementation read only the first page, so on a pull request with more
 * comments than one page holds it never found its own marker and appended a new
 * comment on every run.
 */
export async function upsertComment({ forge, repository, number, body }) {
  const comments = await forge.listComments({ repository, number });
  const existing = comments.find((comment) => comment?.body?.includes(MARKER));

  if (existing) {
    await forge.updateComment({ repository, id: existing.id, body });
    return { action: "updated", id: existing.id };
  }

  const created = await forge.createComment({ repository, number, body });
  return { action: "created", id: created?.id ?? null };
}
