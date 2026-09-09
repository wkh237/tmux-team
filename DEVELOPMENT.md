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
disconnected preview. Login does not create a world or grant membership.

Run the real-browser suite with the same emulator owner:

```sh
docker build --target browser-tests -f services/office/Dockerfile -t tmt-office-browser:local .
docker run --rm --init --shm-size=256m tmt-office-browser:local
```

The image installs pinned Chromium, checks the app, runs DOM/session tests and
builds both preview and emulator variants. The container starts disposable
Auth/Firestore emulators and two strict-port preview servers, then Playwright.
It uses one worker, no retries, bounded waits and independent browser contexts.
Auth responses are real and local. Google's official popup transport still loads
public JavaScript from `apis.google.com`, even in emulator mode. The browser
allowlist permits only those script GETs and loopback, blocks optional upstream
CDN styling, and fails for any other destination. This suite requires Internet
access for that library; it is not a fully offline OAuth test. No host
credentials/volumes or published ports are used. A failed browser test must
propagate through `emulators:exec`; do not count a skipped or empty suite as proof.
The selected Office CI job runs this same target. Native tmux E2E remains
separate. Remove the task-owned verification image when no longer needed.

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

## Native Rust release archives

### Explicit multi-platform release preparation

`Native release artifacts` (`.github/workflows/native-release.yml`) is manually
dispatched, not part of every PR. Dispatch on the authorized release's reviewed,
required-checks-green main commit and record the run ID and exact SHA in its
issue. It builds on native macOS arm64/x64 and Linux arm64/x64 hosts using the
existing pinned tools and `build-native-artifact.sh`. A shared matrix keeps
build and final verification hosts aligned; dispatches outside main are skipped.
Cached packaging tools are keyed
by OS, architecture and exact tool versions; they are developer tools only.

cargo-dist itself merges the downloaded `*-dist-manifest.json` inputs through
`dist build --artifacts global --output-format=json --no-local-paths`. Do not
hand-merge artifact JSON or enable another installer. Generate a complete
`dist plan` on the same source and pass it as bootstrap `--plan`: the generator
requires exact planned archive names/targets, preventing a missing matrix target
from silently shrinking the release. Bootstrap generation verifies TMT ownership
and archive inventory/digests before generating code; the final matrix
then executes both existing verifiers against this final manifest and compares
the regenerated script bytes. All jobs must pass before publication, even if
the assembled artifact can already be downloaded. CI artifacts expire in seven
days. Notices alongside the bundle are verification inputs; each archive also
contains its own target-filtered notices.

Publication remains a separately authorized operation, not a workflow side
effect. Verify the run's exact commit and all required PR checks; enable GitHub
release immutability before creating a draft prerelease. Attach the four tar.gz
archives, final `dist-manifest.json` and `tmt-installer.sh`, verify their uploaded
SHA-256 digests and only then publish the draft. Verify `immutable: true`, tag
commit and GitHub release attestation (`gh release verify` and
`gh release verify-asset`). Never replace an immutable release's assets or move
its tag. A repair needs a new reviewed version.

Before promoting README installation instructions, run the actual public script
with an isolated HOME, application root and prefix, verify version, exact skill,
PATH selection and `tmt upgrade --json` against live immutable metadata. Do not
mutate a host installation. Record this separately from controlled-curl fixture
evidence. npm publication is not part of native GitHub release publication.

The PR smoke matrix verifies raw native runtimes, not release archives.
#135 introduced archive generation; later slices delivered installation.
The target inventory and artifact metadata live in `dist-workspace.toml` and
the generated cargo-dist manifest, not another TMT release catalog.

Install the pinned developer tools into a chosen tool directory (not needed by
end users): cargo-dist 0.32.0 with `cargo install --locked`, and cargo-about
0.9.2 with `cargo install --locked --features cli`. Put their binaries on PATH.
Fetch the locked workspace dependencies before the offline notice step.
Build targets sequentially in one checkout, or use separate worktrees: the
generator's distribution directory and generated notice input are per-checkout.

```sh
# Choose a target from dist-workspace.toml that matches the verification host.
native_manifest=$(mktemp)
MACOSX_DEPLOYMENT_TARGET=11.0 scripts/build-native-artifact.sh aarch64-apple-darwin > "$native_manifest"
node scripts/verify-native-artifact.mjs \
  --manifest "$native_manifest" \
  --archive target/distrib/tmt-cli-aarch64-apple-darwin.tar.gz \
  --target aarch64-apple-darwin --skill skills/tmux-team/SKILL.md \
  --notices rust/target/native-notices/THIRD-PARTY-NOTICES.txt --license LICENSE
```

