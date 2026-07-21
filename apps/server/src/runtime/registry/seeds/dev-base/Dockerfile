# Atelier - dev-base image
# Minimal development environment with Bun and Git
# code-server and opencode are materialized into ~/.local/bin by the org
# toolbox toolset artifact (composed-prebuild-volumes.md), not /opt/shared.
#
# Build: docker build -t atelier/dev-base .
# Export: docker export $(docker create atelier/dev-base) | tar -C ./rootfs -xf -

# In-pod Rust agent, pulled from a prebuilt image (public GHCR by default) so a
# fresh operator never has to build it first. Override with
# `--build-arg AGENT_IMAGE=<ref>` (the server passes `sandbox.agentImage`) to
# use a private/mirrored agent — e.g. an air-gapped cluster's own registry.
ARG AGENT_IMAGE=ghcr.io/frak-id/sandbox-agent:latest
FROM ${AGENT_IMAGE} AS agent

FROM node:22-slim


ARG ORAS_VERSION=1.2.0
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
# would use squashfs) — docs/proposals/toolset-overlay-squashfs.md §3-4.
# Both mkfs tools are baked so one image works on either kernel. rsync: stages
# toolset build/capture path-sets into a scratch root before packaging.
# e2fsprogs (mkfs.ext4): the workspace PVC is attached as a raw block device;
# sandbox-boot.sh formats it ext4 and mounts it at /data on first boot
# (docs/plans/toolset-inplace-update-fix-options.md §3). blkid/mountpoint come
# from util-linux (base).
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
    nfs-common \
    squashfs-tools \
    erofs-utils \
    e2fsprogs \
    rsync \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian \
    && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} + \
    && rm -rf /var/cache/apt

# Layer 2: oras (OCI artifact CLI) — the guest agent shells out to it to
# push/pull toolset artifacts to/from the in-cluster zot registry
# (composed-prebuild-volumes.md). Static linux/amd64 binary; no runtime deps.
RUN curl -fsSL -o /tmp/oras.tar.gz "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" \
    && tar -xzf /tmp/oras.tar.gz -C /usr/local/bin oras \
    && chmod +x /usr/local/bin/oras \
    && rm -f /tmp/oras.tar.gz \
    && oras version

# Layer 3: Locale + user setup + SSH config (rarely changes)
# ssh-keygen -A bakes host keys into the image so they are not regenerated on
# every boot. Sandboxes share host keys, which is safe here: SSH only enters via
# sshpiper, which sets ignore_hostkey: true (no client ever pins a sandbox key).
RUN usermod -l dev -d /home/dev -m node \
    && groupmod -n dev node \
    && mkdir -p /var/run/sshd \
    && sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config \
    && ssh-keygen -A

# Layer 4: Bun runtime (cached unless install script changes)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/dev/.bun bash \
    && chown -R dev:dev /home/dev/.bun \
    && echo 'export BUN_INSTALL="/home/dev/.bun"' > /etc/profile.d/bun.sh \
    && echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh

# Layer 5: Directory structure + permissions
RUN mkdir -p /etc/sandbox/secrets /var/log/sandbox \
    /home/dev/.local/share/code-server/User \
    /home/dev/.local/share/opencode \
    /home/dev/.config/opencode \
    /home/dev/.cache/oh-my-opencode \
    /.atelier \
    && chown -R dev:dev /home/dev /var/log/sandbox /etc/sandbox /.atelier \
    && chmod 775 /etc/sandbox /etc/sandbox/secrets /var/log/sandbox /.atelier

# Layer 6: Profile scripts + config files (most likely to change)
# Toolset artifacts (composed-prebuild-volumes.md) materialize binaries into
# ~/.local/bin — the org toolbox (opencode, code-server) lands there instead
# of the retired /opt/shared PVC. A login shell (supervisor spawns via
# `bash -l -c`) sources this, so PATH reaches every supervised process,
# interactive terminal, and exec/hooks call.
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' > /etc/profile.d/local-bin.sh \
    && printf 'export LANG=C.UTF-8\nexport LC_ALL=C.UTF-8\n' > /etc/profile.d/locale.sh \
    && printf '[ "$(id -u)" = "1000" ] && [ -r /etc/sandbox/secrets/.env ] && . /etc/sandbox/secrets/.env\n' > /etc/profile.d/99-sandbox-secrets.sh
COPY --chown=dev:dev rootfs/home/dev/.local/share/code-server/User/settings.json /home/dev/.local/share/code-server/User/settings.json
COPY --chown=dev:dev rootfs/etc/sandbox/ /etc/sandbox/
COPY rootfs/etc/chrony/chrony.conf /etc/chrony/chrony.conf
RUN mkdir -p /var/lib/chrony && chown _chrony:_chrony /var/lib/chrony \
    && echo 'dev ALL=(root) NOPASSWD: /usr/sbin/chronyd, /usr/bin/chronyc' > /etc/sudoers.d/chrony \
    && chmod 440 /etc/sudoers.d/chrony
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true
# v2 agent binary from the `agent` stage above (apps/agent-v2 ships it at
# /atelier-agent). The in-pod path stays /usr/local/bin/sandbox-agent so
# sandbox-boot.sh is unchanged.
COPY --from=agent /atelier-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

# /home/skel is the read-only overlay lower for /home/dev
# (docs/proposals/toolset-overlay-squashfs.md §3): the PVC no longer mounts
# at /home/dev (it mounts at /data), and /home/dev must be an EMPTY mountpoint
# for the overlay the entrypoint/agent assemble on top of it — so the image's
# original home contents move to /home/skel and stay there permanently (never
# copied back; they're read directly as the lowest overlay layer).
RUN mv /home/dev /home/skel \
    && mkdir /home/dev \
    && chown dev:dev /home/dev

USER dev
CMD ["/bin/bash"]
