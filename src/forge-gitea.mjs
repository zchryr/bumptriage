// Gitea implementation of the forge interface.
//
// Gitea's API is close enough to GitHub's to share the interface, but differs in
// three ways that matter here: the authorization scheme (`token <t>` rather than
// `Bearer <t>`), the pagination parameter (`limit` rather than `per_page`), and
// the fact that the API is served from the same host as the web UI.

const DEFAULT_LIMIT = 50;
const MAX_PAGES = 100;

export function createGiteaForge({ serverUrl, apiUrl, token, fetchImpl = fetch }) {
  const base = `${String(apiUrl || serverUrl || "").replace(/\/+$/, "")}/api/v1`;

  const headers = token ? { Authorization: `token ${token}` } : {};

  async function request(pathname, init = {}) {
    const response = await fetchImpl(`${base}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(
        `Gitea ${init.method ?? "GET"} ${pathname} failed: HTTP ${response.status}`,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    kind: "gitea",

    async getPullRequest({ repository, number }) {
      return request(`/repos/${repository}/pulls/${number}`);
    },

    async authenticatedUsername() {
      const user = await request("/user");
      const username = user?.login ?? user?.username;
      if (!username) throw new Error("The Gitea user response contains no username.");
      return username;
    },

    async listComments({ repository, number }) {
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await request(
          `/repos/${repository}/issues/${number}/comments?limit=${DEFAULT_LIMIT}&page=${page}`,
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < DEFAULT_LIMIT) break;
      }
      return all;
    },

    async createComment({ repository, number, body }) {
      return request(`/repos/${repository}/issues/${number}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async updateComment({ repository, id, body }) {
      return request(`/repos/${repository}/issues/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
  };
}
