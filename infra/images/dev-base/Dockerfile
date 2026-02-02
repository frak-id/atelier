# Frak Sandbox - dev-base image
# Minimal development environment with Bun and Git
# code-server and opencode are served via NFS from /opt/shared/bin
#
# Build: docker build -t frak-sandbox/dev-base .
# Export: docker export $(docker create frak-sandbox/dev-base) | tar -C ./rootfs -xf -

FROM node:22-slim


ARG KASMVNC_VERSION=1.4.0
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/dev
ENV USER=dev
ENV SHELL=/bin/bash
ENV BUN_INSTALL=/home/dev/.bun
ENV PATH=$BUN_INSTALL/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Install system packages, rename node user to dev, configure SSH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    openssh-server \
    sudo \
    htop \
    vim \
    nano \
    jq \
    unzip \
    xz-utils \
    procps \
    iproute2 \
    iputils-ping \
    locales \
    nfs-common \
    chromium \
    fonts-liberation \
    xdotool \
    openbox \
    libegl1 \
    && locale-gen en_US.UTF-8 \
    && usermod -l dev -d /home/dev -m node \
    && groupmod -n dev node \
    && mkdir -p /var/run/sshd \
<<<<<<< HEAD
    && sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config \
    && curl -fsSL -o /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb" \
    && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/lintian \
    && find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en*' -exec rm -rf {} + \
    && rm -rf /var/cache/apt

# Install Bun + add to PATH for all users
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/dev/.bun bash \
    && chown -R dev:dev /home/dev/.bun \
    && echo 'export BUN_INSTALL="/home/dev/.bun"' > /etc/profile.d/bun.sh \
    && echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /etc/profile.d/bun.sh

# Create sandbox directories with proper ownership
# All paths owned by dev:dev (UID/GID 1000) to match host frak user
RUN mkdir -p /etc/sandbox/secrets /var/log/sandbox \
    /home/dev/workspace \
    /home/dev/.local/share/code-server/User \
    /home/dev/.local/share/opencode \
    /home/dev/.config/opencode \
    /home/dev/.cache/oh-my-opencode \
    /.frak-sandbox \
    && chown -R dev:dev /home/dev /var/log/sandbox /etc/sandbox /.frak-sandbox \
    && chmod 775 /etc/sandbox /etc/sandbox/secrets /var/log/sandbox /.frak-sandbox

# Bake static profile scripts (no per-spawn injection needed)
RUN echo 'export PATH="/opt/shared/bin:$PATH"' > /etc/profile.d/shared-binaries.sh

# Copy config files
COPY --chown=dev:dev rootfs/home/dev/.local/share/code-server/User/settings.json /home/dev/.local/share/code-server/User/settings.json
COPY --chown=dev:dev rootfs/etc/sandbox/ /etc/sandbox/
COPY rootfs/etc/xdg/openbox/ /etc/xdg/openbox/
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true
COPY --chown=root:root sandbox-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

WORKDIR /home/dev/workspace
USER dev
CMD ["/bin/bash"]
