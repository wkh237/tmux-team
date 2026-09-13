# Development

The Rust workspace is the shipped CLI runtime. The optional Office SPA foundation
lives in `apps/office` and is not required to use the CLI. The root Node package is
private developer tooling for Vitest, fixtures and release verification; it is
not an npm product and must not be used as a CLI fallback. Repository policy is
in [AGENTS.md](AGENTS.md), architecture ownership in
[ARCHITECTURE.md](ARCHITECTURE.md), and style in [CONVENTIONS.md](CONVENTIONS.md).
Use this guide for reproducible commands and evidence.

## Setup

This section is for contributors, not end users. Rust/Cargo builds the product.
Node and pinned pnpm run Vitest/native-process/Docker orchestration, formatting,
type checks and release verification. `better-sqlite3` is an independent test
oracle; `tar` builds test archives. These are retained developer dependencies,
not reasons to install TMT through npm. npm is not a separate required workflow;
use the pinned pnpm lockfile rather than introducing another package manager.

Requirements are Node.js 22.12 or newer, the pinned pnpm toolchain, and the
Rust toolchain declared by `rust/rust-toolchain.toml`. The workspace MSRV is
Rust 1.88; CI also runs the current pinned release toolchain.
Shell completion tests require Bash and Zsh. Runtime proof uses the selected
macOS developer tools or Linux `readelf` (binutils); these are verifier tools,
not product runtime dependencies.

```bash
pnpm install --frozen-lockfile
(cd rust && rustup show)
```

Do not install the product globally while testing. Keep application state,
provider directories, temporary prefixes, sockets and child processes inside a
task-owned temporary root.

If `better-sqlite3` is used by retained tooling, it is a development-only
independent SQLite oracle. It is not the Rust runtime, a product dependency or
an excuse to reopen native schema state through Node.

## Office SPA

