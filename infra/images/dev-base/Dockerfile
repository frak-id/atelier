# Frak Sandbox - dev-base image
# Minimal development environment with code-server, OpenCode, Bun, and Git
#
# Build: docker build -t frak-sandbox/dev-base .
# Export: docker export $(docker create frak-sandbox/dev-base) | tar -C ./rootfs -xf -

FROM node:22-slim

ARG OPENCODE_VERSION=1.1.27
ARG CODE_SERVER_VERSION=4.100.3
ARG TTYD_VERSION=1.7.7

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
    && locale-gen en_US.UTF-8 \
    && usermod -l dev -d /home/dev -m node \
    && groupmod -n dev node \
    && usermod -aG sudo dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev \
    && mkdir -p /var/run/sshd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo "dev:sandbox" | chpasswd \
    # Install ttyd from GitHub release (not in Debian repos)
    && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd \
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

# Install code-server
RUN curl -fsSL -o /tmp/code-server.deb \
    "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
    && dpkg -i /tmp/code-server.deb \
    && rm /tmp/code-server.deb

# Install OpenCode from pre-built binary (48MB vs 567MB npm)
RUN curl -fsSL -o /tmp/opencode.tar.gz \
    "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64-baseline.tar.gz" \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin \
    && chmod +x /usr/local/bin/opencode \
    && rm /tmp/opencode.tar.gz

# Create sandbox directories
RUN mkdir -p /etc/sandbox/secrets /var/log/sandbox \
    /home/dev/workspace \
    /home/dev/.local/share/code-server/User \
    /home/dev/.local/share/opencode \
    /home/dev/.config \
    && chown -R dev:dev /home/dev /var/log/sandbox

# Copy config files
COPY --chown=dev:dev rootfs/home/dev/.local/share/code-server/User/settings.json /home/dev/.local/share/code-server/User/settings.json
COPY rootfs/etc/sandbox/ /etc/sandbox/
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true
COPY --chown=root:root sandbox-agent.mjs /usr/local/lib/sandbox-agent.mjs

WORKDIR /home/dev/workspace
USER dev
CMD ["/bin/bash"]
