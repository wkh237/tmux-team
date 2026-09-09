# Local emulators only; never mount host Firebase credentials into this image.
FROM eclipse-temurin:21-jre-jammy@sha256:54b382c9d790d3201004d4e3921f4eff7dc7d67e1ce21a2da8d8faaaf63c85fc AS java
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS emulators
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
RUN npm install --global firebase-tools@15.29.0
RUN mkdir -p /home/node/office && chown node:node /home/node/office
USER node
WORKDIR /home/node/office
RUN firebase setup:emulators:firestore --non-interactive
COPY --chown=node:node services/office/firebase.json services/office/firestore.rules ./
COPY --chown=node:node scripts/verify-office-emulators.mjs ./
ENV GCLOUD_PROJECT=demo-tmt-office
CMD ["firebase", "emulators:start", "--only", "auth,firestore", "--project", "demo-tmt-office", "--config", "firebase.json", "--non-interactive"]

# Opt-in browser proof reuses the emulator owner; no host credentials or volumes.
FROM emulators AS browser-tests
USER root
RUN npm install --global pnpm@10.33.0 && mkdir -p /workspace/apps/office && chown -R node:node /workspace
WORKDIR /workspace
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/office/package.json apps/office/package.json
USER node
RUN pnpm office:install && test ! -e node_modules/better-sqlite3 && test ! -e /node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
USER root
RUN pnpm --filter @tmt/office exec playwright install --with-deps chromium
USER node
COPY --chown=node:node apps/office apps/office
RUN --network=none pnpm office:check && pnpm office:test \
  && pnpm --filter @tmt/office exec vite build --outDir dist-preview \
  && pnpm --filter @tmt/office exec vite build --mode emulator
CMD ["firebase", "emulators:exec", "--only", "auth,firestore", "--project", "demo-tmt-office", "--config", "/home/node/office/firebase.json", "--non-interactive", "pnpm --filter @tmt/office test:browser"]

# Keep the existing default build and compose behavior lightweight.
FROM emulators AS default