The optional app uses React, Vite, TanStack Router and Jotai. Read
[Office architecture](docs/office/architecture.md) before changing its boundaries.
From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm office:dev
pnpm office:check
pnpm office:test
pnpm office:build
```

The dev server binds loopback. Production output is `apps/office/dist`; preview
with `pnpm --filter @tmt/office preview`. A deployed SPA host must rewrite app
routes such as `/setup` to `index.html`; hosting and Firebase setup are not part
of the scaffold. Tests use jsdom and the real router, not a browser-layout proof.

`pnpm check` checks root tooling and Office. `pnpm check:tooling` retains the
native test/release tooling's independent quality gate. Root `test:run` still
selects only tooling tests; `office:test` explicitly selects app tests and fails
on empty discovery. Office uses Oxfmt; existing root tooling/docs use Prettier.
Run `pnpm --filter @tmt/office format` for app formatting, not the root formatter.
The distinct Vitest versions are lockfile-owned, not a claim that native tests
were migrated to the newer app runner.
Office wire-schema conformance is a root tooling test:
`pnpm exec vitest run test/tooling/office-contracts.test.ts`. See
[`contracts/office`](contracts/office/README.md) for its single source of truth,
versioning and limits. Design vectors are not executable authorization or crash
recovery evidence; downstream suites must prove those behaviors separately.
Root tooling runs at most two suite workers to avoid simultaneous subprocess
startup overwhelming the existing per-test budgets; assertion/time limits are
unchanged. Native process and tmux configurations keep their own execution rules.

For an Office-only clean checkout, use `pnpm office:install`. It installs from
the app directory against the same root lockfile, without workspace recursion.
With pinned pnpm 10.33, a plain Office `--filter` install still builds root
SQLite; the explicit isolated install avoids that unrelated dependency. Do not
create an app lockfile or remove `--frozen-lockfile` to work around a mismatch.
The script resolves the lockfile directory through an absolute path: pinned pnpm
can apply a relative path twice and place modules outside the checkout. The
non-root browser image verifies dependencies stay in its workspace. Firebase's
optional auto-configuration postinstall and protobufjs's version warning script
remain unapproved; explicit app configuration and bundled SDK code need neither.

The app's verification-only Dockerfile proves the isolated install has neither
the root SQLite oracle nor a native TMT executable. It runs quality, DOM tests
and a production build with networking disabled:

```sh
docker build -f apps/office/Dockerfile -t tmt-office-check:local .
docker run --rm --init --network none tmt-office-check:local
docker image rm tmt-office-check:local
```

Choose an unused task-owned image tag; remove only that verification image.
This is not a deployment image or a browser/Firebase E2E claim.

For native-only fixtures, `pnpm --filter tmux-team install --frozen-lockfile`
installs only root dependencies; Docker copies workspace/package metadata before
this step. Do not make native fixture containers install or execute Office.
The workspace explicitly permits lifecycle scripts only for the existing
`better-sqlite3` oracle and esbuild tooling. Fresh oracle builds need Python,
make and a C++ compiler; the tmux fixture image supplies these build tools.

CI always reports `Code quality` and `Native package matrix`. A conservative
diff selector skips expensive native jobs only for Office-only paths, and skips
Office for native-source/skill-only paths. Shared/unknown paths run both. Code
quality includes the selector's own focused tests even when native unit jobs are
unselected, and requires the selected Office check. The native aggregator rejects
failed, cancelled or unexpectedly skipped selected jobs. CI changes need positive
and negative selection/gate evidence before pushing; do not change branch
protection merely to get a newly skipped job accepted.

For the separate Office Auth/Firestore environment, follow
[`services/office/README.md`](services/office/README.md). It uses Docker-contained
Java and Firebase tooling with a demo project; no host Firebase login is required
for emulator tests. Local real-project mappings and credentials must remain
ignored by both Git and Docker. Never substitute this bootstrap smoke proof for
future membership rules, invitation or browser tests.

### Local browser sign-in

Start the emulators as described above, then explicitly opt in:

```sh
pnpm office:dev --mode emulator
```

Open the loopback URL printed by Vite. Choose **Sign in with Google (emulator)**,
add a local test account in the popup and observe its UID. No real Google login,
Firebase owner alias or credentials are needed. Reload signs out; another tab
does not inherit the session. Default `office:dev` / `office:build` stays a
disconnected preview. Login does not create a world or grant access.
Console-managed tester admission gates direct Firestore world creation/read.
For explicit real Google sign-in and owner-local configuration, see
[the limited cloud pilot](services/office/README.md#limited-cloud-pilot).
Do not point automated tests at a real project.

Run the real-browser suite with the same emulator owner:

```sh
docker build --target browser-tests -f services/office/Dockerfile -t tmt-office-browser:local .
docker run --rm --init --shm-size=256m tmt-office-browser:local
```

The image installs pinned Chromium, checks the app, runs DOM/session tests and
builds preview, emulator and unconfigured cloud variants. The container starts
disposable Auth/Firestore/Functions emulators and three strict-port preview servers, then
Playwright. The cloud build must fail closed without operator configuration;
it never contacts a real project during automated tests.
It uses one worker, no retries, bounded waits and independent browser contexts.
Only failed-transaction assertions use the Firestore fixture's 20-second budget:
the pinned SDK's five attempts can spend 12.1875 seconds in jittered backoff
alone. Keep the ordinary 10-second UI expectation and 30-second scenario limits.
Those scenarios assert intercepted transaction reads and independent durable
state before and after explicit retry; a timeout alone is not transport evidence.
Auth responses are real and local. The suite also exercises the real Firestore
SDK against Rules: immutable creation/retry, cross-user denial, self-grant denial,
shape validation, and browser grant/create/revocation. The separate agent-grant
Rules suite adds custom-principal tokens, assigned UUID blocks, claim/capability
isolation, malformed/expired grants and one-way owner revocation with unchanged
cached tokens. `pairing-service.spec.ts` adds actual HTTP approval/custom-token
issuance, concurrent claims and live revocation. Direct service composition with
an injected signer adds failure/recovery evidence against the same real database.
Those service scenarios alone are not evidence of protected native storage or
CLI-to-browser pairing. Service-only scenarios can run with `--network none`
by overriding the image command to select that spec. Operator fixtures
also independently inspect saved block layouts. Home-block scenarios cover
revision races, exact retries, Rules/client conformance vectors, bounded list
validation, owner/device isolation and browser placement/save/reopen/revocation.
Desktop and narrow editor screenshots are written to Playwright test results
for primary visual review, not treated as automatic visual acceptance.
Operator fixture writes
use a hard-wired loopback demo-project bypass, never production credentials.
Google's official popup transport still loads
public JavaScript from `apis.google.com`, even in emulator mode. The browser
allowlist permits only those script GETs and loopback, blocks optional upstream
CDN styling, and fails for any other destination. This suite requires Internet
access for that library; it is not a fully offline OAuth test. No host
credentials/volumes or published ports are used. A failed browser test must
propagate through `emulators:exec`; do not count a skipped or empty suite as proof.
The selected Office CI job runs this same target. Native tmux E2E remains
separate. Remove the task-owned verification image when no longer needed.

`pairing-browser.spec.ts` proves real browser consent -> issuer approval ->
original-proof claim -> scoped block write -> cached-token denial after owner
revocation, plus same-request reopening, non-owner denial, lost-response retry
and logout during a pending confirmation. Inspect the actual approval POST body
as well as durable state; URL-only capture is not proof of a secret-free body.
The originating proof is a fixture, not a native CLI. DOM/state tests separately
cover admission/route fencing and explicit consent. Browser and service decoders
consume the same literal pairing corpus; browser encoding tests use an independent
Node encoder. Review desktop/narrow screenshots rather than accepting their
existence as visual proof.

`native-pairing.spec.ts` installs the real compiled CLI/companion through a
synthetic verified archive, using the existing `test/support` process and artifact
owners. It resumes a protected proof across CLI processes after Chromium consent,
then independently checks the issued grant, OS-store record, scoped Firestore
read, token refresh, expired server/native lease renewal, simulated lost-response readback,
unchanged resources, corruption, revocation and same-name replacement.
The browser target therefore builds Rust and installs the root test-helper
dependencies with scripts disabled; native helpers never enter the SPA. The
standalone app image stays independent.
`with-test-keyring.sh` owns a disposable D-Bus session and real Linux Secret Service
with a fixture-only password and private container directories. The scenario
deletes and verifies absence of its protected entry; container teardown removes
the disposable store. No host Keychain, credentials or installed CLI is used.
This is Linux credential-store evidence, not macOS runtime or real release-archive
acceptance. Reuse the separate native artifact verifier for published artifacts.

`native-hooks.spec.ts` adds the causal retirement path using a private real tmux
server and the container's `sqlite3` tool as an independent state observer.
Verify local retirement plus pending notification before any remote cleanup,
then disabled pairing/grant, retained block and denial of a previously usable
cached token. A missing session bus or vault entry must retain pending work.
An unknown pending proof stays retryable and later cancels a known approval
without claiming credentials or creating a grant. A test-only SQLite
acknowledgment trigger separates remote/vault success from local completion;
retry must consume the protected revoked receipt without restoring credentials.
Neither hook registration unit tests nor service-only revocation proves this
chain. Run the Office browser target and tmux lifecycle suite twice after changes
to these cleanup boundaries, with verified private-server/vault cleanup.

For focused service checks use `pnpm office:service:check`,
`pnpm office:service:test` and `pnpm office:service:build`. `pnpm check` also runs
the combined `@tmt/office type:check:e2e`; standalone `office:check` deliberately
does not load service dependencies through E2E fixtures. The Docker browser
target runs both package checks and this explicit E2E type check on Node 22.

For in-progress native deployment discovery, run
`cargo test --locked --workspace office_deployment` from `rust/` (or select
`-p tmt-adapters --features office office_deployment`). The optional Office feature
is not enabled by the native-only tmux fixture. These tests verify literal
browser/native descriptor conformance, strict URL/JSON validation and bounded
unauthenticated HTTP; they do not prove native pairing or protected credentials.
`deployment.spec.ts` checks the actual built emulator descriptor and unavailable
preview/cloud variants. Issuer scenarios independently compare claim
`grantExpiresAt` with Firestore, including retries and a shortened grant; approval
and token expiry must not stand in for that value.

## Personal-office milestone acceptance

`retained-spaces.spec.ts` proves owner discovery of a revoked grant, opening and
editing its retained UUID block through the shared editor, independent stored
state, unchanged home layout, reopening and admission loss. The grant Rules
suite independently checks bounded owner pagination and denies unbounded,
oversized, foreign-owner, agent and revoked-admission queries. Owner editing
does not by itself prove native block mutation, reassignment or credential recovery.

Retained-block reassignment adds actual competing approval transactions in
`pairing-reassignment.spec.ts`: one source reservation, exact retries, abandoned
unclaimed recovery and denial of claimed ancestors. Browser approval selects
the source explicitly and preserves assignment across uncertain responses.
The native acceptance must resume the original protected proof, inspect the
same retained block and corroborate it in the browser and independent database;
seeded grants or a browser-only claim do not substitute for that chain. Keep
the former cached credential's denial and unchanged layout as separate assertions.

The M1 acceptance target is a causal local flow: actual native CLI and Office
companion -> browser owner approval -> scoped credential use -> durable resource
change -> visible browser result. Use deterministic mock agents, isolated real
tmux where relevant, Playwright Chromium and demo-project Auth/Firestore
emulators. Extend the existing fixture owners as each feature ships, not a
parallel mock implementation of TMT. Independent database observations must
corroborate UI and command results. Separate green layer suites are not proof of
this integrated flow. The native pairing browser scenario covers acquisition and
scoped reads; native resource editing and visible browser results remain separate
milestone work, not implied by successful credential retention.

Automated acceptance must not call a paid model, use provider/host credentials,
contact production Firebase or require paid runners. Keep the native-only tmux
suite network-disabled. Office integration keeps service traffic inside its
isolated fixture; the browser popup's existing allowlisted Google script is an
explicit network exception, not permission for cloud data or model calls.
Use bounded readiness and polling, fail on empty/skipped acceptance, and verify
child/socket/buffer/state cleanup. Run lifecycle-sensitive local suites twice.

Cover approval, denial, expiry, duplicate/concurrent claims, wrong scope,
revocation with cached credentials, uncertain writes, reconnect, temporary
retirement and same-name replacement. Resource slices add revision conflicts,
profile/layout/notebook independence, board disclosure and installed-guidance
checks. Preserve real request/response and storage owners; no terminal-output
completion fallback or second memory store.

Run the complete applicable local gates before pushing the reviewed commit.
Record commands, results, exact commit, limitations and cleanup in its PR/issue.
Do not use repeated CI pushes for local debugging. Existing required CI gates
remain authoritative until a reviewed cost-policy change provides replacement
evidence and merge requirements; unselected jobs are not passing selected tests.
Do not activate paid runners, model APIs, billing or production deployment.

Real Google login, IAM, deployment and live-agent usability are separate owner-
authorized pilot checks. Request owner assistance when those checks are actually
ready. Emulator success does not prove production IAM or device credential
protection, and a live-agent demo does not replace deterministic regression tests.

## Rust checks

Run from `rust/` for a normal native change:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
cargo build --locked --example storage-probe
cargo build --locked --example tmux-probe
cargo +1.88.0 build --locked
```

