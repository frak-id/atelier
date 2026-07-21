# Atelier - dev-browser image
# Extends dev-base with a browser-accessible desktop: Chromium, KasmVNC, and
# Openbox. This is the base for sandboxes that run the process-only `browser`
# toolbox (kasmvnc + openbox + chromium) — those binaries live here, NOT in
# dev-base, so the common (browserless) sandbox stays lean.
#
# Build: docker build -t atelier/dev-browser .
# Requires: atelier/dev-base image to be built first.

FROM atelier/dev-base:latest

ARG KASMVNC_VERSION=1.4.0
ENV DEBIAN_FRONTEND=noninteractive

USER root

# Browser stack packages: chromium (the browser the desktop serves), openbox
# (a minimal window manager), libegl1 (GL for chromium), and fonts-liberation
# (so pages render with sane default fonts).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    openbox \
    libegl1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian \
    && rm -rf /var/cache/apt

# KasmVNC — the browser-accessible VNC server the `browser` toolbox exposes.
RUN curl -fsSL -o /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb" \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Openbox config: maximize + undecorate every window (single-app kiosk feel).
COPY rootfs/etc/xdg/openbox/ /etc/xdg/openbox/

USER dev
CMD ["/bin/bash"]
