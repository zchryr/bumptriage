import test from "node:test";
import assert from "node:assert/strict";

import { upsertComment, MARKER } from "./comment.mjs";

/** A forge whose comments span several pages, like a long-lived pull request. */
function fakeForge(pages) {
  const calls = { created: 0, updated: [] };
  return {
    calls,
    async listComments() {
      return pages.flat();
    },
    async createComment() {
      calls.created += 1;
      return { id: 999 };
    },
    async updateComment({ id, body }) {
      calls.updated.push({ id, body });
      return { id };
    },
  };
}

test("updates the existing comment when the marker is on a later page", async () => {
  const forge = fakeForge([
    Array.from({ length: 100 }, (_, i) => ({ id: i, body: `chatter ${i}` })),
    Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, body: `more ${i}` })),
    [{ id: 250, body: `${MARKER}\nprevious review` }],
  ]);

  const result = await upsertComment({
    forge,
    repository: "acme/widgets",
    number: 7,
    body: "new review",
  });

  assert.equal(result.action, "updated");
  assert.equal(result.id, 250);
  assert.equal(forge.calls.created, 0, "must not post a duplicate comment");
  assert.deepEqual(forge.calls.updated, [{ id: 250, body: "new review" }]);
});

test("creates a comment when no marker exists", async () => {
  const forge = fakeForge([[{ id: 1, body: "unrelated" }]]);

  const result = await upsertComment({
    forge,
    repository: "acme/widgets",
    number: 7,
    body: "first review",
  });

  assert.equal(result.action, "created");
  assert.equal(forge.calls.created, 1);
  assert.equal(forge.calls.updated.length, 0);
});

test("tolerates comments with no body", async () => {
  const forge = fakeForge([[{ id: 1 }, { id: 2, body: null }]]);
  const result = await upsertComment({
    forge,
    repository: "acme/widgets",
    number: 7,
    body: "review",
  });
  assert.equal(result.action, "created");
});