Before native installation/process tests, build the two product fixtures
independently, after workspace checks:

```sh
CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked -p tmt-office
CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked -p tmt-cli
```

Workspace builds unify adapter features, so their debug CLI can include Office
dependency debug information. Package-scoped builds exercise the ordinary CLI
product without Office features. These fixtures omit debug symbols, not debug
assertions or runtime checks; installation tests should hash/package executable
behavior rather than large DWARF payloads. Keep the existing process deadlines
and assertions. Both binaries remain in `target/debug`, using the established
selectors. This does not replace optimized release-archive verification.

The architecture guard is included in `cargo test`. A focused offline run is:

```bash
cargo test --offline --locked --manifest-path /absolute/checkout/rust/Cargo.toml --test architecture
cargo +1.88.0 test --offline --locked --manifest-path /absolute/checkout/rust/Cargo.toml --test architecture
```

When changing a guard, exercise a real positive and negative source/dependency
fixture and restore the checkout exactly. A stale lockfile or an unexecuted
test is not evidence that the guard worked. Core must remain free of concrete
I/O; adapters own SQLite/files/processes; CLI owns grammar and composition.

## Native process and shared tests

### Selecting the CLI under test

The maintained JavaScript suites live under `test/native/`, `test/e2e/`,
`test/tooling/` and `test/support/`. Rust tests stay beside the owner in
`rust/crates/*`. The native process selector resolves the repository build at
`rust/target/debug/tmt` by default and fails if it is absent. An explicit
descriptor may select another absolute native executable; it must be
executable, and neither an installed host command nor Node is an allowed
fallback. Paths and argv are passed as data, never through shell fragments.

