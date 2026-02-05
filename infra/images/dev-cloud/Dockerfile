# L'atelier - dev-cloud image
# Extends dev-base with cloud CLI tools: AWS CLI, Google Cloud SDK, kubectl
#
# Build: docker build -t atelier/dev-cloud .
# Requires: atelier/dev-base image to be built first

FROM atelier/dev-base:latest

USER root

# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# Google Cloud SDK + kubectl + gke-gcloud-auth-plugin
ENV CLOUDSDK_INSTALL_DIR=/opt
RUN curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz \
    | tar xz -C /opt \
    && /opt/google-cloud-sdk/install.sh \
        --quiet \
        --usage-reporting=false \
        --path-update=false \
        --command-completion=false \
    && /opt/google-cloud-sdk/bin/gcloud components install kubectl gke-gcloud-auth-plugin --quiet \
    && ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
    && ln -sf /opt/google-cloud-sdk/bin/kubectl /usr/local/bin/kubectl \
    && ln -sf /opt/google-cloud-sdk/bin/gke-gcloud-auth-plugin /usr/local/bin/gke-gcloud-auth-plugin

# Pulumi CLI (used by SST for infrastructure deployments)
RUN curl -fsSL https://get.pulumi.com | sh -s -- --install-root /usr/local

# Create cloud config directories for dev user
RUN mkdir -p /home/dev/.aws /home/dev/.config/gcloud /home/dev/.kube \
    && chown -R dev:dev /home/dev/.aws /home/dev/.config/gcloud /home/dev/.kube

# Add gcloud to PATH for all users
RUN echo 'export PATH="/opt/google-cloud-sdk/bin:$PATH"' > /etc/profile.d/gcloud.sh

USER dev
WORKDIR /home/dev/workspace
CMD ["/bin/bash"]
