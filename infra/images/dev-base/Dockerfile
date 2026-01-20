# Frak Sandbox - dev-base image
# Minimal development environment with code-server, OpenCode, Bun, and Git
#
# Build: docker build -t frak-sandbox/dev-base .
# Export: docker export $(docker create frak-sandbox/dev-base) | tar -C ./rootfs -xf -

FROM ubuntu:24.04

# Version args - override with --build-arg to update
ARG OPENCODE_VERSION=1.1.27
ARG CODE_SERVER_VERSION=4.100.3

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/dev
ENV USER=dev
ENV SHELL=/bin/bash
ENV BUN_INSTALL=/home/dev/.bun
ENV PATH=$BUN_INSTALL/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Install base system packages + Node.js in single layer, clean up immediately
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
    && locale-gen en_US.UTF-8 \
    # Install Node.js
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    # Clean up
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Create dev user with sudo access
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash -G sudo -u 1000 dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

# Install Bun
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/dev/.bun bash \
    && chown -R dev:dev /home/dev/.bun

# Install code-server directly from .deb (faster than install script)
RUN curl -fsSL -o /tmp/code-server.deb \
    "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
    && dpkg -i /tmp/code-server.deb \
    && rm /tmp/code-server.deb

# Install ttyd for web terminal
RUN apt-get update && apt-get install -y --no-install-recommends ttyd \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install OpenCode with pinned version, clean npm cache
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/*

# Configure SSH
RUN mkdir -p /var/run/sshd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo "dev:sandbox" | chpasswd

# Create sandbox directories
RUN mkdir -p /etc/sandbox/secrets /var/log/sandbox \
    /home/dev/workspace \
    /home/dev/.local/share/code-server/User \
    /home/dev/.local/share/opencode \
    /home/dev/.config \
    && chown -R dev:dev /home/dev /var/log/sandbox

# Copy code-server settings
COPY --chown=dev:dev rootfs/home/dev/.local/share/code-server/User/settings.json /home/dev/.local/share/code-server/User/settings.json

# Copy sandbox init scripts
COPY rootfs/etc/sandbox/ /etc/sandbox/
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true

# Copy sandbox-agent script (runs with Node)
COPY --chown=root:root sandbox-agent.mjs /usr/local/lib/sandbox-agent.mjs

WORKDIR /home/dev/workspace
USER dev
CMD ["/bin/bash"]
