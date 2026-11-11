# Atelier - dev-base image
# Minimal development environment with Bun and Git. No agent harness is baked
# in: opencode, pi and tools like code-server come from toolboxes, whose
# toolset artifacts materialize into ~/.local
# (docs/archive/proposals/composed-prebuild-volumes.md), not /opt/shared.
#
# Build: docker build -t atelier/dev-base .
# Export: docker export $(docker create atelier/dev-base) | tar -C ./rootfs -xf -

# In-pod Rust agent, pulled from a prebuilt image (public GHCR by default) so a
# fresh operator never has to build it first. Override with
# `--build-arg AGENT_IMAGE=<ref>` (the server passes `sandbox.agentImage`) to
# use a private/mirrored agent — e.g. an air-gapped cluster's own registry.
ARG AGENT_IMAGE=ghcr.io/frak-id/sandbox-agent:3.0.2
FROM ${AGENT_IMAGE} AS agent

# Pin the Debian codename explicitly: dev-browser installs the KasmVNC .deb
# built for this release (it reads the codename from /etc/os-release), so a
# bump needs a KasmVNC release that ships a .deb for the new codename.
FROM node:26-trixie-slim


ARG ORAS_VERSION=1.3.6
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/dev
ENV USER=dev
ENV SHELL=/bin/bash
ENV BUN_INSTALL=/home/dev/.bun
ENV PATH=$BUN_INSTALL/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# C.UTF-8 is built into glibc and never needs locale-gen, so it works
# regardless of which locale data is generated. Avoids the noisy
# 'setlocale: LC_ALL: cannot change locale' warnings that plagued every
# bash -l in the sandbox.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# Layer 1: System packages (cached unless package list changes)
# erofs-utils (mkfs.erofs) + squashfs-tools (mksquashfs): the guest agent
# packages toolset artifacts as a read-only blob and picks whichever format
# the guest kernel can mount, preferring erofs (the CLH guest kernel here
# ships erofs+overlay+loop but NOT squashfs; a QEMU guest with CONFIG_SQUASHFS
# would use squashfs) — docs/archive/proposals/toolset-overlay-squashfs.md §3-4.
# Both mkfs tools are baked so one image works on either kernel. rsync: stages
# toolset build/capture path-sets into a scratch root before packaging.
# e2fsprogs (mkfs.ext4): the workspace PVC is attached as a raw block device;
# sandbox-boot.sh formats it ext4 and mounts it at /data on first boot
# (docs/archive/plans/toolset-inplace-update-fix-options.md §3). blkid/mountpoint come
# from util-linux and cmp (the mkfs guard's zero-probe) from diffutils — both
# Essential in Debian, so present in -slim. libnss3 (+ libnspr4): headless
# Chrome (e.g. Remotion's chrome-headless-shell) won't start without it;
# lacking it, a prebuild had to `apt-get download` + extract it into ~/.local
# and point LD_LIBRARY_PATH at it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chrony \
    curl \
    git \
    openssh-server \
    sudo \
    vim \
    jq \
    build-essential \
    python3 \
    unzip \
    xz-utils \
    procps \
    iproute2 \
    iputils-ping \
    squashfs-tools \
    erofs-utils \
    e2fsprogs \
    rsync \
    libnss3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian \
    && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} + \
    && rm -rf /var/cache/apt

# Build-time curl retries. GitHub release downloads intermittently answer 504
# from the cluster, including the ones install scripts make (bun.sh/install
# fetches its zip from GitHub), so a --retry flag alone would not cover them.
# Every curl reads $CURL_HOME/.curlrc. An ARG is set for RUN steps but not
# kept in the image's environment, so sandboxes never read this file. Seeds
# built on dev-base declare the same ARG.
ARG CURL_HOME=/etc/curl-build
RUN mkdir -p /etc/curl-build \
    && printf 'retry = 6\nretry-connrefused\n' > /etc/curl-build/.curlrc

