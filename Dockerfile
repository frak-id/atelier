# --------------------------------------------------------------------------
# Atelier — multi-stage, multi-target Docker build
#
# Produces TWO images from one Dockerfile:
#
#   server   — Bun API server, apps/server        (ghcr.io/frak-id/atelier-server)
#   console  — nginx serving apps/console SPA +    (ghcr.io/frak-id/atelier-console)
#              reverse-proxying to the server
#
# Build:
#   docker build --target server  -t atelier-server  .
#   docker build --target console -t atelier-console .
# --------------------------------------------------------------------------

# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /build

# Workspace root + every workspace member's package.json. bun's frozen install
# validates the whole workspace graph (root `workspaces: [packages/*, apps/*]`),
# so ALL members must be present or the lockfile is considered out of sync
# — even the ones whose source this image never builds (e.g. apps/cli).
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/spec/package.json packages/spec/
COPY packages/compose/package.json packages/compose/
COPY apps/server/package.json apps/server/
COPY apps/console/package.json apps/console/
COPY apps/cli/package.json apps/cli/

RUN bun install --frozen-lockfile

# ── Stage 2: build server + console ───────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /build

# Installed node_modules from the deps stage (root + per-workspace symlinks)
COPY --from=deps /build/node_modules node_modules
COPY --from=deps /build/packages/shared/node_modules packages/shared/node_modules
COPY --from=deps /build/packages/spec/node_modules packages/spec/node_modules
COPY --from=deps /build/packages/compose/node_modules packages/compose/node_modules
COPY --from=deps /build/apps/server/node_modules apps/server/node_modules
COPY --from=deps /build/apps/console/node_modules apps/console/node_modules

# Source
COPY packages/shared packages/shared
COPY packages/spec packages/spec
COPY packages/compose packages/compose
COPY apps/server apps/server
COPY apps/console apps/console
COPY tsconfig.json ./

# Build server → single-file Bun bundle (workspace deps inlined; bun:sqlite is
# native to the Bun runtime, so no node_modules needed at runtime).
RUN bun build apps/server/src/index.ts \
      --target=bun \
      --outfile=dist/server.js \
      --minify

# Build console → static SPA. vite build only (typecheck is a CI gate, not a
# packaging step); @atelier/server stays external per the vite rollup config.
RUN cd apps/console && bunx vite build

# ── Target: server ────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS server

# git + CA certs for any git ls-remote staleness checks / TLS to registries.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Server bundle
COPY --from=builder /build/dist/server.js ./server.js

# Drizzle migrations (applied at boot via MIGRATIONS_DIR)
COPY apps/server/drizzle ./drizzle

# Embedded base-image seeds (image.json + Dockerfile + rootfs for dev-base/
# dev-cloud/dev-rust, and the agent seed's image.json). `bun build` inlines TS
# but never these data files, so they're copied verbatim and located at runtime
# via ATELIER_SEEDS_DIR.
COPY apps/server/src/runtime/registry/seeds ./seeds

# The sandbox-agent seed keeps its Rust source in apps/agent-v2 (single source
# of truth); only its image.json is committed under seeds/. Copy the build
# context in here so the deployed server can build it as a seed (in dev the
# loader falls back to apps/agent-v2 directly via `contextFrom`).
COPY apps/agent-v2/Dockerfile apps/agent-v2/Cargo.toml apps/agent-v2/Cargo.lock \
     ./seeds/sandbox-agent-v2/
COPY apps/agent-v2/src ./seeds/sandbox-agent-v2/src

ENV NODE_ENV=production \
    ATELIER_SERVER_MODE=production \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/drizzle \
    ATELIER_SEEDS_DIR=/app/seeds

# SQLite data directory (mount a PVC here in k8s to persist)
RUN mkdir -p /app/data

EXPOSE 4000

CMD ["bun", "server.js"]

# ── Target: console (nginx sidecar) ───────────────────────────────────────
FROM nginx:alpine AS console

# Pod runs as UID 1000 (non-root). Pre-create writable dirs for nginx and
# redirect the PID file to /tmp (K8s mounts /run as root-owned tmpfs).
RUN mkdir -p /var/cache/nginx /tmp && \
    chown -R 1000:1000 /var/cache/nginx && \
    sed -i 's|/run/nginx.pid|/tmp/nginx.pid|g' /etc/nginx/nginx.conf

RUN rm /etc/nginx/conf.d/default.conf

# Console nginx config (SPA serving + reverse proxy to the v2 server)
COPY infra/nginx/console.conf /etc/nginx/conf.d/default.conf

# Console static files
COPY --from=builder /build/apps/console/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