Build first, then explicitly select the test-only storage probe. The product CLI
uses its repository-native default; the probe is never an installed SQL command:

```bash
cargo build --locked --manifest-path rust/Cargo.toml
cargo build --locked --manifest-path rust/Cargo.toml --example storage-probe
TMT_TEST_STORAGE_PROBE='{"executable":"/absolute/checkout/rust/target/debug/examples/storage-probe","args":[]}' \
  pnpm test:native
```

For a deliberate explicit selection or a task-owned moved binary:

```bash
TMT_TEST_CLI='{"executable":"/absolute/checkout/rust/target/debug/tmt","args":[]}' \
TMT_TEST_STORAGE_PROBE='{"executable":"/absolute/checkout/rust/target/debug/examples/storage-probe","args":[]}' \
  pnpm test:native
```

The suite covers grammar, configuration-before-effects, identity and binding
lifecycle, role/preamble, response/receipts, exchanges/attention, talk,
managed skills and native installation. It uses bounded process budgets,
task-owned files and independent SQL/schema oracles. Frozen migration fixtures
and provenance under `test/fixtures/storage-history/` are immutable evidence;
do not generate expected data with the implementation under test.

The tooling unit suite is independent developer-tool coverage. Its denominator
must contain no deleted TypeScript source and must not present Rust as a
cross-language percentage. Run focused tooling tests with:

