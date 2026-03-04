# --------------------------------------------------------------------------
# Atelier — multi-stage, multi-target Docker build
#
# Produces TWO images from one Dockerfile:
#
#   manager    — Bun API server (ghcr.io/frak-id/atelier-manager)
#   dashboard  — nginx serving the React SPA + reverse-proxying to manager
#                (ghcr.io/frak-id/atelier-dashboard)
#
# Build:
#   docker build --target manager   -t atelier-manager   .
#   docker build --target dashboard -t atelier-dashboard  .
# --------------------------------------------------------------------------

# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /build

# Copy workspace root files needed for dependency resolution
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/manager/package.json apps/manager/
COPY apps/dashboard/package.json apps/dashboard/

RUN bun install --frozen-lockfile

# ── Stage 2: build manager + dashboard ────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /build

# Copy installed node_modules from deps stage
COPY --from=deps /build/node_modules node_modules
COPY --from=deps /build/packages/shared/node_modules packages/shared/node_modules
COPY --from=deps /build/apps/manager/node_modules apps/manager/node_modules
COPY --from=deps /build/apps/dashboard/node_modules apps/dashboard/node_modules

# Copy source
COPY packages/shared packages/shared
COPY apps/manager apps/manager
COPY apps/dashboard apps/dashboard
COPY tsconfig.json ./

# Build manager → single-file bundle
RUN bun build apps/manager/src/index.ts \
      --target=bun \
      --outfile=dist/server.js \
      --minify

# Build dashboard → static files
RUN cd apps/dashboard && bun run build

# ── Target: manager ──────────────────────────────────────────────────────
FROM oven/bun:1-slim AS manager

WORKDIR /app

# Manager bundle
COPY --from=builder /build/dist/server.js ./server.js

# Drizzle migrations
COPY apps/manager/drizzle ./drizzle

# Base image definitions (image.json + Dockerfile for dev-base, dev-cloud)
COPY infra/images ./images

# Pre-compiled sandbox-agent binary (Rust, static-linked, ~1.4MB)
# Served via /internal/agent-binary for Kaniko base image builds
COPY apps/agent-rust/dist/sandbox-agent ./agent-binary/sandbox-agent

# Runtime environment
ENV NODE_ENV=production \
    ATELIER_SERVER_MODE=production \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/drizzle \
    ATELIER_IMAGES_DIR=/app/images

# Data directory for SQLite database
RUN mkdir -p /app/data

EXPOSE 4000

CMD ["bun", "server.js"]

# ── Target: dashboard (nginx sidecar) ────────────────────────────────────
FROM nginx:alpine AS dashboard


RUN rm /etc/nginx/conf.d/default.conf

# Atelier nginx config (SPA serving + reverse proxy to manager)
COPY infra/nginx/nginx.conf /etc/nginx/conf.d/default.conf

# Dashboard static files
COPY --from=builder /build/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
