# Two-stage build: compile a fully static musl binary in a throwaway builder,
# then ship it alone FROM scratch (~1MB image, nothing but the agent). This is
# self-contained — no prebuilt dist/ or host Rust/musl toolchain required; a
# `docker buildx --platform linux/amd64` build cross-compiles inside the
# builder. Reproducible via the committed Cargo.lock (--locked).
#
# Alpine's default host target is x86_64-unknown-linux-musl, so a plain
# `cargo build --release` already yields a static binary suitable for scratch.
FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM scratch
COPY --from=builder /build/target/release/atelier-agent /atelier-agent
ENTRYPOINT ["/atelier-agent"]
