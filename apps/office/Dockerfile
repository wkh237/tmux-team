# Local verification only, not a production deployment image.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN npm install --global pnpm@10.33.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/office/package.json apps/office/package.json
RUN pnpm office:install \
  && test ! -e node_modules/better-sqlite3 \
  && test ! -e rust/target/debug/tmt
COPY apps/office apps/office
CMD ["sh", "-c", "pnpm office:check && pnpm office:test && pnpm office:build"]