Review the generated `rust/target/native-notices/THIRD-PARTY-NOTICES.txt` against
the locked, archive-target-filtered runtime graph, including Unicode copyrights;
the verifier compares the archived notices and license with these selected
inputs and rejects placeholder attribution. A successful generator
is not legal certification. Keep the complete notice text with redistributed
binaries. The verifier bounds inputs (64 MiB compressed, 128 MiB expanded),
requires exactly the four runtime files, and removes its private staging after
success or failure. It runs the extracted executable with no Node/Rust/tmux on
PATH and verifies native SQLite persistence through public commands. macOS
requires system `otool`; Linux requires `readelf` for static-musl linkage checks.

`test/native/artifact.Dockerfile` provides a local matching-architecture Linux
musl build and verifier. Set `TARGET_TRIPLE` from the selected generator target,
give the image a task-owned name, then run it with `--rm --init --network none`
and `--archive artifacts/<manifest archive name> --target <target>`. Remove that
owned image after verification. Emulated execution and cross-compilation alone
do not satisfy native target acceptance. This optional image is not the tmux
E2E harness or a publication workflow.

Negative archive tests use real tar fixtures and causal guard assertions.
Exercise checksum corruption, truncation, missing executable/notices, links,
unexpected paths, duplicates, bounds and cleanup; never accept any arbitrary
process error as proof of the intended check. Inspect exact manifest and archive
bytes from the final source before running the reviewed CI candidate.

## Offline native installer verification

### Native update verification

`tmt upgrade [--channel stable|alpha] [--to <version> | --unpin] [--json]`
and `tmt update` share one grammar and implementation. Use task-owned managed
prefixes, never a user's installed command or app data. The invoking executable
must be the active release; an unmanaged checkout binary fails before networking.
Production has no test endpoint or TLS bypass. API fixtures inject only the
adapter's acquisition boundary; actual local TLS fixtures use test-only trust.
Test old/new real release archives separately from synthetic tar fixtures, with
different embedded skills, to prove the newly active executable supplies refresh.

Check pinned no-network behavior, explicit pin/unpin, unchanged release identity,
preserved old bytes, missing/mutable release rejection, dual digest checks,
same-version integrity and concurrent pin fencing. Cancellation and finalization
tests must inspect active receipts and surviving executables, not only exit codes.
After activation, skill failures retain a partial report and nonzero status;
malformed/nonzero/oversized/timed-out child output is never a success. The existing
process runner retains bounded output only for completed nonzero exits and never
prints it implicitly. Verify both byte preservation and task-owned cleanup.

The synchronous HTTPS dependency is pinned ureq 3.4.0 (MIT/Apache-2.0, upstream
MSRV 1.85), selected without an async runtime or curl fallback. The lockfile and
workspace MSRV 1.88 remain authoritative for the complete graph. rustls and
platform-verifier use native trust and library proxy environment behavior.
Runtime attribution includes ISC crypto and CDLA-Permissive-2.0 certificate data;
generate target-filtered notices through cargo-about and retain complete texts.
rcgen/rustls local-server fixtures are dev-only, not production endpoint options.

The explicit actual-archive acceptance test requires separately versioned,
matching-host cargo-dist artifacts with different embedded skills. It is ignored
by ordinary tests, not counted as release proof until selected and passed:

```sh
TMT_UPGRADE_OLD_ARCHIVE=/absolute/old/archive.tar.gz \
TMT_UPGRADE_OLD_MANIFEST=/absolute/old/manifest.json \
TMT_UPGRADE_NEW_ARCHIVE=/absolute/new/archive.tar.gz \
TMT_UPGRADE_NEW_MANIFEST=/absolute/new/manifest.json \
TMT_UPGRADE_TARGET=aarch64-apple-darwin \
cargo test --locked --manifest-path rust/Cargo.toml -p tmt-adapters \
  cargo_dist_upgrade_refreshes_real_artifacts_and_preserves_conflicts -- --ignored
```

Require one selected passing test, not an empty filtered run. This test injects
canonical acquisition responses but executes real old/new binaries, managed
skill installation, partial hidden refresh and repair in scrubbed task-owned
state. It does not claim to contact a public release or exercise the public CLI
over a fake production endpoint. Run the independent artifact verifier too.

### Offline composition

The internal entrypoint consumes a local cargo-dist archive and manifest. It is
not advertised by help/completion and does not change `tmt install` skill syntax.
Use a task-owned prefix and matching host archive, never an existing user install:

```sh
native_prefix=$(mktemp -d)
rust/target/debug/tmt __native-install \
  --archive target/distrib/tmt-cli-aarch64-apple-darwin.tar.gz \
  --manifest "$native_manifest" --prefix "$native_prefix" --channel alpha --json
"$native_prefix/bin/tmt" --version
```

