// Forge factory. The API surface bumptriage needs is deliberately tiny: read one
// pull request, list its comments, and create or update one of them.

import { createGitHubForge } from "./forge-github.mjs";
import { createGiteaForge } from "./forge-gitea.mjs";

export function createForge({ kind, serverUrl, apiUrl, token, fetchImpl = fetch }) {
  switch (kind) {
    case "github":
      return createGitHubForge({ apiUrl, token, fetchImpl });
    case "gitea":
      return createGiteaForge({ serverUrl, apiUrl, token, fetchImpl });
    default:
      throw new Error(`Unknown forge ${JSON.stringify(kind)}.`);
  }
}
