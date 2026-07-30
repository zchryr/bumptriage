import test from "node:test";
import assert from "node:assert/strict";

import { buildDockerRunArgs, assertSafeName } from "./sandbox.mjs";

const base = {
  name: "bumptriage-abc-0",
  volumeName: "bumptriage-abc",
  image: "node:24-bookworm-slim",
  memory: "2g",
  cpus: "2",
  pidsLimit: 512,
  uid: 65534,
  gid: 65534,
  runId: "abc",
  command: "npm test",
};

test("produces the expected hardened flag set", () => {
  const args = buildDockerRunArgs({ ...base, network: "none" });

  for (const flag of [
    "--rm",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
  ]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }

  assert.deepEqual(args.slice(-3), [base.image, "-c", "npm test"]);
  assert.equal(args[args.indexOf("--user") + 1], "65534:65534");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "512");
  assert.equal(args[args.indexOf("-v") + 1], "bumptriage-abc:/workspace");

  // Matching swap to memory is what makes the memory limit real.
  assert.equal(args[args.indexOf("--memory") + 1], "2g");
  assert.equal(args[args.indexOf("--memory-swap") + 1], "2g");
});

test("network mode is the only difference between bridge and none", () => {
  const strip = (args) => {
    const copy = [...args];
    copy.splice(copy.indexOf("--network"), 2);
    return copy;
  };

  assert.deepEqual(
    strip(buildDockerRunArgs({ ...base, network: "none" })),
    strip(buildDockerRunArgs({ ...base, network: "bridge" })),
    "toggling the network policy must not change any hardening flag",
  );
});

test("never grants privileges or access to the host docker socket", () => {
  const commands = [
    "npm test",
    "sh -c 'echo hi'",
    "npm ci --ignore-scripts",
    "$(echo pwned)",
    "a; docker run --privileged busybox",
  ];

  for (const network of ["none", "bridge"]) {
    for (const command of commands) {
      const args = buildDockerRunArgs({ ...base, network, command });
      const flags = args.slice(0, args.indexOf(base.image));

      assert.ok(!flags.includes("--privileged"), "must never pass --privileged");
      assert.ok(
        !flags.some((arg) => String(arg).includes("/var/run/docker.sock")),
        "must never mount the docker socket",
      );
      assert.ok(
        !flags.some((arg) => String(arg).includes("docker.sock")),
        "must never reference the docker socket",
      );
    }
  }
});

test("passes the command as a single argument so it cannot leak into flags", () => {
  const command = "npm test --reporter=json && echo done";
  const args = buildDockerRunArgs({ ...base, command });
  assert.equal(args.at(-1), command);
  assert.equal(args.filter((arg) => arg === command).length, 1);
});

test("rejects unsafe container and volume names", () => {
  assert.throws(() => buildDockerRunArgs({ ...base, name: "a b" }), /Unsafe container name/);
  assert.throws(
    () => buildDockerRunArgs({ ...base, volumeName: "../escape" }),
    /Unsafe volume name/,
  );
  assert.throws(() => buildDockerRunArgs({ ...base, runId: "x;y" }), /Unsafe run id/);
  assert.throws(() => assertSafeName("-leading", "name"), /Unsafe name/);
});

test("rejects malformed resource limits before reaching docker", () => {
  assert.throws(() => buildDockerRunArgs({ ...base, memory: "2 gigabytes" }), /memory limit/);
  assert.throws(() => buildDockerRunArgs({ ...base, cpus: "0" }), /cpu limit/);
  assert.throws(() => buildDockerRunArgs({ ...base, cpus: "-1" }), /cpu limit/);
  assert.throws(() => buildDockerRunArgs({ ...base, pidsLimit: 0 }), /pids limit/);
  assert.throws(() => buildDockerRunArgs({ ...base, pidsLimit: 1.5 }), /pids limit/);
  assert.throws(() => buildDockerRunArgs({ ...base, uid: -1 }), /non-negative integers/);
});

test("rejects an unsupported network mode", () => {
  assert.throws(() => buildDockerRunArgs({ ...base, network: "host" }), /Unsupported network/);
});

test("rejects an empty image or command", () => {
  assert.throws(() => buildDockerRunArgs({ ...base, image: "  " }), /image is required/);
  assert.throws(() => buildDockerRunArgs({ ...base, command: "" }), /command is required/);
});
