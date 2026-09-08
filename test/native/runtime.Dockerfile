# Verification tooling only. The product receives a separate empty PATH.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN apk add --no-cache binutils
WORKDIR /verification
COPY scripts/native-runtime-proof.mjs scripts/verify-native-runtime.mjs scripts/packed-command.mjs scripts/
COPY test/support/performance-contract.mjs test/support/performance-contract.mjs
COPY skills/tmux-team/SKILL.md skills/tmux-team/SKILL.md
ENTRYPOINT ["node", "scripts/verify-native-runtime.mjs"]