`--pin` pins the selected candidate, `--unpin` clears an existing pin, and omission
preserves its state. Neither authorizes a downgrade. Repeated exact artifacts are
no-ops after ownership validation; metadata-only changes activate a new receipt
with the same payload. Receipts record local-archive provenance, not authenticated
public release provenance. Keep application state isolated separately when running
identity/profile commands; installing the executable must not open a database.

Native adapter tests cover bounded archive acquisition and publication failures;
native process contracts use the existing executable selector and sandbox. Test
current/receipt tampering, manager collisions, pin changes, interrupted staging,
lock contention, missing command-link repair and retained previous releases.
Assert surviving bytes and cleanup, not merely a failed exit. Tests comparing
large executable buffers must use exact `Buffer.equals`
checks rather than structural object matchers: enumerating every byte can exhaust
the test runner's heap on debug binaries. Verify the comparator detects a changed
byte; do not replace byte equality with a size-only assertion or raise CI memory
limits to hide assertion overhead. Installation cases also use an explicit
15-second subprocess budget for debug
archive hashing/decompression and durable publication, distinct from the ordinary
CLI's five-second test budget and each scenario's 60-second cap. Keep ordinary
command and production timeout policies unchanged; validate installation budgets
under constrained local resources rather than treating CI as a timing probe.
Synthetic filesystem
fixtures are not proof of runnable release artifacts: retain separate actual
cargo-dist archive execution and target/linkage/notice evidence. Run the shared
skill-installation regressions when changing shared file locks or content digests.

For actual old-to-new acceptance, build two separately versioned cargo-dist
archives in task-owned source copies. Do not alter the repository release version
or publish fixtures merely to test updates. The newer archive must contain the
offline installer; the older artifact must run its real reported version. Verify
each archive's notices/linkage with the artifact verifier above, then run:

```sh
node scripts/verify-native-installation.mjs \
  --previous-archive "$previous_archive" --previous-manifest "$previous_manifest" \
  --archive "$next_archive" --manifest "$next_manifest" \
  --target aarch64-apple-darwin --skill skills/tmux-team/SKILL.md
```

This reuses the bounded packed-command runner and independent archive verifier.
It checks exact old/new versions with no runtime PATH, pinned rejection, explicit
unpin advancement, a retained executable, no-op and downgrade rejection, exact
embedded skill and unchanged SQLite bytes during installation. Its temporary
prefix/application state is always invocation-owned and removed afterward.

## Native curl bootstrap verification

Generate the release-specific script only after final cargo-dist archives and
their independent runtime verification. All selected archives must be present;
the manifest, not a hand-maintained version table, owns the generated facts:

```sh
node scripts/generate-native-bootstrap.mjs \
  --manifest /absolute/dist-manifest.json --archive-dir /absolute/artifacts \
  > /absolute/artifacts/tmt-installer.sh
sh -n /absolute/artifacts/tmt-installer.sh
node scripts/verify-native-bootstrap.mjs \
  --manifest /absolute/dist-manifest.json \
  --archive /absolute/artifacts/tmt-cli-aarch64-apple-darwin.tar.gz \
  --target aarch64-apple-darwin --skill skills/tmux-team/SKILL.md
```

The last command requires actual matching-host release artifacts, uses isolated
HOME/state/PATH, real shell utilities and the new native executable. Only curl
acquisition is replaced with task-owned fixture copies; production has no test
endpoint. It checks repeat/no-op, explicit pin followed by no-network upgrade,
exact installed skill bytes, old npm command preservation, PATH warning and
temporary cleanup. It is not live GitHub download or cross-target evidence.

The existing `test/native/artifact.Dockerfile` also carries this verifier. After
building its task-owned matching-architecture image, run the normal artifact
entrypoint, then repeat with `--entrypoint node` and
`scripts/verify-native-bootstrap.mjs --manifest native-manifest.json --archive
artifacts/<archive-name> --target <target> --skill expected-skill.md`. Keep
`--rm --init --network none` and remove only the task-owned image afterwards.

`test/tooling/native-bootstrap.test.ts` covers the generated shell's negative paths with
the existing bounded CLI sandbox and a synthetic executable for orchestration.
Do not count that stub as native publication evidence; pair it with the actual
artifact verifier. Run `pnpm check`, unit tests and two Docker lifecycle passes
before the reviewed CI candidate. Keep generated outputs out of source control.
No new runtime dependency, data migration or public publication is authorized
by generation. An authorized release must upload the exact verified manifest,
archives and generated script, establish immutable release/provenance evidence,
and verify the public download before the README advertises it as available.

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
3. the complete native process suite (149 cases at cutover), plus the tooling
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
