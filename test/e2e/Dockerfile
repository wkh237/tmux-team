FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073 AS native-tests
WORKDIR /native/rust
COPY rust/ ./
COPY skills/ ../skills/
ARG TMT_NATIVE_PROFILE=dev
RUN cargo build --locked --example tmux-probe \
  && case "$TMT_NATIVE_PROFILE" in dev) native_output=debug ;; release) native_output=release ;; *) exit 2 ;; esac \
  && cargo build --locked --profile "$TMT_NATIVE_PROFILE" -p tmt-cli \
  && cargo test --locked --no-run -p tmt-adapters \
  && mkdir /native-artifacts \
  && cp target/debug/examples/tmux-probe /native-artifacts/tmux-probe \
  && cp "target/$native_output/tmt" /native-artifacts/tmt \
  && find target/debug/deps -maxdepth 1 -type f -name 'tmt_adapters-*' -executable \
    -exec cp {} /native-artifacts/adapter-tests \;

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG TMUX_VERSION=3.3a-3
ARG PROCPS_VERSION=2:4.0.2-3
RUN apt-get update \
  && apt-get install --no-install-recommends -y "tmux=${TMUX_VERSION}" "procps=${PROCPS_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.33.0

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
COPY --from=native-tests /native-artifacts/ /opt/tmt-tests/
ENV TMT_TEST_TMUX_PROBE='{"executable":"/opt/tmt-tests/tmux-probe","args":[]}'
ENV TMT_TEST_NATIVE_CLI='{"executable":"/opt/tmt-tests/tmt","args":[]}'

# Run process lifecycle tests under the wrapper's --init, not a build-stage
# shell that may retain orphan zombies. Both suites share network isolation.
CMD ["sh", "-c", "/opt/tmt-tests/adapter-tests && exec pnpm exec vitest run --config test/e2e/vitest.config.ts"]
