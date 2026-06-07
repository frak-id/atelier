FROM atelier/dev-base:latest

USER root

# Install to /opt (rootfs), NOT $HOME. At boot a block PVC is mounted over
# /home/dev and only /home/skel is copied back (see dev-base Dockerfile:104),
# so a $HOME install would vanish. This mirrors how dev-cloud installs to /opt.
ENV RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo \
    PATH=/opt/rust/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal \
            --default-toolchain stable \
    && rustup component add clippy rustfmt \
    && chmod -R a+rwX /opt/rust \
    && printf 'export RUSTUP_HOME=/opt/rust/rustup\nexport CARGO_HOME=/opt/rust/cargo\nexport PATH=/opt/rust/cargo/bin:$PATH\n' \
         > /etc/profile.d/rust.sh

USER dev
CMD ["/bin/bash"]