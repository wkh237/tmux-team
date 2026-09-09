# Architecture

The shipped CLI runtime is the Rust workspace in `rust/`. An optional Office
SPA foundation lives in `apps/office`; it is not a CLI fallback or a shipped
connector. The root Node package is private developer tooling. It may host Vitest,
fixture and release-verification helpers, but it is not a second CLI runtime,
an npm product, or a source-install fallback. A native source checkout selects
`rust/target/debug/tmt` (or an explicitly supplied native executable); a missing
native build is an error. No test, script, or installer may silently execute an
installed host `tmt` or a retired TypeScript product implementation. Node may
run explicit developer fixtures and verifiers, never serve as a product fallback.

The published alpha2 release remains immutable. Source cutover does not publish
a replacement, migrate application data, or add user-facing features.
TMT remains an invocation-owned local CLI, without a daemon, remote MCP server,
identity memory or a separate inbox service.

Any retained `better-sqlite3` use belongs to private developer tooling as an
independent oracle. It is not a Rust runtime dependency or an alternate owner
of native schema and application state.

## Office workspace boundary

The pnpm workspace has one lockfile and one app package, `@tmt/office`. Existing
Rust, test, release script and canonical skill paths remain stable. Read
[Office architecture](docs/office/architecture.md) for current SPA ownership,
the chosen React/Vite/TanStack/Jotai stack and the
[Office design](docs/office/design.md) for planned trust/lifecycle semantics.
Office must not import local SQLite/process adapters or native test helpers.
Cloud product services remain unimplemented; the emulator bootstrap below is
local verification infrastructure. `contracts/office`
owns the versioned work-handoff schema and fixtures; derived representations must
prove conformance there. Structural tests do not prove remote authorization or
delivery. Future connector dispatch reuses native request/storage ownership,
not CLI-output scraping or a competing exchange engine. Ordinary CLI operations
remain independent of Office.

