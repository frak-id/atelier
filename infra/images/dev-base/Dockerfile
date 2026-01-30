# Frak Sandbox - dev-base image
# Minimal development environment with Bun, Git, and ttyd
# code-server and opencode are served via NFS from /opt/shared/bin
#
# Build: docker build -t frak-sandbox/dev-base .
# Export: docker export $(docker create frak-sandbox/dev-base) | tar -C ./rootfs -xf -

FROM node:22-slim

ARG TTYD_VERSION=1.7.7
ARG NOVNC_VERSION=1.5.0
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
    # Browser streaming: Xvfb + x11vnc + websockify (Chromium binary is on shared ext4 drive)
    xvfb \
    x11vnc \
    python3-minimal \
    python3-numpy \
    # Chromium runtime dependencies (binary loaded from /opt/shared/bin)
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libdbus-1-3 \
    libexpat1 \
    fonts-liberation \
    # Install ttyd from GitHub release (not in Debian repos)
    && curl -fsSL -o /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 \
    && chmod +x /usr/local/bin/ttyd \
    # Install websockify via pip
    && python3 -m pip install --break-system-packages --no-cache-dir websockify \
    # Install noVNC static files
    && curl -fsSL -o /tmp/novnc.tar.gz https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz \
    && mkdir -p /opt/novnc \
    && tar -xzf /tmp/novnc.tar.gz -C /opt/novnc --strip-components=1 \
    && rm -f /tmp/novnc.tar.gz \
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
COPY --chown=root:root sandbox-agent /usr/local/bin/sandbox-agent
RUN chmod +x /usr/local/bin/sandbox-agent

WORKDIR /home/dev/workspace
USER dev
CMD ["/bin/bash"]
