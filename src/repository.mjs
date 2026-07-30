// Locating, fetching, and diffing the repository under review.

import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Run git and return stdout and stderr separately.
 *
 * Keeping them apart matters: callers parse stdout into structured data such as
 * the changed-file list, and git writes advisory notices to stderr. Merging the
 * two turns a harmless warning into a phantom filename.
 */
export async function git(cwd, args, { execFileImpl = execFileAsync } = {}) {
  const { stdout, stderr } = await execFileImpl(
    "git",
    ["-c", "safe.directory=*", ...args],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

/** Candidate workspace locations, in order of preference. */
export function workspaceCandidates(env = process.env) {
  return [env.GITHUB_WORKSPACE, env.GITEA_WORKSPACE, "/github/workspace", process.cwd()]
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * Find an already-checked-out repository containing both commits.
 *
 * Some runners hand Docker actions a workspace path that only exists on the
 * host, so the presence of an environment variable proves nothing. Each
 * candidate is verified by asking git to resolve it, and the commits under
 * review must actually be present — a workspace holding a different repository,
 * or a shallow clone missing the base commit, is not usable and we fall through
 * to cloning instead of failing later with an opaque diff error.
 */
export async function findRepositoryPath({
  baseSha,
  headSha,
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  for (const candidate of workspaceCandidates(env)) {
    try {
      const { stdout } = await execFileImpl(
        "git",
        ["-C", candidate, "-c", "safe.directory=*", "rev-parse", "--show-toplevel"],
        { maxBuffer: 1024 * 1024 },
      );
      const root = path.resolve(stdout.trim());

      for (const sha of [baseSha, headSha].filter(Boolean)) {
        await execFileImpl(
          "git",
          ["-C", root, "-c", "safe.directory=*", "cat-file", "-e", `${sha}^{commit}`],
          { maxBuffer: 1024 * 1024 },
        );
      }

      return root;
    } catch {
      // Not a usable checkout; try the next candidate.
    }
  }

  return null;
}

/**
 * Clone the repository into a temporary directory.
 *
 * The token is passed through `http.extraHeader` in the environment rather than
 * embedded in the remote URL, so it never lands in `.git/config`, in the
 * reflog, or in an error message echoing the remote.
 */
export async function checkoutRepository({
  serverUrl,
  repository,
  token,
  username,
  baseSha,
  headSha,
  execFileImpl = execFileAsync,
}) {
  if (!token) throw new Error("A forge token is required to check out the repository.");

  const directory = await mkdtemp(path.join(tmpdir(), "bumptriage-repo-"));
  const authorization = Buffer.from(`${username}:${token}`).toString("base64");
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    GIT_TERMINAL_PROMPT: "0",
  };

  const run = (args) =>
    execFileImpl("git", args, { cwd: directory, env, maxBuffer: MAX_BUFFER });

  await run(["init", "--quiet"]);
  await run(["remote", "add", "origin", `${serverUrl}/${repository}.git`]);
  await run(["fetch", "--depth=1", "origin", baseSha, headSha]);
  await run(["checkout", "--detach", headSha]);

  return directory;
}

/** Compute the diff and changed-file list between two commits. */
export async function diffBetween(repositoryPath, baseSha, headSha, options = {}) {
  const [diff, names] = await Promise.all([
    git(repositoryPath, ["diff", "--find-renames", `${baseSha}..${headSha}`], options),
    git(repositoryPath, ["diff", "--name-only", `${baseSha}..${headSha}`], options),
  ]);
  return { diff: diff.stdout, changedFiles: names.stdout };
}
