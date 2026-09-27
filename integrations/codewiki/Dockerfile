# --------------------------------------------------------------------------
# codewiki-sync — CodeWiki-generated docs -> Onyx ingestion, run as a
# Kubernetes CronJob (see k8s/).
#
# Two runtimes, one image:
#   - the sync job itself is a self-contained Bun bundle (bun build --target
#     bun), so the runtime image needs no node_modules;
#   - it shells out to `codewiki`, a Python CLI, for the actual doc
#     generation.
#
# Build (context = repo root, so the bundler stage can see the whole
# workspace graph — same reasoning as the root Dockerfile):
#   docker build -f integrations/codewiki/Dockerfile -t atelier-codewiki-sync .
# --------------------------------------------------------------------------

# ── Stage 1: bundle the sync job into a single file ────────────────────────
FROM oven/bun:1 AS bundler

WORKDIR /build

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/spec/package.json packages/spec/
COPY packages/compose/package.json packages/compose/
COPY apps/server/package.json apps/server/
COPY apps/console/package.json apps/console/
COPY apps/cli/package.json apps/cli/
COPY integrations/codewiki/package.json integrations/codewiki/

RUN bun install --frozen-lockfile

COPY integrations/codewiki/src integrations/codewiki/src
COPY integrations/codewiki/tsconfig.json integrations/codewiki/
COPY tsconfig.json ./

RUN bun build integrations/codewiki/src/index.ts \
      --target=bun \
      --outfile=/build/dist/codewiki-sync.js \
      --minify

# ── Stage 2: runtime (Python for CodeWiki + the bundled Bun script) ────────
FROM python:3.12-slim AS runtime

# git: CodeWiki needs it to read the current commit / diff for --update;
# the sync job needs it for its own shallow clones (git.ts shells out to the
# system `git`, not a Bun binding). ca-certificates: TLS to GitHub, the
# cliproxy LLM endpoint and Onyx.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# CodeWiki pinned to a specific commit of FSoft-AI4Code/CodeWiki main — the
# "codewiki" package on PyPI is an unrelated project, so this always
# installs from git, never `pip install codewiki`. Commit picked 2026-09-28
# (merge of "updater: stop whole-repository --update from looping"); re-pin
# deliberately, don't float on @main.
ARG CODEWIKI_COMMIT=a966b4cdac2b89a60002eb1a4849c67d247bdb75
RUN pip install --no-cache-dir \
      "git+https://github.com/FSoft-AI4Code/CodeWiki.git@${CODEWIKI_COMMIT}"

# The bun binary only (no node_modules — the sync script below is a single
# bundled file with no external deps).
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

COPY --from=bundler /build/dist/codewiki-sync.js /app/codewiki-sync.js

# Non-root: DATA_DIR (the PVC mount) must be writable by this uid via
# fsGroup/securityContext in k8s/20-cronjob.yaml, not by chowning here (the
# image doesn't know the PVC's mount path is /data until the Pod spec says
# so, and we want the same image usable with any DATA_DIR).
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin codewiki
USER codewiki

ENV DATA_DIR=/data \
    PYTHONUNBUFFERED=1

ENTRYPOINT ["bun", "/app/codewiki-sync.js"]
