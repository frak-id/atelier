# Frak Sandbox - dev-base image
# Minimal development environment with code-server, OpenCode, Bun, and Git
#
# Build: docker build -t frak-sandbox/dev-base .
# Export: docker export $(docker create frak-sandbox/dev-base) | tar -C ./rootfs -xf -

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/dev
ENV USER=dev
ENV SHELL=/bin/bash

# Install base system packages
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
    dnsutils \
    locales \
    && rm -rf /var/lib/apt/lists/*

# Set up locale
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Create dev user with sudo access
RUN useradd -m -s /bin/bash -G sudo dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Bun for dev user
ENV BUN_INSTALL=/home/dev/.bun
ENV PATH=$BUN_INSTALL/bin:$PATH
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/home/dev/.bun bash \
    && chown -R dev:dev /home/dev/.bun

# Install code-server
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Install ttyd for web terminal access
RUN apt-get update && apt-get install -y --no-install-recommends \
    ttyd \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode
RUN npm install -g opencode-ai

# Configure SSH
RUN mkdir -p /var/run/sshd \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo "dev:sandbox" | chpasswd

# Create sandbox directories
RUN mkdir -p /etc/sandbox/secrets \
    && mkdir -p /var/log/sandbox \
    && mkdir -p /home/dev/workspace \
    && chown -R dev:dev /home/dev \
    && chown -R dev:dev /var/log/sandbox

# Copy sandbox init scripts
COPY rootfs/etc/sandbox/ /etc/sandbox/
RUN chmod +x /etc/sandbox/*.sh 2>/dev/null || true

# Copy sandbox-agent script (runs with Node)
COPY --chown=root:root sandbox-agent.mjs /usr/local/lib/sandbox-agent.mjs

# Set default working directory
WORKDIR /home/dev/workspace

# Switch to dev user for default shell
USER dev

# Default command (overridden by sandbox-init)
CMD ["/bin/bash"]