```bash
pnpm exec vitest run test/tooling
```

Native process tests must prove the missing-native negative control and selected
native positive control. Child processes are finite, are stopped and reaped
before fixture deletion, and receive signals only when they are task-owned.
Tests never use host tmux, global provider state, or process-wide environment
mutation as setup.

Use `withSandbox` for callback-owned native fixtures. Its descriptor clones
share active runs; disposal stops outstanding commands before deleting files
and rejects later launches. Each run has its execution deadline plus at most
one second to confirm direct close and process-group exit. Unconfirmed cleanup
fails and reports the retained fixture path instead of deleting potentially
live state. Focused lifecycle regressions live in `test/tooling/cli-process.test.ts`;
they use explicit Node fixtures, not a product-runtime fallback.

## Docker E2E

Run the full private tmux/caller lifecycle harness twice for lifecycle,
transport, identity, talk, or cleanup changes:

```bash
pnpm test:e2e
pnpm test:e2e
```

The harness builds its pinned image, uses `--network none`, private tmux
sockets and deterministic mock agents, and selects the Docker-built native
executable. It must not connect to a host tmux server or a real agent. The
wrapper's `--init` behavior is part of orphan-child cleanup evidence.
The image puts its selected dev/release binary at `rust/target/debug/tmt` inside
the fixture and leaves the shared selector unset. This exercises the same
default path as a developer checkout, including nested replies; explicit test
descriptors still override it. There is no second default executable owner.

### Scenario ownership

Name Docker scenarios for the behavior or adapter they verify, not a retired
implementation language. All public-command scenarios already use Rust.
Keep these boundaries when choosing where a regression belongs:

| E2E file(s)                                                    | Distinct evidence                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `binding-reconciliation`                                       | Publication races, uncertain endpoint evidence, scoped/global discovery, binding transitions and live listing presentation            |
| `durable-identity`, `identity-lifecycle`, `identity-retention` | Stored identity/profile continuity, pane/server lifecycle and retirement consequences                                                 |
| `check-routing` versus `capture-limits`                        | Real target/server resolution and capture failures versus numeric/configuration bounds                                                |
| `profile-binding` versus `role-lifecycle`                      | Verified caller/retired-name ownership versus restart, file input, validation and concurrent writes                                   |
| `talk-completion` versus `durable-talk`                        | Observer interruption, output/attribution and uncertain delivery versus inline input, size bounds, concurrency and submission retries |
| `exchange-watermarks` versus `exchange-attention`              | Gated revision/watermark state and exact late finals versus config isolation, redaction and rebind access                             |
| `tmux-adapter`, `transport-adapter`                            | Explicit adapter-probe evidence: caller/inventory/markers and delivery/capture stages; not public CLI success                         |
| `pane-badge`                                                   | Default-off behavior, opt-in updates, theme preservation, rendering, conflicts and cleanup                                            |
| `executable-selection`, `smoke`                                | Harness selection, causal nested replies, startup and cleanup controls                                                                |

Similar commands do not imply duplicate evidence: native-process tests inspect
the executable's public contracts and independent stored state, while Docker
adds real tmux/process ordering. Consolidate only after mapping setup, causal
action, assertions and failure/cleanup observations. The redundant basic badge
case formerly in the binding suite is owned by the stronger `pane-badge` cases;
do not add another copy there.

