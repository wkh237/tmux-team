---
name: tmt-remote
description: Build, run and verify the Remote door (`tmt-remote`, `tmt remote ...`), its embedded browser client and the browser add-on shell. Load when changing extensions/tmt-remote or running its checks. Owner - the tmt-remote squad.
---

# Remote development

Behavior lives in [`contracts/remote-channel-v1.md`](../../../contracts/remote-channel-v1.md)
and [ARCHITECTURE.md](../../../ARCHITECTURE.md); this skill holds only how to build,
run and verify. Shared Rust, native and Docker gates are in
[DEVELOPMENT.md](../../../DEVELOPMENT.md).

## Rust crate

```bash
(cd rust && cargo build --offline --locked -p tmt-remote)
(cd rust && CARGO_BUILD_JOBS=2 cargo test --offline --locked -p tmt-remote)
(cd rust && cargo clippy --offline --locked -p tmt-remote --all-targets -- -D warnings)
(cd rust && cargo test --offline --locked -p tmt-cli --test architecture)
node typescript/scripts/release-please-config.mjs --check
(cd typescript && corepack pnpm exec vp test run --config vitest.config.ts test/tooling/release-please-config.test.ts test/tooling/ci-scope.test.ts)
```

- Pairing and state tests use short roots under `/tmp`: Unix socket paths are
  limited to about 100 bytes.
- Native operation tests use signed requests, private real storage and
  deterministic public-process fixtures; they are not real-core acceptance. The
  SIGKILL probe checks serve-lease inheritance and release.
- `remote-operations` and `remote-recovery` Docker scenarios cover dispatch, hold,
  recovery and one permitted/refused read through `E2EFixture`. Run them with
  `CARGO_BUILD_JOBS=2 corepack pnpm test:e2e` in the booked isolated Docker heavy
  slot, twice. Their wrapper executes the selected real core; test-only grant
  seeding happens only in Remote storage while serve and owned children are stopped.
- Door tests use disposable HOME/XDG, count startup core calls separately, assert
  zero request-triggered core calls and run socket/process lifecycle twice. No real
  model, account or database is used.

## Run the door

Build core, put `rust/target/debug` on `PATH`, then `tmt remote serve` (or `--json`
for the bound descriptor). Direct invocation requires an absolute `TMT_EXECUTABLE`;
it never searches for another core. Ctrl-C/SIGTERM closes listeners, sockets and
workers. Limits are named in `src/limits.rs`.

## Shared extension state

[The state leaf](../../../ARCHITECTURE.md#shared-extension-state-layout) is
library-only and shared with Colab:

```bash
(cd rust && cargo test --offline --locked -p tmt-extension-state)
(cd rust && cargo test --offline --locked -p tmt-remote --test state)
(cd rust && cargo test --offline --locked -p tmt-colab --test state)
(cd rust && cargo clippy --offline --locked -p tmt-extension-state -p tmt-remote -p tmt-colab --all-targets -- -D warnings)
(cd rust && cargo test --offline --locked -p tmt-cli --test architecture)
```

Synced publication tests prove filesystem behavior, not power-loss recovery. A new
workspace path also needs the tracked-file layout, generated release configuration
and CI-scope checks.

## Embedded client and crypto fixtures

The door embeds `extensions/tmt-remote/rust/tmt-remote/assets/remote-v1.js`, built
from `remote-client`. After changing `remote-client/src`, rebuild and commit it
(Code quality rebuilds it and fails on a difference), then run the Chromium pairing
smoke against a debug door:

```bash
(cd typescript && pnpm --filter @tmt/remote-client --fail-if-no-match build)
(cd rust && cargo build --offline --locked -p tmt-remote)
(cd typescript && pnpm --filter @tmt/remote-client exec playwright install chromium)
(cd typescript && pnpm --filter @tmt/remote-client --fail-if-no-match test:browser)
```

Byte and crypto conformance runs with the Rust tests. The shared vectors come from
`extensions/tmt-remote/typescript/remote-client/test/reference.py` (which also checks the
pinned BIP-39 list digest). Check the Rust-owned fixtures with:

```bash
python3 extensions/tmt-remote/rust/tmt-remote/tests/fixtures/mac-reference.py --check
node extensions/tmt-remote/rust/tmt-remote/tests/fixtures/webcrypto.mjs
```

Use the repository Node 22 and repeat the WebCrypto command on Node 24; `--write`
regenerates the public-test-key fixture. The Python oracle imports no product code.
None of this proves real Chrome key persistence across MV3 worker restarts.

## Browser add-on shell

Private MV3 demo shell at `extensions/tmt-remote/typescript/browser-addon`; it does
not connect to TMT. From `typescript/`:

```sh
corepack pnpm --filter @tmt/browser-addon --fail-if-no-match check
corepack pnpm --filter @tmt/browser-addon --fail-if-no-match test
corepack pnpm --filter @tmt/browser-addon --fail-if-no-match build
corepack pnpm --filter @tmt/browser-addon exec playwright install chromium
corepack pnpm --filter @tmt/browser-addon --fail-if-no-match test:browser
```

Browser tests use Playwright's Chromium, a disposable profile and a task-owned
loopback page, never the host Chrome profile. To inspect manually, load `dist/` as an
unpacked add-on in a separate profile (Chrome 137 or later). Package code uses the
`fmt` block in its Vite configuration; shared docs use the tooling formatter.

## Installer registration

Core registers `remote` for the shared installer separately from archive
publication. From `rust/`:

```sh
CARGO_BUILD_JOBS=2 cargo test --locked -p tmt-core native_install
CARGO_BUILD_JOBS=2 cargo test --locked -p tmt-adapters native_install
CARGO_BUILD_JOBS=2 cargo test --locked -p tmt-cli extension_install_command
CARGO_BUILD_JOBS=2 cargo test --locked -p tmt-cli parser::tests::native_install
```

Process fixtures build CLI, Squad, Remote and Colab independently in the worktree's
`rust/target`, then run `extension-install.test.ts` through the native test config;
they use the built `tmt-remote`, never a substitute CLI. A registered product with no
published archive must report `EXTENSION_RELEASE_UNAVAILABLE` ("No published remote
release yet") with no asset acquisition or prefix creation. Synthetic archives prove
installer behavior, not published archive linkage. Publish the supporting CLI alpha
before testing a public install or upgrade.
