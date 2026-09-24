# Open-Inspect sandbox image for Atelier: dev-base plus the Open-Inspect
# sandbox runtime, installed by Open-Inspect's own image tooling for its
# `atelier` target (runtime user `dev`, home `/home/dev`). Built by the Atelier
# server as the `open-inspect` seed; the provider boots sessions from it.

# ── Open-Inspect install bundle (pinned revision + Atelier provider patch) ──
FROM python:3.12-slim-bookworm AS bundle
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
COPY upstream.env atelier-provider.patch checkout.sh /tmp/open-inspect/
RUN bash /tmp/open-inspect/checkout.sh /src \
    && mv "$(python3 /src/packages/sandbox-images/cli.py pack \
        --provider atelier --root /src --output /tmp/pack)" /bundle

# ── The image ───────────────────────────────────────────────────────────────
FROM atelier/dev-base:latest
USER root
COPY --from=bundle /bundle /tmp/open-inspect
# dev-base keeps the image's home at /home/skel (the read-only overlay lower
# mounted at /home/dev on boot), so install at the runtime path, then move it
# back. Only /home/dev survives pause/resume: /workspace (hardcoded by the
# runtime) is a symlink into it.
RUN rmdir /home/dev && mv /home/skel /home/dev \
    && bash /tmp/open-inspect/packages/sandbox-images/install/install.sh \
    && rm -rf /workspace \
    && install -d -o dev -g dev /home/dev/workspace \
    && ln -s /home/dev/workspace /workspace \
    && mv /home/dev /home/skel \
    && install -d -o dev -g dev /home/dev \
    && rm -rf /tmp/open-inspect /var/lib/apt/lists/*
USER dev
CMD ["/bin/bash"]
