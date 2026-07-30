// Validation sandbox.
//
// Validation exists to run a dependency update's own build and test commands,
// which means executing code written by whoever published that dependency. It
// therefore runs in a sibling container rather than as a child process of this
// action. That boundary is what makes the isolation real: a child process shares
// this process's PID namespace and can read `/proc/<pid>/cmdline` and, when it
// runs as the same user, `/proc/<pid>/environ` — recovering secrets no matter how
// carefully its own environment was scrubbed. A separate container gets its own
// PID namespace, so this process is simply not visible from inside it.
//
// What this does NOT provide is exfiltration prevention. Installing dependencies
// requires network access, so the default network policy is permissive and a
// malicious package can still reach the internet. The guarantee is that it
// reaches the internet without credentials, and without a route back to the host.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const MANAGED_LABEL = "bumptriage.managed=true";
export const RUN_ID_LABEL = "bumptriage.run-id";

// Pinned by digest so the snapshot step cannot be swapped underneath us.
export const DEFAULT_EXTRACTION_IMAGE =
  "busybox@sha256:f85340bf132ae937d2c2a763b8335c9bab35d6e8293f70f606b9c6178d84f42b";

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_MEMORY = /^\d+(?:[bkmg])?$/i;

/** Names reach the Docker CLI as arguments; keep them to a conservative charset. */
export function assertSafeName(value, label) {
  if (!SAFE_NAME.test(String(value ?? ""))) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Build the argument vector for one validation container.
 *
 * Pure and separately exported so the flag set can be asserted in tests without
 * a Docker daemon. Two invariants are covered by tests and must never regress:
 * the arguments never contain `--privileged`, and they never mount the Docker
 * socket. Either would hand a validation command control of the host daemon.
 */
export function buildDockerRunArgs({
  name,
  volumeName,
  image,
  network = "bridge",
  memory = "2g",
  cpus = "2",
  pidsLimit = 512,
  uid,
  gid,
  runId,
  command,
}) {
  assertSafeName(name, "container name");
  assertSafeName(volumeName, "volume name");
  assertSafeName(runId, "run id");

  if (!["none", "bridge"].includes(network)) {
    throw new Error(`Unsupported network mode ${JSON.stringify(network)}.`);
  }
  if (!SAFE_MEMORY.test(String(memory))) {
    throw new Error(`Unsupported memory limit ${JSON.stringify(memory)}.`);
  }
  if (!(Number(cpus) > 0)) {
    throw new Error(`Unsupported cpu limit ${JSON.stringify(cpus)}.`);
  }
  if (!Number.isInteger(pidsLimit) || pidsLimit <= 0) {
    throw new Error(`Unsupported pids limit ${JSON.stringify(pidsLimit)}.`);
  }
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error("uid and gid must be non-negative integers.");
  }
  if (typeof image !== "string" || image.trim() === "") {
    throw new Error("A validation image is required.");
  }
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("A validation command is required.");
  }

  return [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    MANAGED_LABEL,
    "--label",
    `${RUN_ID_LABEL}=${runId}`,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,size=2g",
    "--user",
    `${uid}:${gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    String(pidsLimit),
    "--memory",
    String(memory),
    // Matching swap to memory disables swap entirely, so the limit is real.
    "--memory-swap",
    String(memory),
    "--cpus",
    String(cpus),
    "-v",
    `${volumeName}:/workspace`,
    "-w",
    "/workspace",
    "-e",
    "CI=true",
    // The root filesystem is read-only, so anything that writes to a home or
    // cache directory has to be redirected into the tmpfs.
    "-e",
    "HOME=/tmp",
    "-e",
    "npm_config_cache=/tmp/.npm",
    "-e",
    "GOCACHE=/tmp/go-build",
    "-e",
    "GOMODCACHE=/tmp/go-mod",
    "-e",
    "XDG_CACHE_HOME=/tmp/.cache",
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    command,
  ];
}

function runProcess(file, args, { spawnImpl = nodeSpawn, input, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        onSpawn?.timeout?.();
      }, timeoutMs);
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input !== undefined && child.stdin) {
      if (typeof input.pipe === "function") input.pipe(child.stdin);
      else {
        child.stdin.end(input);
      }
    }
  });
}

/**
 * Create a Docker volume holding an exact snapshot of the head commit.
 *
 * `git archive` piped into a container avoids translating a path from inside
 * this container to a path on the host, which is not generally possible: the
 * workspace path a container action sees need not exist on the host at all. It
 * also yields a clean tree — no `.git`, no untracked files, nothing the runner
 * left behind.
 *
 * A freshly created volume is owned by root, so the extraction step runs as root
 * and hands ownership to the unprivileged validation user afterwards. Without
 * that chown, every validation command fails on its first write.
 */
export async function createSnapshotVolume({
  repositoryPath,
  headSha,
  uid,
  gid,
  runId,
  extractionImage = DEFAULT_EXTRACTION_IMAGE,
  spawnImpl = nodeSpawn,
}) {
  const volumeName = `bumptriage-${runId}`;
  assertSafeName(volumeName, "volume name");

  const created = await runProcess(
    "docker",
    [
      "volume",
      "create",
      "--label",
      MANAGED_LABEL,
      "--label",
      `${RUN_ID_LABEL}=${runId}`,
      volumeName,
    ],
    { spawnImpl },
  );
  if (created.code !== 0) {
    throw new Error(`Could not create the validation volume: ${created.stderr.trim()}`);
  }

  const archive = spawnImpl(
    "git",
    ["-C", repositoryPath, "-c", "safe.directory=*", "archive", "--format=tar", headSha],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const extracted = await runProcess(
    "docker",
    [
      "run",
      "-i",
      "--rm",
      "--network=none",
      "--user",
      "0:0",
      "-v",
      `${volumeName}:/workspace`,
      extractionImage,
      "sh",
      "-c",
      `tar -x -C /workspace && chown -R ${uid}:${gid} /workspace`,
    ],
    { spawnImpl, input: archive.stdout },
  );

  if (extracted.code !== 0) {
    await removeVolume(volumeName, { spawnImpl });
    throw new Error(
      `Could not populate the validation volume: ${extracted.stderr.trim() || "unknown error"}`,
    );
  }

  return volumeName;
}

export async function removeVolume(volumeName, { spawnImpl = nodeSpawn } = {}) {
  try {
    await runProcess("docker", ["volume", "rm", "-f", volumeName], { spawnImpl });
  } catch {
    // Best effort; a leaked volume is preferable to masking the real failure.
  }
}

/**
 * Remove containers and volumes left behind by earlier runs.
 *
 * The in-process signal handler covers cancellation, but nothing runs on
 * SIGKILL or when the runner dies outright, so labelled resources are swept at
 * startup as a backstop.
 */
export async function pruneStaleResources({ spawnImpl = nodeSpawn, olderThan = "1h" } = {}) {
  const filters = ["--filter", `label=${MANAGED_LABEL}`, "--filter", `until=${olderThan}`];
  try {
    await runProcess("docker", ["container", "prune", "-f", ...filters], { spawnImpl });
    await runProcess("docker", ["volume", "prune", "-f", "--filter", `label=${MANAGED_LABEL}`], {
      spawnImpl,
    });
  } catch {
    // Docker may be unavailable; the caller reports that separately.
  }
}

/**
 * Run every configured validation command against one snapshot volume.
 *
 * Commands share the volume in order, so an install step's output is visible to
 * a later test step. A non-zero exit is evidence, not an error: the agent is
 * told what failed and decides what it means. Only an infrastructure failure —
 * one that leaves no snapshot to review — aborts the run.
 */
export async function runValidations({
  repositoryPath,
  headSha,
  commands,
  image,
  network,
  memory,
  cpus,
  pidsLimit,
  timeoutSeconds,
  totalTimeoutSeconds,
  uid = 65534,
  gid = 65534,
  spawnImpl = nodeSpawn,
  now = () => Date.now(),
}) {
  if (commands.length === 0) return { results: [], volumeName: null };

  const runId = randomUUID().replaceAll("-", "").slice(0, 24);
  const tracked = new Set();
  const volumeName = await createSnapshotVolume({
    repositoryPath,
    headSha,
    uid,
    gid,
    runId,
    spawnImpl,
  });

  const cleanup = async () => {
    for (const name of tracked) {
      await runProcess("docker", ["rm", "-f", name], { spawnImpl }).catch(() => {});
    }
    await removeVolume(volumeName, { spawnImpl });
  };

  const onSignal = () => {
    cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const results = [];
  const deadline = now() + totalTimeoutSeconds * 1000;

  try {
    for (const [index, command] of commands.entries()) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        results.push({
          command,
          image,
          network,
          exitCode: null,
          timedOut: true,
          durationMs: 0,
          output: "Skipped: the total validation time budget was exhausted.",
        });
        continue;
      }

      const name = `bumptriage-${runId}-${index}`;
      const args = buildDockerRunArgs({
        name,
        volumeName,
        image,
        network,
        memory,
        cpus,
        pidsLimit,
        uid,
        gid,
        runId,
        command,
      });

      tracked.add(name);
      const startedAt = now();
      const timeoutMs = Math.min(timeoutSeconds * 1000, remaining);

      const outcome = await runProcess("docker", args, {
        spawnImpl,
        timeoutMs,
        onSpawn: {
          timeout: () => {
            runProcess("docker", ["kill", name], { spawnImpl })
              .then(() => runProcess("docker", ["rm", "-f", name], { spawnImpl }))
              .catch(() => {});
          },
        },
      });
      tracked.delete(name);

      results.push({
        command,
        image,
        network,
        exitCode: outcome.timedOut ? null : outcome.code,
        timedOut: outcome.timedOut,
        durationMs: now() - startedAt,
        output: annotate(`${outcome.stdout}${outcome.stderr}`, network, outcome),
      });
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }

  return { results, volumeName };
}

const NETWORK_FAILURE_HINTS = [
  /EAI_AGAIN/i,
  /getaddrinfo/i,
  /Temporary failure in name resolution/i,
  /could not resolve host/i,
  /network is unreachable/i,
  /dial tcp .*: connect/i,
];

/**
 * Append a hint when a command fails in a way that looks like the network policy
 * rather than the dependency update. Running with `network: none` and then
 * seeing an install fail on DNS is the most likely first-run confusion.
 */
function annotate(output, network, outcome) {
  const text = String(output ?? "");
  if (network !== "none" || outcome.code === 0) return text;
  if (!NETWORK_FAILURE_HINTS.some((pattern) => pattern.test(text))) return text;
  return `${text}\n[bumptriage] This command failed while the sandbox had no network access. If it needs to download dependencies, set validation-network to "bridge".`;
}