`test/e2e/cli-assertions.ts` owns `expectJsonResult` for the E2E result shape.
It checks the success envelope and returns the same parsed value; it does not
validate domain fields. Scenarios retain their exact/partial payload assertions
and independent SQL oracles. Helpers with a different stderr or parse contract
remain local. Do not combine partial identity views into a permissive shared
schema or import product types to manufacture expected results.

Shared cross-suite utilities belong in `test/support/`; suite-only harness,
assertions and observers stay with their suite. Focused helper tests belong in
`test/tooling/` and must prove rejection as well as positive behavior.

For ordinary developer checks, run:

```bash
pnpm check
pnpm test:run
```

`pnpm check` is the common quality entrypoint for all retained tooling, including
E2E. For focused work use `pnpm type:check`, `pnpm lint` or
`pnpm format:check`; the old duplicate `e2e:*` quality aliases are removed.
`pnpm test:e2e` remains the actual Docker scenario runner.

The first command checks TypeScript types and lint/format for retained tooling
and docs; the second runs tooling behavior and source-boundary tests. Neither
replace the Rust commands, native process suite or Docker runs.

## Runtime smoke matrix

The six required native smoke environments are:

- macOS x64 and macOS arm64;
- Linux glibc x64 and Linux glibc arm64;
- Linux musl x64 and Linux musl arm64.

CI builds four raw targets once (the two macOS targets and two static Linux musl
targets) and reuses the matching static musl executable for both Linux smoke
environments. Preserve the `Packed install (<environment>)` check names and
`Native package matrix` final aggregator; those names retain historical CI
compatibility, while their
steps are real native runtime checks rather than npm package checks. Each smoke
runs outside the checkout with isolated HOME/state, no Node or Rust on the
product PATH, and checks version/help, exact embedded skill bytes, managed skill installation and
SQLite reopen/persistence. Cross-compilation alone is never claimed as runtime
evidence.

The same distinction applies to release artifacts: raw PR executables prove
source-runtime behavior only. They do not prove archive inventory, notices,
checksums or bootstrap behavior. Linkage is checked in both raw and archive proof.

## Native release verification

For archive, installer, upgrade, bootstrap or publication changes, read the
complete [native release verification guide](docs/native-release-verification.md)
before acting. It owns the exact commands, actual-archive evidence and authorized
publication gates. Ordinary changes do not need to load release-only procedures.
The runtime smoke matrix above remains part of native PR verification; raw
executables are not proof of release archives or public installation.

## Installed guidance source ownership

`skills/tmux-team/SKILL.md` is the only installed guidance source. Verify exact
embedded bytes, managed links, repeat no-op, backup/conflict behavior, lock
ownership and no effects on application configuration, SQLite or tmux. Follow
`USER-GUIDE.md` and `skills/README.md` for provider/custom-root usage; do not add
provider-specific skill copies. Runtime/linkage proof shared by archive and raw
verification lives in `scripts/native-runtime-proof.mjs`.

## Review and evidence

Before handoff, report the changed owner and run the smallest relevant focused
tests, then the complete gates required by the issue:

1. `pnpm check` and retained tooling tests;
2. Rust fmt, clippy, locked tests, build and MSRV build;
3. the complete native process suite, plus the tooling
   selector's missing-native negative and selected-native positive controls;
4. two complete Docker E2E runs for lifecycle/transport changes;
5. available real-host smoke environments, with remaining architecture coverage
   left to the required CI matrix;
6. matching-host artifact/bootstrap proofs for release changes.

Do not turn a filtered, skipped, cross-compiled, or failed subprocess into a
success claim. Preserve exact bytes and independent oracles. Keep returned
errors distinct from crash recovery, and retain uncertainty, transaction,
retention, acknowledgment, lifetime and cleanup evidence when changing those
boundaries.

## Test design rules

- Prefer structured JSON/status assertions over terminal wording.
- Read files from isolated roots and compare exact bytes; do not snapshot
  symlink directories or enumerate large binaries byte-by-byte.
- Keep positive controls for every negative guard and assert the causal error,
  not an arbitrary nonzero exit.
- Do not mock `console.log`; use structured output or a focused formatter test.
- Add no global process state, host installation, network endpoint, tmux server,
  memory/MCP behavior or new release catalog to make a test convenient.

Update [ARCHITECTURE.md](ARCHITECTURE.md) in the same change when an owner,
trust boundary, resource lifecycle, public command, storage schema, test gate or
release procedure changes. Historical TypeScript source maps and npm-pack
runtime probes are retired evidence, not maintained commands.
