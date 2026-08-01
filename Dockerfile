# The Agent SDK is a thin wrapper around a ~240MB native CLI binary that it
# resolves from an OS/arch-gated optional dependency and spawns as a subprocess.
# That rules out bundling this as a JavaScript action, so it ships as a container
# action with the dependency installed normally. That binary is the floor on this
# image's size; everything else here is kept lean around it.

# Base images are pinned by digest, not tag, so a rebuild produces the same
# thing and a moved tag cannot change what is published. Dependabot keeps them
# current; see .github/dependabot.yml.
FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli

# Dependencies are installed in a separate stage so npm's cache — around 130MB,
# and useless at runtime — never becomes a layer in the published image.
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS deps
WORKDIR /action
# `npm ci` installs exactly what the lockfile records, with integrity hashes,
# rather than re-resolving versions at build time.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Used to drive sibling containers for validation in the single-job setup. No
# language toolchains are installed: validation runs in its own image, chosen by
# the caller, so this image does not have to guess which languages a repository
# needs.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /action

COPY --from=deps /action/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src

ENTRYPOINT ["node", "/action/src/action.mjs"]