`services/office` now contains the isolated Firebase emulator bootstrap (#184),
not a deployed service. Its shared demo-project configuration and deny-all rules
have no product membership semantics. Owner-local project aliases/secrets are
excluded from Git and Docker; the image has no host credential/data mounts.
`scripts/verify-office-emulators.mjs` proves emulator transport and fixture
cleanup separately from native tmux E2E and future Office authorization tests.

Office's explicit emulator-only login has one app-owned Firebase/session boundary
under `apps/office/src/auth`, with memory-only persistence and no world authority.
React subscribes to the observer-backed session rather than copying identity into
Jotai. The opt-in `browser-tests` stage of the same emulator Dockerfile proves
real browser session behavior with local auth and an explicit public Google
script allowlist, not fully offline OAuth; its default stage remains
the lightweight emulator environment. See Office architecture for lifecycle and
failure ownership. No cloud membership service or connector is implemented.

`scripts/ci-scope.mjs` owns conservative affected-area selection and final gate
validation. Office-only source/docs avoid native matrices; native source/skill
changes avoid Office. Shared or unknown paths (including lockfiles, security,
contracts, workflows and test tooling) fan out. Empty diffs fail closed to both.
Diffs include deletions and both sides of renames. Existing required check names
remain; `Code quality` gates selected Office verification and `Native package
matrix` gates all selected native jobs. Selected skipped, cancelled or failed
jobs cannot satisfy either gate. No passing zero-test configuration is allowed.

## Runtime layers

The three Rust crates have deliberately narrow responsibilities:

| Layer             | Owner                           | Responsibility                                                                                                                                                                                                                              |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure domain       | `rust/crates/tmt-core/src/`     | Identity, names, bindings, profiles, settings, retention, request state and native-install version policy. No filesystem, process, SQLite, tmux, network or CLI framework.                                                                  |
| Concrete adapters | `rust/crates/tmt-adapters/src/` | Config files, SQLite, bounded files and processes, signals, tmux evidence/transport, response input, HTTP acquisition, native release publication and managed skill files.                                                                  |
| Application/CLI   | `rust/crates/tmt-cli/src/`      | One Clap grammar, typed invocations, preflight and use-case composition, output/error contracts, completion and the executable entry point. It chooses adapters; it does not duplicate their storage, file, installation or process policy. |

`rust/crates/tmt-cli/tests/architecture.rs` is a test-only import and
dependency guard. It follows the actual Rust module tree, checks reviewed
layer edges and shared declaration ownership, and fails closed for unsupported
module remapping or incomplete discovery. It is a syntactic guard and never
replaces review of behavior or effects.

## Public command boundary

`rust/crates/tmt-cli/src/grammar.rs` is the single syntax/help/completion
definition. `parser.rs` turns it into `invocation.rs` values; handlers receive
typed requests and publish through `output.rs`. Hidden commands are still
parsed for controlled internal workflows but are omitted from public help and
completion.

The maintained public surface is:

- `init`, `config`, `completion`, `learn` and `install` for local setup and
  guidance;
- identity and binding commands: `identity`, `list`/`ls`, `add`, `name`/`this`,
  `whoami`, `unbind`, `rm`/`remove`;
- profile and exchange commands: `role`, `preamble`, `x list|show|ack|ackall`,
  `reply`, `result`, `talk`/`send`, `check`/`read`;
- managed native updates through `upgrade`/`update`, with the hidden
  `__native-install` and `__native-refresh-skills` composition points used by
  verified release tooling.

The grammar owns option placement and rejection. Handlers do not search raw
argv, create competing option parsers, or reinterpret payload text as flags.
JSON and human output use the same typed result and status contracts.
`OutputMode` contains only the supported JSON selection. Former no-op
`--verbose`/`-v` and `--debug` flags are absent from the grammar and fail with
`USAGE_ERROR` before effects; literal message/option-value text is unchanged.

`output::table` is the single plain human-table renderer for binding, identity,
exchange and configuration reports. Callers own columns and typed projections;
the renderer owns control-character escaping, Unicode display-width measurement
and spacing. The CLI-only `unicode-width` dependency does not enter domain or
adapter policy. Tables preserve complete values without terminal probing,
truncation or color; narrow terminals may wrap. JSON and exact prompt, final,
profile and diagnostic bodies bypass table rendering.

## Domain and state ownership

### Identity, names and bindings

`tmt-core::names` owns canonical identity and pane-target classification,
including the pinned normalization/casing behavior and bounded name rules.
`tmt-core::identity` owns lifetime and storage-only create/promote policy.
`tmt-core::binding` owns evidence evaluation, retirement authorization and
binding use cases. Unknown or conflicting endpoint evidence is never treated as
proof of death. Saved identities detach and remain offline; temporary identities
may retire only after conclusive evidence.

The concrete implementations are `storage::identities`,
`storage::bindings` and `tmux::{metadata,evidence,binding,caller,transport}`.
`binding_command` performs caller/target preflight and composes those owners.
Presence is observation, not routing permission; an explicit socket or pane
marker cannot authorize a different identity.

Names are global within the selected local database, not folder-scoped. Plain
`name`/`add` creates temporary bindings; `-s` saves/promotes the same identity UUID.
Conclusive pane/server death or explicit unbind retires temporary names without
erasing retained exchanges; saved identities remain available offline. Saved
removal requires explicit force. Neither removal nor unbind kills a pane.
`list` may show verified foreign-server identities, but `talk`/`check` routing
remains current-server-only. Pane number, presentation title and socket pathname
alone are not endpoint identity. Publication and recovery preserve the full
server/pane process evidence; ambiguous observations fail closed.

### Settings and configuration

`tmt-adapters::config::ConfigPaths` is the sole application path owner.
`config::document` preserves unknown JSON fields and validates known settings
through `tmt-core::settings`. `init` exclusively creates the selected local
file as `{}\n`; it neither loads configuration nor opens SQLite or tmux.
Existing files, directories and links are refused without mutation.
Configuration errors retain their stable public codes and useful paths only at
the adapter boundary.

### SQLite and durable exchanges

`tmt-adapters::storage` owns one private synchronous `rusqlite` connection,
schema migrations 1 through 9, WAL/foreign-key/FTS5 setup, busy and transaction
boundaries, and close/checkpoint cleanup. Historical schemas and frozen fixture
provenance are evidence, not a second implementation. The adapter keeps raw
connections private and exposes narrow ports to core services.

`tmt-core::request::RequestService` owns preparation, delivery-state
transitions, exact final submission, waiter release, attention revisions and
bounded retention housekeeping. It samples clocks at the transaction boundary,
never holds a transaction across transport, and treats uncertain delivery as
uncertain rather than as a replay authorization. `storage::requests` owns SQL,
row decoding and ordered bounded cleanup; `request::attention` owns the pure
attention contract. Prompt/final content, attempt metadata, retention and
acknowledgment state have independent lifecycle rules.

The request service reserves cadence together with a durable attempt before
sending, then records definitely-failed, sent or uncertain delivery. Only a
definite failure permits the defined reservation refund; timeouts are not proof
of non-delivery. Final bodies are immutable: identical retries are idempotent,
conflicting second finals fail, and terminal text is never used as completion
evidence. `talk` waits for a stored final unless detached or timed out;
`result` reads by request, while identity-owned `x` exposes outstanding attention.
Reads do not acknowledge. `ackall` acknowledges one snapshot, so a later final
becomes unread again. Acknowledgment means handled, not successful or cancelled.
Retention is frozen per attempt; bounded lazy housekeeping must respect active
waiters, preserve the defined acceptance deadline and never resurrect an expired
submission. The settings owner defines retention defaults and limits.

`reply_receipt` is the one maintained receipt codec. `response_command` and
`talk_command` compose it with the request service; neither adds a repository,
schema, connection or alternate final-submission path. Input is bounded and
validated before storage effects. A malformed receipt, a stale revision, an
unknown identity and an uncertain transport outcome remain distinct failures.

Talk preparation renders `<tmt-reply from="…">` using the same resolved
originator's display name (explicit identity before verified caller), or
`unknown`. The attribute is XML-escaped presentation, not authentication,
routing or a strict XML document. It introduces no extra identity lookup or
stored field; original message bytes, originator UUID/kind and reply correlation
remain owned by the existing request contract.

### Tmux and process effects

`tmt-adapters::process` is the shared bounded subprocess owner. It enforces
output caps, monotonic deadlines, process-group cleanup and wait/reap behavior.
`interrupt::Interrupt` owns invocation-local signal callbacks and descriptor
cleanup. `tmux` uses explicit socket/server evidence, bounded command budgets,
owned buffers and no ambient host fallback. A failed paste or Enter is an
uncertain delivery and is never retried as if unsent.
Message delivery changes ASCII `!` to fullwidth `！` to avoid agent bash-mode
shortcuts; this is transport policy, not arbitrary output rewriting. `check`
remains bounded terminal diagnostics, not a fallback response channel.

`response_input` owns bounded file/stdin acquisition, regular-file checks,
nonblocking behavior and restoration of inherited descriptor flags. The public
CLI owns stdin during acquisition. These adapters do not invent background
threads or a second process runner.

## Managed skills and native installation

Managed agent guidance is a separate filesystem concern. The canonical skill is
embedded by `skill_installation::assets`; digest-addressed materialization,
provider detection, target selection, links, backups, registry, drift and lock
handling live under `rust/crates/tmt-adapters/src/skill_installation/`. Core's
`skill_provider::Provider` is the only provider inventory. Skill installation
does not open application configuration, SQLite or tmux, and never silently
replaces an unmanaged path.

Native executable installation is a different owner under
`tmt-adapters::native_install`:

- `artifact` consumes cargo-dist metadata and a matching archive, checking
  target, manifest membership, SHA-256, bounded compressed/expanded input,
  notices and executable contents;
- `publication` stages a release under an invocation-owned prefix, writes
  receipt/current/command links atomically under the installer lock, and keeps
  old owned releases until ownership and integrity checks permit cleanup;
- `receipt`, `release`, `managed` and `upgrade` implement local provenance,
  active-release inspection, channel/pin policy, verified HTTPS acquisition and
  forward-only activation;
- `native_install_command` and `native_upgrade_command` are thin CLI
  compositions. Application data and provider skills are separate owners.

The active executable is the authority for a managed update. Installer receipts
are anchored to the installation prefix/current executable, not to
`ConfigPaths.global_dir`; changing runtime config roots must not fabricate or
discard binary ownership evidence. Installation uses staged publication,
expected-current checks, explicit checkpoints and bounded cleanup. A failed
validation or cancellation leaves the previous current release and receipt
intact; a post-activation skill failure reports partial completion rather than
claiming an atomic application-wide transaction.

The generated curl bootstrap is release tooling around this same native
installer. It derives archive facts from cargo-dist metadata and does not own a
second target catalog, archive parser, package manager, or production manifest.

## Testing and evidence boundaries

Retained tests are organized under `test/native/`, `test/e2e/`,
`test/tooling/` and `test/support/`, with Rust unit/integration tests beside
their owners. They use independent SQL/schema oracles for SQLite behavior and
frozen fixtures from `test/fixtures/storage-history/`; implementation reads
must not generate their own expected results. Native process tests use absolute
task-owned executables, bounded subprocesses and cleanup that stops, reaps and
only then removes fixture state. Signals are sent only to task-owned child
processes. No host tmux server, provider installation or global environment
mutation is test evidence.

The native process suite proves parser, configuration, identity, response,
exchange, talk, installation and skill contracts through the real executable.
Docker E2E supplies private tmux, caller, lifecycle, transport and cross-process
evidence. Storage adapter tests prove migrations, transaction rollback,
contention, crash cleanup, retention, acknowledgment and late-final behavior.
Tooling tests prove release-script policy and bounded command wrappers; they do
not count as native runtime or release-archive proof.

Within Docker E2E, `cli-assertions.ts` owns the repeated strict success envelope
(zero exit, empty stderr, defined parsed JSON), not domain validation or command
execution. Scenario-specific payload projections and assertions stay local;
sharing a type must not turn required fields into optional ones. A different
stderr or parsing contract is not an interchangeable helper. The native-process
assertions in `test/support/cli-process.ts` retain their own process-result shape.

All public-command E2E scenarios use `test/support/cli-executable.mjs` through
the harness. There is no separate product-only native selector; explicit
`TMT_TEST_CLI`/peer descriptors still exercise override and nested-reply behavior.
`tmux-adapter` and `transport-adapter` deliberately select the test-only tmux
probe, not the public CLI. Their evidence cannot replace public command tests.
Feature ownership and deliberate overlap are mapped in DEVELOPMENT.md.

The six required runtime smoke environments are macOS x64/arm64, Linux glibc
x64/arm64 and Linux musl x64/arm64. Four raw native builds feed these checks;
the static Linux musl binaries are reused for both Linux environments. The
historical `Packed install (<environment>)` check names and
`Native package matrix` final blocking aggregator remain for CI
compatibility, but their step descriptions must identify them as native runtime
smoke checks, not npm-package checks. Smoke runs outside the checkout with
isolated HOME/state, no Node/Rust on the product PATH, exact embedded skill
checks, managed skill installation and SQLite reopen/persistence.

The source-cutover gate is positive and negative: a selected native executable
must run, and a missing default native build must fail clearly. No Rust coverage
percentage is compared with the retired TypeScript source or reported as a
zero-file success.

## Release boundary

`dist-workspace.toml`, `scripts/build-native-artifact.sh`,
`scripts/native-cargo.sh`, `scripts/native-artifact-policy.mjs` and
`scripts/verify-native-artifact.mjs` are developer/release tooling. The
workflow builds the four supported cargo-dist targets, creates target-filtered
third-party notices, and verifies runtime bytes, linkage, skill contents,
checksums, archive inventory and executable behavior on matching hosts.

The release workflow remains an explicit preparation and verification workflow;
publication is separately authorized. Archives, their manifest/checksums,
notices and generated `tmt-installer.sh` are verified before any public
publication. Raw PR executables do not prove cargo-dist archive correctness.
The runtime/linkage proof is shared through `scripts/native-runtime-proof.mjs`
and `scripts/verify-native-runtime.mjs`; do not reintroduce a second archive
builder or proof implementation.

## Maintenance contract

Update this map in the same change when responsibility, dependency direction,
command/error contracts, storage schema or lifecycle, trust boundaries,
resource ownership, shared test infrastructure or release evidence changes.
Keep a significant decision's alternatives, failure behavior and verification
plan in its issue and reflect the delivered boundary here. A green formatter or
checkmark is not architecture evidence.

Every change reports its architecture impact and names the affected Rust owner,
adapter, CLI composition and tests. New policy belongs in the existing owner;
do not add a parallel TypeScript implementation, provider inventory, config path
registry, release catalog, process runner, archive parser or memory/MCP layer.
