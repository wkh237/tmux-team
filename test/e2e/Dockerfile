FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG TMUX_VERSION=3.3a-3
RUN apt-get update \
  && apt-get install --no-install-recommends -y "tmux=${TMUX_VERSION}" \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@10.33.0

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .

CMD ["pnpm", "exec", "vitest", "run", "--config", "test/e2e/vitest.config.ts"]
