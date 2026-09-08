# Local native-architecture artifact proof. Not a publishing workflow.
FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073 AS build
RUN apt-get update && apt-get install --no-install-recommends -y musl-tools \
  && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-dist --version 0.32.0 --locked \
  && cargo install cargo-about --version 0.9.2 --locked --features cli
ARG TARGET_TRIPLE
RUN test -n "$TARGET_TRIPLE" && rustup target add "$TARGET_TRIPLE"
WORKDIR /workspace
COPY rust/ rust/
COPY skills/ skills/
COPY scripts/native-cargo.sh scripts/build-native-artifact.sh scripts/
COPY dist-workspace.toml LICENSE NATIVE-INSTALL.md ./
RUN cd rust && cargo fetch --locked
RUN scripts/build-native-artifact.sh "$TARGET_TRIPLE" > native-manifest.json

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update && apt-get install --no-install-recommends -y binutils \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.0
WORKDIR /verification
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY scripts/native-artifact-policy.mjs scripts/verify-native-artifact.mjs scripts/verify-native-installation.mjs scripts/packed-command.mjs scripts/
COPY skills/tmux-team/SKILL.md expected-skill.md
COPY --from=build /workspace/native-manifest.json ./
COPY --from=build /workspace/rust/target/native-notices/THIRD-PARTY-NOTICES.txt expected-notices.txt
COPY LICENSE expected-license.txt
COPY --from=build /workspace/target/distrib/ artifacts/
# Pass archive and target explicitly from the generator's target selection.
ENTRYPOINT ["node", "scripts/verify-native-artifact.mjs", "--manifest", "native-manifest.json", "--skill", "expected-skill.md", "--notices", "expected-notices.txt", "--license", "expected-license.txt"]
