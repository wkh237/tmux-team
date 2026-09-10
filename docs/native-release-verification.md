# Native release verification

Task-specific contributor reference extracted from DEVELOPMENT.md. Run commands
from the repository root unless stated otherwise. Read this entire guide for
archive, installer, upgrade, bootstrap or publication work; ordinary Office and
CLI changes use the focused checks in [Development](../DEVELOPMENT.md).
This is verification guidance, not publication authorization.

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

The internal `--product office` selector uses the same offline verifier/publisher
for a `tmt-office` package and executable. Omission selects the CLI unchanged.
Office installs under `lib/tmt-office` with only `bin/tmt-office`; it must not
modify CLI links, receipts, application state or managed skills. Verify coexistence,
cross-product rejection and interruption in isolated prefixes. Copied CLI binaries
in synthetic Office test archives prove installation behavior only, not an actual
Office companion, protocol compatibility or public distribution. The native
process suite now separately copies the compiled `tmt-office` into synthetic
archives and exercises its exact versioned probe. Build the workspace first;
a missing companion is an error, never a fallback to the CLI. This additional
evidence does not replace real cargo-dist archive and distribution acceptance.

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
