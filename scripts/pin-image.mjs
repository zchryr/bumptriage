#!/usr/bin/env node
// Rewrites action.yml to run a specific published image instead of building
// from source.
//
// On the default branch, action.yml says `image: Dockerfile`, so a fork or a
// contributor testing a change runs their own code with no registry involved.
// Release automation calls this to pin a digest, so consumers of a release tag
// pull one immutable, attested image rather than rebuilding it on every run.
//
// Usage: node scripts/pin-image.mjs <image-reference>
//        node scripts/pin-image.mjs --unpin

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const actionFile = path.join(import.meta.dirname, "..", "action.yml");
const reference = process.argv[2];

if (!reference) {
  console.error("Usage: node scripts/pin-image.mjs <image-reference>|--unpin");
  process.exit(2);
}

const contents = await readFile(actionFile, "utf8");
const imageLine = /^(\s*)image:\s*.+$/m;

if (!imageLine.test(contents)) {
  console.error("Could not find an `image:` line in action.yml.");
  process.exit(1);
}

let replacement;
if (reference === "--unpin") {
  replacement = "Dockerfile";
} else {
  // A tag is mutable: whoever can push to the registry can change what it
  // points at. A digest is content-addressed, so pinning one means a consumer
  // who trusts a release tag transitively gets exactly the image that tag was
  // built from.
  if (!/^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/.test(reference)) {
    console.error(
      `Refusing to pin ${JSON.stringify(reference)}: expected ` +
        "docker://<registry>/<image>@sha256:<64 hex chars>.",
    );
    process.exit(1);
  }
  replacement = reference;
}

const updated = contents.replace(imageLine, `$1image: ${replacement}`);
await writeFile(actionFile, updated);

console.log(`action.yml now uses: ${replacement}`);
