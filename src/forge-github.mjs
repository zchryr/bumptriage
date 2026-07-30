// GitHub REST implementation of the forge interface.

const API_VERSION = "2022-11-28";
const PER_PAGE = 100;
const MAX_PAGES = 100;

export function createGitHubForge({ apiUrl, token, fetchImpl = fetch }) {
  // GitHub serves its API from api.github.com, not from the web host, and
  // GitHub Enterprise Server serves it from <host>/api/v3. Deriving it from the
  // server URL — which works on forges that colocate the two — would silently
  // send every request to the wrong place.
  const base = String(apiUrl || "https://api.github.com").replace(/\/+$/, "");

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function request(pathname, init = {}) {
    const response = await fetchImpl(`${base}${pathname}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub ${init.method ?? "GET"} ${pathname} failed: HTTP ${response.status}`,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    kind: "github",

    async getPullRequest({ repository, number }) {
      return request(`/repos/${repository}/pulls/${number}`);
    },

    // GitHub accepts any username alongside a token in HTTP basic auth; this is
    // the conventional placeholder, so no extra API round trip is needed.
    async authenticatedUsername() {
      return "x-access-token";
    },

    async listComments({ repository, number }) {
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = await request(
          `/repos/${repository}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
        );
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < PER_PAGE) break;
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
