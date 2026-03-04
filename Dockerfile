# --------------------------------------------------------------------------
# Atelier Manager — multi-stage Docker build
#
# Produces a single container that runs the manager API and serves the
# dashboard SPA.  Published to ghcr.io/frak-id/atelier-manager.
#
# Build:  docker build -t atelier-manager .
# Run:    docker run -p 4000:4000 atelier-manager
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

# ── Stage 3: production runtime ──────────────────────────────────────────
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Manager bundle
COPY --from=builder /build/dist/server.js ./server.js

# Dashboard static files (served by Elysia static plugin at /)
COPY --from=builder /build/apps/dashboard/dist ./public

# Drizzle migrations
COPY apps/manager/drizzle ./drizzle

# Base image definitions (image.json + Dockerfile for dev-base, dev-cloud)
COPY infra/images ./images

# Runtime environment
ENV NODE_ENV=production \
    ATELIER_SERVER_MODE=production \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/drizzle \
    DASHBOARD_DIR=./public \
    ATELIER_IMAGES_DIR=/app/images

# Data directory for SQLite database
RUN mkdir -p /app/data

EXPOSE 4000

CMD ["bun", "server.js"]
