# Native release verification

Commands and gotchas for archive, installer, upgrade, bootstrap and publication work.
Policy and authorization live in [SKILL.md](../SKILL.md): verification is never
publication authorization, and ordinary changes use the focused checks in
[DEVELOPMENT.md](../../../../DEVELOPMENT.md). Run from the repository root unless
stated. Raw runtime proof is in the
[smoke matrix](../../tmt-e2e/reference/runtime-smoke-matrix.md); raw executables do not
prove archives or public installation.

## Tooling prerequisites

`release-please-config.json` is generated, never hand-edited. After changing the
component map, a crate's version declaration, the workspace crates or their
dependencies (including a new file or directory under an extension root, because the
CLI's exclude list is written from tracked files), run
`node typescript/scripts/release-please-config.mjs --write`; the
`release-please-config` tooling test and `--check` fail while it is stale. The pinned
release-please CLI lives in `.github/release-please/` (exact version and an integrity
hash per locked package). Before any local tooling check or release-config test:

```bash
pnpm --dir .github/release-please install --frozen-lockfile --ignore-scripts
```

`pnpm check:tooling` stops with this command when the install is missing and never
installs itself. Private leaves declare `releaseConsumers` in the component map; the
generator requires a private component with that consumer for every external
production workspace dependency of a declared consumer (including transitive links),
and fails naming the leaf and consumer. Upgrading release-please must re-verify the
wrapper's API shape and run
`pnpm exec vp test run --config vitest.config.ts test/tooling/release-please-config.test.ts`
from `typescript/`.

`.github/actions/apt-install` retries `apt` at most three times (120 s per attempt, 5 s
and 10 s backoff); revisit the bound before adding large packages.

## Release-cut shadow

`release-cut.yml` runs on main pushes and daily, posts each component's cut, next tag,
notes, SHA membership and skip reason in the run summary and uploads
`release-cut-metadata` and `release-cut-shadow-plan`. Unavailable draft visibility,
pagination, tag history or native-run identity is a blocked plan, never "no work".
`release-version-injection.yml` runs CLI and Squad on all four hosts; a failure in its
version/source/lock gate is a failure, not permission to widen the allowed diff
(`--no-deps` metadata cannot establish the stale-lock gate). Fixture checks:

```bash
(cd rust && cargo build --locked -p tmt-test-support --example release-version && cargo test --locked -p tmt-test-support --example release-version)
(cd typescript && corepack pnpm exec vp test run --config vitest.config.ts test/tooling/release-cut.test.ts test/tooling/release-version-injection.test.ts test/tooling/ci-scope.test.ts test/tooling/release-workflow.test.ts test/tooling/repository-layout.test.ts)
(cd typescript && corepack pnpm check:tooling)
actionlint .github/workflows/release-cut.yml .github/workflows/release-version-injection.yml .github/workflows/native-release.yml
```

`typescript/test/fixtures/release-cut-history.json` is immutable comparison input from
published release records and Git objects; regeneration must verify the public tag equals
the release PR's merge commit. Explain an ownership change against the component map, not
generated-config exclusions. A local native spike builds the `release-version` example
first, then `release-version-injection.mjs prepare <checkout> <snapshot-outside-checkout>
<product> <tag>`, the full stale-lock probe and offline lock update, `verify <checkout>
<snapshot>`, and after the native build `artifact <checkout> <snapshot> <plan.json>
<build.json> <extracted-binary>`; run `verify` again after packaging. The checkout must
start clean at its captured SHA; never commit injected versions or replace a release/tag.

## Per-product release runs

`native-release.yml` is the per-product run (`cli`, `squad`, `driver-herdr`, `colab` are
selectable). Default `prepare` builds and verifies one bundle from the current main commit
without a draft; dispatch each authorized product on the reviewed, required-checks-green
main commit and record product, run ID and SHA in its issue. With `prepare` off the run
plans the product's drafts that carry neither a verified bundle nor a failure record,
oldest first. Parked components (`release: false`) allow neither a draft nor publication.

- A draft with `release-publication.json` has a complete bundle (uploaded last, after
  every verifier passed and digests matched); `verification-failed.json` parks it (retry
  with `prepare` off and `retry=<tag>`, or delete the draft); `publication-held.json` records
  a failed gate. `retry`, `hold` and `rerun` are mutually exclusive; a `rerun=<tag>`
  re-proves all gates and needs owner authorization (see SKILL.md).
- cargo-dist merges the manifests (`dist build --artifacts global --output-format=json
--no-local-paths`); never hand-merge artifact JSON. For the CLI pass a complete `dist plan`
  as bootstrap `--plan` so a missing matrix target cannot shrink the release.
- Each product has one queued run group `release-<product>` (the pending run is replaced);
  concurrency is keyed by tag. Artifacts expire after seven days.
- Release uses a `release` Environment limited to `main` with `RELEASE_APP_ID` and
  `RELEASE_APP_PRIVATE_KEY` as Environment (not repository) secrets; without them a push is
  a dry run and a manual live run fails instead of falling back.
- Fixture-only verification (no dispatch or Docker):

```bash
(cd typescript && corepack pnpm exec vp test run --config vitest.config.ts test/tooling/plan-release-builds.test.ts test/tooling/publication-gates-script.test.ts test/tooling/release-upgrade.test.ts test/tooling/release-workflow.test.ts test/tooling/release-publish.test.ts test/tooling/verify-public-install.test.ts test/tooling/release-stall.test.ts test/tooling/xcrun-warmup.test.ts test/tooling/intel-verification.test.ts test/tooling/repository-layout.test.ts)
(cd typescript && corepack pnpm check:tooling)
actionlint .github/workflows/native-release.yml .github/workflows/native-release-bundle.yml .github/workflows/native-release-upgrade.yml .github/workflows/native-release-smoke.yml .github/workflows/public-install-smoke-pr.yml .github/workflows/native-intel.yml
```

Publication gates, in order: `channel` (alpha only), `commit` (on main, PR passed `Code
quality`, `Unit tests`, `Docker E2E`, `Native package matrix`), `immutability`, `monotonic`,
`migration` (no `!`/`BREAKING CHANGE:`; outside alpha the component's migration list must
not grow), `upgrade`. A failed gate holds the draft with `publication-held.json`; it is not
a failed build. Gate-evaluating jobs hold the write token and run `main`'s code, reading the
release commit only as data.

After publication the `published` job reads the release back (public, `immutable: true`,
policy flags, tag on the release commit, `release-publication.json`, `gh release verify` and
`verify-asset` for every asset, retried about two minutes), then `smoke` installs it as a
user would (`native-release-smoke.yml`, also run by hand with `product` and `tag`). Failure
opens an issue; nothing is rolled back, because a published release is immutable and a repair
needs a new reviewed version. Smoke acquisition errors (including exhausted rate limits) are
failed checks with no retry; `GITHUB_TOKEN` reaches only `api.github.com`.

**Manual publication.** Verify the product run's exact commit and required PR checks and
enable release immutability before creating the draft. Create it with the `flags` from the
bundle's `release-publication.json` (`gh release create <tag> --draft <flags> ...`), verify
uploaded SHA-256 digests, `immutable: true`, the tag commit and attestation, then run
`node typescript/scripts/release-policy.mjs --check-latest "$(gh api repos/pj-tmt/tmt/releases/latest --jq .tag_name)"`.
A CLI release is the repository's latest (`--latest=true`) and attaches four tar.gz archives,
`dist-manifest.json`, `tmt-installer.sh` and the byte-identical `install.sh`; extension and
driver releases keep `--prerelease --latest=false` under `tmt-<product>-v<version>` tags
(driver tags never `v*`). Never combine product manifests, replace an immutable release's
assets or move its tag.

## Building and verifying archives

Install the pinned tools into a chosen directory: cargo-dist 0.32.0 (`cargo install --locked`)
and cargo-about 0.9.2 (`cargo install --locked --features cli`). Fetch locked dependencies
before the offline notice step. The taffy license clarification in `rust/about.toml` resolves
to `rust/licenses/taffy-0.7.7/LICENSE.md`; the builder fails if its bytes or the locked taffy
version change (review the clarification on a taffy upgrade). Select the CLI explicitly with
`--tag v<CLI-version>` for direct `dist plan`/`dist build` calls. Build targets sequentially in
one checkout (distribution directory and notice input are per checkout), retaining each
manifest, archive and notices before the next build:

```sh
scripts/build-native-artifact.sh --notices-only aarch64-apple-darwin squad     # notices only; not archive proof
native_manifest=$(mktemp)
MACOSX_DEPLOYMENT_TARGET=11.0 scripts/build-native-artifact.sh aarch64-apple-darwin > "$native_manifest"
node typescript/scripts/verify-native-artifact.mjs --manifest "$native_manifest" \
  --archive target/distrib/tmt-cli-aarch64-apple-darwin.tar.gz --target aarch64-apple-darwin \
  --skill skills/tmux-team/SKILL.md --notices rust/target/native-notices/THIRD-PARTY-NOTICES.txt --license LICENSE
```

The verifier bounds inputs (64 MiB compressed, 128 MiB expanded), requires exactly the four
runtime files, runs the extracted executable with no Node/Rust/tmux on `PATH` and checks
SQLite persistence; macOS needs `otool` and `lipo` through `xcrun` (10 s bound), so every
workflow job that runs it on macOS first runs `.github/actions/warm-xcrun` (a guard test
fails otherwise); Linux needs `readelf`. A generated notice file is not legal certification.
`typescript/test/native/artifact.Dockerfile` builds a matching-architecture Linux musl image
(`TARGET_TRIPLE`, optional `--build-arg PRODUCT=<product>`, task-owned name, run with
`--rm --init --network none`); remove that image afterwards.

Negative archive tests use real tar fixtures: exercise checksum corruption, truncation,
missing executable/notices, links, unexpected paths, duplicates, bounds and cleanup, never
accepting an arbitrary process error as proof. The hard-link fixture uses synchronous tar
construction (the async packer's link queue can hang) and must assert a real `Link` entry.
Compare large executable buffers with `Buffer.equals`, not structural matchers (heap
exhaustion), and verify the comparator detects a changed byte. Installation cases use an
explicit 15 s subprocess budget for debug archive hashing.

### Squad archives

A Squad archive adds `skills/` copied from `extensions/tmt-squad/skills/` through the
package's cargo-dist `include` (a package list replaces the workspace list, so it repeats
the shared files); the installer inventories it from the checksum-verified archive.

```sh
scripts/build-native-artifact.sh aarch64-apple-darwin squad > /absolute/squad-manifest.json
node typescript/scripts/verify-native-artifact.mjs --product squad --manifest /absolute/squad-manifest.json \
  --archive target/distrib/tmt-squad-aarch64-apple-darwin.tar.gz --target aarch64-apple-darwin \
  --skills extensions/tmt-squad/skills \
  --notices rust/target/native-notices/THIRD-PARTY-NOTICES.txt --license LICENSE
```

Runtime proof runs `tmt-squad --version` and checks `tmt-squad skill show` prints the archived
`SKILL.md`, leaving an empty HOME and config. Then `tmt extension install squad --archive
<archive> --manifest <manifest> --prefix <task-owned-prefix> --channel alpha --yes`, a repeat
install and `tmt extension uninstall squad`.

### Herdr driver archives

`driver-herdr` is `release: false` in the component map and `dist = false` in its Cargo package
until the release cut (#1399) activates both for its first standalone release; the CLI archive
keeps shipping its binary until then. Build independently (no `tmt` build):

```sh
scripts/build-native-artifact.sh aarch64-apple-darwin driver-herdr > /absolute/driver-manifest.json
node typescript/scripts/verify-native-artifact.mjs --product driver-herdr --manifest /absolute/driver-manifest.json \
  --archive target/distrib/tmt-driver-herdr-aarch64-apple-darwin.tar.gz --target aarch64-apple-darwin \
  --notices rust/target/native-notices/THIRD-PARTY-NOTICES.txt --license LICENSE
node typescript/scripts/verify-native-driver-upgrade.mjs --product driver-herdr \
  --archive /absolute/new/tmt-driver-herdr-aarch64-apple-darwin.tar.gz --manifest /absolute/new/dist-manifest.json \
  --previous-archive /absolute/old/tmt-driver-herdr-aarch64-apple-darwin.tar.gz --previous-manifest /absolute/old/dist-manifest.json \
  --driver-archive /absolute/cli/tmt-cli-aarch64-apple-darwin.tar.gz --driver-manifest /absolute/cli/dist-manifest.json --target aarch64-apple-darwin
```

Build each version in task-owned source copies; never rewrite the implementation checkout or
share a Rust target directory. The standalone proof executes protocol capabilities with no
application state.

## Upgrade and installer verification

`tmt upgrade [--channel stable|alpha] [--to <version> | --unpin] [--json]` and `tmt update`
share one grammar. Use task-owned managed prefixes; an unmanaged checkout binary fails before
networking. Production has no test endpoint or TLS bypass: API fixtures inject only the
adapter's acquisition boundary and local TLS fixtures use test-only trust. Verify channel
discovery with injected responses only (more than 1,000 refs without a Link, complete
pagination, numeric alpha ordering, stable/alpha/beta/rc separation, tags without releases,
malformed or cross-endpoint pagination, page/byte/request exhaustion) and assert the
two-request common case and no release/asset request before complete ref discovery.
Incomplete discovery fails with `Release discovery exceeds its bound; select an exact version
with --to.` (`NATIVE_UPGRADE_FAILED`). Rate-limit fixtures: `cargo test --locked -p
tmt-adapters release_http`. Archive, handoff and typed grammar checks:
`cargo test --locked -p tmt-adapters native_install` and `... -p tmt-cli native_install`;
the [handoff contract](../../../../contracts/native-install-handoff-v1.md) owns the probe. A
timeout after installation starts is an uncertain outcome, never proof of rollback. Assert
active receipts and surviving executables, not only exit codes.

Actual-archive acceptance needs separately versioned matching-host artifacts built in
task-owned source copies (never alter the repository version or publish fixtures to test
updates). It is `#[ignore]` and selected explicitly by the CLI upgrade proof:

```sh
TMT_UPGRADE_OLD_ARCHIVE=/abs/old.tar.gz TMT_UPGRADE_OLD_MANIFEST=/abs/old.json \
TMT_UPGRADE_NEW_ARCHIVE=/abs/new.tar.gz TMT_UPGRADE_NEW_MANIFEST=/abs/new.json \
TMT_UPGRADE_TARGET=aarch64-apple-darwin CARGO_BUILD_JOBS=2 \
cargo +1.97.0 test --locked --manifest-path rust/Cargo.toml -p tmt-adapters --lib \
  native_install::upgrade::artifact_tests::cargo_dist_upgrade_refreshes_real_artifacts_and_preserves_conflicts \
  -- --exact --ignored --nocapture
node typescript/scripts/verify-native-installation.mjs --previous-archive "$previous_archive" --previous-manifest "$previous_manifest" \
  --archive "$next_archive" --manifest "$next_manifest" --target aarch64-apple-darwin --skill skills/tmux-team/SKILL.md
```

Require exactly one selected passing test. Identical embedded skill text prints a skipped
differential result; candidate-byte equality, conflict preservation and repair still run.
The installation verifier checks old/new versions with no runtime `PATH`, pinned rejection,
explicit `--unpin` advancement, retained executable, no-op, downgrade rejection, exact skill,
unchanged SQLite bytes and migration of state the previous release wrote. The
`native-release-upgrade.yml` proof (also `workflow_dispatch` from `main` for any draft or
published tag) does this on four hosts; extension and driver releases use
`verify-native-extension-upgrade.mjs` and `verify-native-driver-upgrade.mjs`. The first
release of a product has nothing to upgrade from and says so; a commit that predates the
scripts fails the proof with that message and is proven by hand.

Offline composition (an internal entry point, not in help or completion), always with a
task-owned prefix and matching archive:

```sh
native_prefix=$(mktemp -d)
rust/target/debug/tmt __native-install --archive target/distrib/tmt-cli-aarch64-apple-darwin.tar.gz \
  --manifest "$native_manifest" --prefix "$native_prefix" --channel alpha --json
"$native_prefix/bin/tmt" --version
```

`--pin`/`--unpin` change pin state, omission preserves it, and neither authorizes a downgrade.
Receipts written by v5.0.0-alpha.2 through alpha.6 record `wkh237/tmux-team`, which reading
still accepts.

Core also registers `remote` and `colab` for the shared installer (commands in
[tmt-remote](../../tmt-remote/SKILL.md#installer-registration)); synthetic archives prove
installer behavior, not published linkage.

## Curl bootstrap

Generate the script only after final archives and their independent runtime verification; the
manifest, not a hand-kept version table, owns the facts:

```sh
node typescript/scripts/generate-native-bootstrap.mjs --manifest /abs/dist-manifest.json --archive-dir /abs/artifacts > /abs/artifacts/tmt-installer.sh
sh -n /abs/artifacts/tmt-installer.sh
node typescript/scripts/verify-native-bootstrap.mjs --manifest /abs/dist-manifest.json \
  --archive /abs/artifacts/tmt-cli-aarch64-apple-darwin.tar.gz --target aarch64-apple-darwin --skill skills/tmux-team/SKILL.md
```

The verifier needs real matching-host artifacts and replaces only curl acquisition; it is not
live GitHub or cross-target evidence. The Dockerfile above carries it too (`--entrypoint node`).
`test/tooling/native-bootstrap.test.ts` covers negative paths with a stub that is never
publication evidence. An authorized release uploads the exact verified manifest, archives and
script and verifies the public download before the README advertises it.

## Packed verifier cleanup

For `typescript/scripts/packed-command.mjs` changes run
`test/tooling/packed-command.test.ts` and `test/tooling/release-pr-safety.test.ts` (the latter
needs the pinned release-please install) through `vp test run --config vitest.config.ts`, then
`pnpm check:tooling`. Keep the negative controls and original subprocess deadlines; the
[release boundary](../../../../ARCHITECTURE.md#release-boundary) owns termination.

## Release PR gates, queue and stall monitor

Fixture-only verification (REST only, no GraphQL, no live API tests):

```bash
(cd typescript && corepack pnpm exec vp test run --config vitest.config.ts test/tooling/release-pr-safety.test.ts test/tooling/release-queue.test.ts test/tooling/release-please-config.test.ts test/tooling/release-workflow.test.ts test/tooling/release-stall.test.ts test/tooling/pr-title-check.test.ts)
(cd typescript && corepack pnpm test:run && corepack pnpm check)
actionlint .github/workflows/ci.yml .github/workflows/release.yml
```

- Notes gate: `node typescript/scripts/release-pr-safety.mjs notes` (PRs and merge groups; the
  merge-group step re-reads the PR body over REST). It needs full history and tags and caps
  coverage history at 500 commits and queue discovery at 40; unavailable, stale or oversized
  evidence fails rather than dropping a candidate. `... draft` runs after `github-release`
  and holds only a tagless-draft component's manifest path. Both gates use workflow tokens,
  30 s command bounds, ten 100-item pages and 60 requests per invocation. Dry runs use
  `github.token` and see no drafts.
- Queue: `typescript/scripts/release-please-queue.mjs` plans `release-pr` before enabling at
  most one non-draft release PR by ascending number with `--auto --match-head-commit` and
  no strategy flag (the packed-command contract treats `gh`'s stderr warning as a failure).
  It dequeues a stale queued PR once with the release App token after re-reading identity,
  head and queue entry; a failed dequeue blocks `release-pr` and enabling. A permanently
  failing active release PR holds the slot: `tmt-infra-lead` coordinates and asks tmt-lead or
  Ben to close it. Live runs use the App token, never an agent's.
- Stall monitor: `release-stall.mjs` runs in its own advisory job with `github.token`; it
  warns when a tagless hold is older than 30 minutes or an open release PR head is over an
  hour older than the newest releasable commit that is missing from it. One fixed-title
  `Release stalled` issue is reopened, commented per draft ID or stale head/commit pair and
  closed when discovery is healthy.
- Titles: `release-pr-safety.mjs titles-report` runs only for `merge_group` in report-only
  mode (always exits zero). Enforcement is a separate PR whose cutover is the report-only
  PR's actual `merged_at` plus 24 hours as an explicit UTC timestamp.

## Project release tracking

`project-release.yml` sweeps closed issue items (except `epic`) of
[pj-tmt project 1](https://github.com/orgs/pj-tmt/projects/1) and owns `Status` and
`Released in` for them; it needs **Organization projects: read and write** on the release App
token (main-only `release` Environment) and no PAT. The daily cron is 04:23 UTC, and
`native-release-bundle.yml` dispatches a full sweep after publication read-back and
successful smoke. Avoid manual edits to those two fields during a live run. Product attribution
uses `ci-scope.releasedComponentsForPath` (`owns`/`excludes` plus each released package's
transitive Cargo normal/build workspace dependency directories; dev-only edges never
attribute) over `cargo-workspace.mjs::readCargoWorkspace(root, {runner})` (`cargo metadata
--offline --locked`, no Git logic); workflows run `cargo fetch --locked` from `rust/` first.
`release:false` alone is never evidence that work needs no release (Colab, Remote and Herdr
await activation); the map's `releaseStatus` is valid only with `release:false`: `never`
(test support, contained in no release) and `parked` (Office) reconcile to `Done`, anything
else stays `Merged`. Bounds per run:
200 GraphQL and 20 REST requests, 20 pages per connection, 2,000 merged closing PRs; every
GraphQL read reports `rateLimit`, and insufficient reserve aborts before any write. For
activation or a change, dry-run first and review the per-item table against the first live run:

```bash
gh api repos/pj-tmt/tmt/actions/workflows/project-release.yml/dispatches --method POST --input - <<'JSON'
{"ref":"main","inputs":{"dry_run":"true"}}
JSON
# After reviewing the table, repeat with dry_run=false.
(cd typescript && corepack pnpm exec vp test run --config vitest.config.ts test/tooling/project-release.test.ts test/tooling/cargo-workspace.test.ts test/tooling/release-attribution.test.ts test/tooling/release-cut.test.ts test/tooling/ci-scope.test.ts test/tooling/release-workflow.test.ts test/tooling/release-publish.test.ts)
actionlint .github/workflows/project-release.yml .github/workflows/native-release.yml .github/workflows/native-release-bundle.yml .github/workflows/native-release-smoke.yml
```

## Merge queue metrics

Read-only REST evidence (no GraphQL); bounds are UTC, start inclusive and end exclusive:

```sh
node typescript/scripts/merge-queue-metrics.mjs --repo pj-tmt/tmt \
  --since 2026-10-02T00:00:00Z --until 2026-10-02T08:08:40Z --boundary 2026-10-02T06:08:40Z \
  --cache /tmp/tmt-queue-metrics-cache --output /tmp/tmt-queue-metrics.md --json /tmp/tmt-queue-metrics.json
```

`--boundary` compares cohorts, `--details` prints all cost rows, `--offline` requires cached
evidence, `--max-requests N` overrides the 500-request budget (split capped windows),
`--workflow FILE` defaults to `ci.yml`, and repeated `--tag-pr N` overrides #961/#963. The
script and report state their methodology limits. Verify with
`pnpm exec vp test run --config vitest.config.ts test/tooling/merge-queue-metrics.test.ts`
from `typescript/`.