# Layer 2: oras (OCI artifact CLI) — the guest agent shells out to it to
# push/pull toolset artifacts to/from the in-cluster zot registry
# (docs/archive/proposals/composed-prebuild-volumes.md). Static linux/amd64 binary; no runtime deps.
RUN curl -fsSL -o /tmp/oras.tar.gz "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" \
    && tar -xzf /tmp/oras.tar.gz -C /usr/local/bin oras \
    && chmod +x /usr/local/bin/oras \
    && rm -f /tmp/oras.tar.gz \
    && oras version

# Layer 3: Locale + user setup + SSH config (rarely changes)
# Deliberately NO `ssh-keygen -A` here: baking host keys into the image would
# ship every sandbox's PRIVATE key inside the public dev-base image (anyone
# could impersonate any sandbox to the gateway) and every sandbox would share
# the same host key. `sandbox-boot.sh` runs `ssh-keygen -A` fresh on every
# boot instead (per-sandbox, per-boot keys, nothing secret distributed), and
# the agent's `GET /ssh/host-keys` lets the server pin the real key into the
# in-server proxy — see docs/archive/proposals/portable-runtime-backends.md §5
# and apps/agent/src/ssh.rs. chmod: trixie creates homes 0700; keep the 0755
# earlier images had.
RUN usermod -l dev -d /home/dev -m node \
    && groupmod -n dev node \
    && chmod 755 /home/dev \
    && mkdir -p /var/run/sshd \
    && rm -f /etc/ssh/ssh_host_* \
    && sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config

# Layer 4: Bun runtime (cached unless install script changes)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/dev/.bun bash \
    && chown -R dev:dev /home/dev/.bun \
    && echo 'export BUN_INSTALL="/home/dev/.bun"' > /etc/profile.d/bun.sh \
    && echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh

# Layer 5: Directory structure + permissions
RUN mkdir -p /etc/sandbox/secrets /var/log/sandbox \
    /.atelier \
    && chown -R dev:dev /home/dev /var/log/sandbox /etc/sandbox /.atelier \
    && chmod 775 /etc/sandbox /etc/sandbox/secrets /var/log/sandbox /.atelier

# Layer 6: Profile scripts + config files (most likely to change)
# Toolset artifacts (docs/archive/proposals/composed-prebuild-volumes.md) materialize binaries into
# ~/.local/bin — toolboxes (opencode, pi, code-server) land there instead of
# the retired /opt/shared PVC. A login shell (supervisor spawns via
# `bash -l -c`) sources this, so PATH reaches every supervised process,
# interactive terminal, and exec/hooks call.
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' > /etc/profile.d/local-bin.sh \
    && printf 'export LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' > /etc/profile.d/locale.sh \
    && printf '[ "$(id -u)" = "1000" ] && [ -r /etc/sandbox/secrets/.env ] && . /etc/sandbox/secrets/.env\n' > /etc/profile.d/99-sandbox-secrets.sh
COPY --chown=dev:dev rootfs/etc/sandbox/ /etc/sandbox/
COPY rootfs/etc/chrony/chrony.conf /etc/chrony/chrony.conf
RUN mkdir -p /var/lib/chrony && chown _chrony:_chrony /var/lib/chrony \
    && echo 'dev ALL=(root) NOPASSWD: /usr/sbin/chronyd, /usr/bin/chronyc' > /etc/sudoers.d/chrony \
    && chmod 440 /etc/sudoers.d/chrony
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true
# Agent binary from the `agent` stage above (apps/agent ships it at
# /atelier-agent). The in-pod path stays /usr/local/bin/sandbox-agent so
# sandbox-boot.sh is unchanged.
COPY --from=agent /atelier-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

# /home/skel is the read-only overlay lower for /home/dev
# (docs/archive/proposals/toolset-overlay-squashfs.md §3): the PVC no longer mounts
# at /home/dev (it mounts at /data), and /home/dev must be an EMPTY mountpoint
# for the overlay the entrypoint/agent assemble on top of it — so the image's
# original home contents move to /home/skel and stay there permanently (never
# copied back; they're read directly as the lowest overlay layer).
RUN mv /home/dev /home/skel \
    && mkdir /home/dev \
    && chown dev:dev /home/dev

USER dev
CMD ["/bin/bash"]
