FROM atelier/dev-base:latest

USER root

# Install to /opt (rootfs), NOT $HOME. /home/dev is rebuilt at boot as an
# overlay over /home/skel (see dev-base's /home/skel mv), so anything
# installed under $HOME in this image would not be visible. This mirrors how
# dev-cloud installs to /opt.
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