# Development

Repository policy and ownership live in [AGENTS.md](AGENTS.md). The maintained
module map and architecture change triggers live in
[ARCHITECTURE.md](ARCHITECTURE.md). Code and test style lives in
[CONVENTIONS.md](CONVENTIONS.md). Use this file for commands, test selection,
and verification evidence; do not copy architecture policy here.

## Change workflow

Follow the [development skill](.agents/skills/tmt-dev/SKILL.md) for the issue,
audit, design, delegation, primary review and delivery workflow. This guide owns
the verification commands, not a second copy of that procedure.

## Project Setup

- Requirements: Node.js >= 22.12
- Install dependencies:

```bash
pnpm install --frozen-lockfile
```

- Run the CLI locally:

```bash
pnpm dev -- --help
```

## Running Tests

### Native development preview

The `rust/` workspace is not the installed runtime yet. It implements only
help/version/completion, typed grammar, the existing `config` command and
storage-only `identity create/show/list` under #113, and pane identity
`name`/`this`/`add`/`whoami`/`unbind`/`rm`/`list` under #109, plus storage-only
`reply`/`result` under #122.
Other effectful commands still explicitly fail.
The #118 request/final service is an internal transactional foundation only;
its public reply/result composition is supplied by #122, not native talk. Its real SQLite
tests run in ordinary adapter Cargo tests and therefore in the existing Docker
adapter-test stage. They must verify committed rows independently of service
reads, since those reads can perform housekeeping. Inject clocks for deadline
equality/rollback and use bounded barriers between real connections for races.
Retained final retries, attention rollback, cadence refunds and late replies
after identity retirement are service evidence, not CLI/receipt/transport parity.
The #120 receipt codec adds canonical v2/old-v1 wire cases and submits both proof
types through the same service. Compare digest goldens with an independent
implementation; an encode/decode round trip alone cannot prove field ordering.
Malformed-UTF-8 fixtures must first be valid canonical base64, or they never
exercise decoding. Migration receipt cases reuse the frozen historical fixture
and a TS-generated v1 literal, with independent SQL for retained timestamps,
attention and no-mutation checks. Compact/recorded writers race through the
existing bounded connection harness. These remain internal service tests, not
public native talk/reply/result acceptance.
#122 adds `test/native/response.test.ts` over the same bounded process sandbox,
with independent request SQL fixtures and Node-derived receipt proofs. It checks
real public reply/result outputs, input preflight before storage creation,
no-tmux/config isolation, retry after attempt removal and a stopped schema-8
fixture migrated by public native reply. Do not reopen that fixture with TS.
Adapter tests include exact-byte files, FIFO rejection, socket/pipe EOF, inherited
flag restoration and an isolated test-only pseudoterminal. The Darwin socket
case must reproduce the unsupported terminal probe, not weaken the public stdin
assertion. Keep the real five-second CLI timeout separately from short injected
adapter deadlines. This is public storage-only acceptance, not native talk.
#124 adds adapter send/capture coverage through `test/e2e/native-transport.e2e.test.ts`
and the existing development-only tmux probe. These scenarios assert causal mock
input and exact no-replay traces for explicit-socket native operations, preserve
unrelated buffers, and compare diagnostic capture independently. They do not
make public native talk/check available. Scripted adapter tests reuse the tmux
test runner to verify caps, stage errors and cleanup precedence without host tmux.
The separate storage adapter upgrades historical schemas 0–8 to native schema 9,
tested through a development-only probe rather than an installed command.
Use isolated test databases only: installed TypeScript cannot reopen schema 9.
The #111 internal record service supports temporary/saved creation, same-UUID
promotion and non-retired selection, tested against real isolated SQLite. It
supplies the public storage-only commands but does not establish live presence.
The Unix tmux evidence adapter is likewise exercised through a non-installed
`tmux-probe` example; native identity commands are not implemented by that probe.
Use the exact toolchain from `rust/rust-toolchain.toml` and run from `rust/`:

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
cargo build --locked --example storage-probe
cargo build --locked --example tmux-probe
cargo +1.88.0 build --locked
```

The architecture guard is included in `cargo test`; it adds no separate CI job.
For a focused run from any working directory, after dependencies are available:

```bash
cargo test --offline --locked --manifest-path /absolute/checkout/rust/Cargo.toml --test architecture
cargo +1.88.0 test --offline --locked --manifest-path /absolute/checkout/rust/Cargo.toml --test architecture
```

The guard itself obtains offline, locked Cargo metadata through the existing
bounded process runner. It needs no tmux server, provider, database or network.
The integration root validates the real workspace; separate positive/negative
fixtures validate dependency edges, AST references, shared declaration ownership
and fail-closed module discovery. When changing this gate, also temporarily
introduce a real source/dependency violation, observe its specific diagnostic,
and restore the original files exactly. A stale-lock failure or an unexecuted
test is not evidence that the architecture policy caught the violation.
See [the native guard contract](ARCHITECTURE.md#native-architecture-guards)
for the syntactic limits that still require manual review.

From the repository root, select the built executable explicitly:

```bash
TMT_TEST_CLI='{"executable":"/absolute/checkout/rust/target/debug/tmt","args":[]}' \
  TMT_TEST_STORAGE_PROBE='{"executable":"/absolute/checkout/rust/target/debug/examples/storage-probe","args":[]}' \
  pnpm test:native
```

This preview-specific suite reuses the shared sandbox and bounded process
launcher; it does not replace TypeScript or Docker verification. Storage tests
create and close TypeScript schema-prefix fixtures, migrate through the actual
Rust adapter, and compare independent SQL schema/data with the TypeScript result,
allowing only the specified identity-table/index/history amendment. They verify
saved backfill, name reuse without UUID inheritance, preserved dependent records,
explicit TypeScript rejection of schema 9 without mutation, native reopen,
rollback, history rejection and bounded writer
contention. Neither executable selector may silently fall back to TypeScript.
The probe accepts only a database path and runs open/health/checkpoint/close;
it has no arbitrary SQL or failure-injection command and is not packaged.
Runner-level Rust tests also hold a real rollback-journal reader across migration
commit and inject record/foreign-key failures after table replacement. Assert
schema/data rollback and restored connection enforcement; a migration error alone
does not establish either invariant. Preserve the independent schema-prefix
fixtures instead of copying the new production migration into the test oracle.
Also run the
existing parser-only public contract subset through the same selection:

```bash
TMT_TEST_CLI='{"executable":"/absolute/checkout/rust/target/debug/tmt","args":[]}' \
  pnpm exec vitest run src/cli-contract.test.ts \
  -t 'reports JSON parse errors|rejects ignored options|validates invalid options|keeps JSON leaf|does not treat|keeps a literal|does not reinterpret|rejects JSON mode for text-only'

TMT_TEST_CLI='{"executable":"/absolute/checkout/rust/target/debug/tmt","args":[]}' \
  pnpm exec vitest run src/config-cli-contract.test.ts \
  -t 'accepts omitted|accepts safe|keeps unknown|rejects decimal|repairs a targeted|allows zero'
```

The selected config cases exercise the original public CLI contract unchanged.
Other cases in that file require separately reviewed native behavior/fixtures;
their exclusion is not parity evidence. The native suite separately exercises
configuration validation through `config show`, path discovery, scoped edits,
no-op clear and file preservation, without starting SQLite or tmux.

Keep Cargo workspace version synchronized with the package version while both
runtimes coexist. Check the resolved dependency graph's licenses, MSRVs and
current RustSec advisories when changing Cargo.lock. `tmt-core` must remain free
of CLI/concrete-IO dependencies. `tmt-adapters` owns the concrete SQLite lifecycle;
keep its raw connection private. See RUST-REWRITE for the dependency
decision and explicit exceptions under #100.

Name-policy goldens cover the pinned Node 22.23.2 reference (Unicode 17.0,
ICU 78.2), including ECMAScript BOM/NEL differences, contextual lowercase and
pane-shaped names. Run the same core tests on both supported Rust toolchains;
do not substitute compiler-owned casing tables or case folding. Identity-record
tests invoke the actual service and repository on private SQLite fixtures,
observe dependent rows independently, and synchronize competing connections
before creation. Their evidence is storage policy, not public CLI/tmux parity.

`test/native/identity.test.ts` separately exercises the public native
create/show/list commands across bounded processes and working directories.
Use independent SQL to arrange storage-only fixtures without requiring tmux,
and to inspect preserved records. Test actual binding lifecycle through its
public native commands in Docker. Do not
initialize schema 9 through the TypeScript Storage owner. Test exact public
lifetime projections, missing-name status 3, invalid-name status 1, malformed
unrelated configuration isolation, and calibrated no-tmux guards. CLI cleanup
precedence is tested in `output.rs`; real SQLite close/rollback/contention tests
remain adapter evidence. Storage-only identity reads omit retired records and never reconcile
bindings; these tests are not proof of tmux presence or retirement authorization.

The Docker image builds Linux adapter test artifacts in a pinned Rust/Debian
stage matching the runtime image's libc. It runs native adapter unit tests under
the existing wrapper's `--init --network none` before Vitest. This lets orphaned
fixture children be reaped by init; running those lifecycle tests in a Docker
build shell is not equivalent. The native toolchain is not copied to the final
test image. Keep the same wrapper, private sockets and finally-based cleanup.

`test/e2e/native-tmux.e2e.test.ts` requires `TMT_TEST_TMUX_PROBE`, set by that
image to the narrow development example. It feeds the descriptor into the
existing fixture selector, never silently substituting TypeScript. Its caller,
snapshot, target, metadata and known-server cases are adapter integration, not
public native CLI parity. The probe requires fixture socket environment as an
accidental-host-use guard, not an authorization boundary. Never run its tmux
operations against a host server. Process fixtures use finite children even
on failure and never signal a recycled PID after observed reaping.

`test/native/binding.test.ts` checks isolated public preflight, offline removal,
and lifetime/presence output. `test/e2e/native-identity.e2e.test.ts` selects the
Docker-built `TMT_TEST_NATIVE_CLI` through the same fixture descriptor; it does
not change the selected runtime for unported TS transport scenarios. Exercise
real descendant caller resolution, temporary/save/unbind/rm lifecycle, global
cross-directory/server discovery, grouped/linked presentation, publication
failure/retry and theme-preserving badge behavior. The read-only SQL oracle
also verifies copied-server-ID collision safety and conclusive foreign death.
Adapter bounds tests cover pane-count/filter-byte limits and balanced depth;
the real tmux probe checks multi-pane balanced-filter results. The SQL oracle
observes committed state independently of reconciliation. Metadata barriers
recognize explicit-socket invocations as well as ambient calls. Run the whole
Docker suite twice for lifecycle changes; counts alone do not prove cleanup.

For runtime-rewrite work, read [RUST-REWRITE.md](RUST-REWRITE.md) for the proposed
boundaries and parity gates. The optional [performance baseline](PERFORMANCE-BASELINE.md)
reuses the Docker E2E harness and separately measures macOS startup resources.
Its wall-clock samples are diagnostic evidence, not an ordinary CI timing gate.

- Watch mode:

```bash
pnpm test:watch
```

- Single run:

```bash
pnpm test:run
```

The completion renderer tests execute both Bash and Zsh probes. Local test
environments need `bash` and `zsh`; the unit-test CI job installs the Zsh
package explicitly because the hosted runner shell set is not a project
dependency guarantee.

- Docker-backed CLI/tmux end-to-end tests:

```bash
pnpm test:e2e
```

The E2E command requires Docker, builds the pinned Node, pnpm, and tmux versions
in `test/e2e/Dockerfile` from the current checkout, runs Vitest inside it with
`--network none`, and removes the tagged image afterward. Each test starts its
own tmux server on a private socket and
launches the deterministic mock agent from `test/e2e/mock-agent.mjs`; no real
agent, credentials, or host tmux session is used. The tests invoke
`bin/tmux-team` by default as a subprocess and exercise CLI process propagation, tmux
transport, pane movement, and fixture cleanup. Failures include the
container/Vitest output, and each fixture kills its private server and removes
its temporary state.

### Selecting the CLI under test

`TMT_TEST_CLI` is a JSON descriptor with exactly `executable` (absolute path to an
executable file) and `args` (string-array argv prefix). Omission selects the
current test runner's absolute Node executable plus the checkout's public
TypeScript wrapper as its prefix. This preserves tests that deliberately remove
Node/provider discovery from PATH; it does not skip the wrapper's child process.
`TMT_TEST_PEER_CLI` uses the same format for mock
agent replies; omission uses the primary selection. An empty, malformed,
missing or non-executable explicit selection fails; it never falls back to TS.
Shell fragments are not parsed. Paths and prefix arguments may contain spaces
and quotes. Selection is frozen per sandbox/fixture, before resource allocation.

```bash
# Host CLI contracts; use a real native build only once it supports the subset.
TMT_TEST_CLI='{"executable":"/absolute/path/to/tmt","args":[]}' \
  pnpm exec vitest run src/identity-cli-contract.test.ts

# Docker paths refer to files INSIDE the image, not host executable paths.
TMT_TEST_CLI='{"executable":"/workspace/bin/tmux-team","args":[]}' pnpm test:e2e

# Explicit Node+wrapper is also a descriptor, not a special runtime mode.
TMT_TEST_CLI='{"executable":"/usr/local/bin/node","args":["/workspace/bin/tmux-team"]}' \
TMT_TEST_PEER_CLI='{"executable":"/workspace/bin/tmux-team","args":[]}' pnpm test:e2e
```

The Docker wrapper forwards both settings unchanged. A custom Linux binary must
already be in the build context/image, or be mounted read-only in a manually
managed task-owned image/container; no host-path mapping or cross-compilation is
implicit. Keep `--rm --init --network none`, private fixture sockets and image
cleanup. Do not feed a macOS binary to the Linux container. The resource probe
uses the host descriptor and reports it; Docker latency reports record both
descriptors. Record native build profile/toolchain separately when comparing.

Selection reaches the shared CLI-contract helper, E2E commands, real tmux
descendants and nested mock replies. Selector infrastructure tests deliberately
exercise the TS reference and a non-Node recording wrapper, not native parity.
Tests importing TypeScript services/concurrency workers, the bin-wrapper tests
and packed storage probes remain TS-only evidence. They are not converted by an
environment variable: retain their assertions until corresponding native
units/concurrency and installed-artifact gates replace them. Native partial
subsets must be named in the issue; never present one as full compatibility.

The publication race scenario observes the CLI process tree's open database
descriptors through Linux `/proc` before releasing the writer barrier. This
proves storage entry without assuming that a read invokes tmux before SQLite;
it is a Docker-only test oracle, not a production synchronization hook.

- Static/code-quality checks (unit and Docker suites are separate):

```bash
pnpm check
```

## Focused verification

Run the checks for every changed layer and report the exact command and result.
Select behavioral checks by the affected contract, not only by file extension.
Changed public CLI behavior needs representative real subprocess input/output
coverage; tmux integration uses the existing Docker harness. A feature issue
authorizes its matching tests, not unrelated expansion of the E2E foundation.

Caller discovery regressions require a CLI process genuinely descended from a
tmux pane process, with environment stripped and another pane active. Spawning
the CLI outside tmux with injected environment tests a different contract.
Preserve rejection tests for outside callers, malformed/conflicting evidence
and unavailable process information. An environment-stripped fixture is not
proof that a specific provider sandbox permits process/socket access; report
that verification gap separately.

Identity performance regressions require mostly-unbound large sessions as well
as small fixtures. Assert subprocess counts and scoped evidence requests, not
only elapsed-time thresholds: unrelated panes must not add per-pane subprocesses
to a single-target operation. Record wall time as diagnostic evidence, with
startup and transport delays distinguished from identity work. Real Docker
scenarios must verify bindings, conflicts, untouched metadata, causal replies
and cleanup; never seed every pane with placeholder metadata to make a test fast.
Scoped reads must preserve unrelated stale rows while full discovery may reconcile
them. Both paths must share the existing binding-evidence predicate.

Snapshot coverage must include grouped sessions and independently linked windows,
not only many panes in one session. Assert that the fixture actually produces
multiple session targets for one stable pane ID, then verify scoped operations
and full discovery both retain one binding. Validate malformed and conflicting
duplicate rows in both orders before deduplication; repeated rows alone are not
incomplete evidence. Preserve subprocess-count gates and causal durable replies.
Attach a real fixture-owned client when testing target presentation, including
a detached-first linked row. Assert the attached target through both public
`list` and focused `list <target>` without changing stable pane routing. Client
readiness must identify that client, and fixture cleanup must reap it.

| Changed area                            | Required checks                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Production TypeScript                   | `pnpm type:check`, `pnpm lint`, `pnpm format:check`                                 |
| Unit behavior or shared contracts       | `pnpm test:run`                                                                     |
| E2E scenarios, harness, or scripts      | `pnpm e2e:typecheck`, `pnpm e2e:lint`, `pnpm e2e:format:check`, and `pnpm test:e2e` |
| Repository docs, skills, or PR guidance | `pnpm docs:format:check`                                                            |
| Cross-layer or release-facing changes   | `pnpm check` plus the applicable behavioral and packed-install checks               |

CI must be checked on the current commit before an authorized merge. The
focused `src/architecture.test.ts` checks direct literal imports/re-exports for
command/service storage independence, parser/command separation, and pure domain
dependencies using the existing TypeScript AST. It runs with the unit suite and
tests forbidden examples as well as repository files. It does not prove semantic
architecture correctness; primary review and the architecture-impact record
remain required.

Runner routing tests keep one module import and reset stable context/handler
mocks between cases. Do not rebuild the full dependency graph for each argument
case with module-cache resets; reserve those for tests of module initialization
itself. Keep parser and runner behavior real, and retain separate public CLI
subprocess coverage rather than treating mocked routing as end-to-end evidence.

Identity, request and response concurrency suites share bounded worker startup, barriers,
result collection and termination in `src/test-support/request-workers.ts`.
Scenario assertions stay in their owning test modules; process entrypoints live
in `src/test-support/workers/` and use module-relative resolution. Scenarios stop
their workers in `finally` before fixture removal, including failure before the
release barrier. Harness regressions verify early exit, parent failure and
forced termination through observable process absence, and exercise an unrelated
working directory without adding dependencies to the fixture.
Test-support infrastructure is excluded from production coverage, like worker
fixtures; this does not exclude the request service, domain rules or SQL adapter.
Identity E2E scenarios share `test/e2e/identity-state-oracle.ts` for read-only
identity/binding/profile snapshots; request state has its separate existing
oracle. Do not copy a snapshot implementation into each new lifecycle scenario.
Final-response tests use real temporary SQLite and an injected clock for exact
submission/retention boundaries, plus independent processes for writer races.
The live CLI consumes this same service; Docker/mock-agent scenarios verify
request correlation and exact-body retrieval across the real CLI/tmux boundary.

Retention tests distinguish the frozen policy from current configuration and
logical expiry from physical deletion. Use injected clocks and independent SQL
oracles for exact boundaries, migration anchors and bounded batch draining;
never wait real days or only assert that cleanup was called. Check metadata
cleanup query plans without `ANALYZE`: exercise the actual adapter SQL and
prove ordered index selection without a temporary full candidate sort.
Cover retained finals beyond preparation horizons, unchanged idempotency timestamps, no
metadata renewal from housekeeping, and cleanup/submission transaction races.
Docker scenarios verify real config-to-preparation wiring and storage-only
reply/result behavior after current configuration becomes invalid. Prompt-context
tests additionally distinguish exact original text from composed/protected delivery,
verified originator from explicit local attribution, and recipient UUID from cadence.
Assert failed evidence checks preserve storage and cause no send. Context reads
must distinguish empty, expired and historical unavailable text without loading
all prompt bodies. Inspect scrub query plans without planner statistics and use
non-mutating state oracles: calling a service read can itself run housekeeping
and invalidate a claimed race ordering. Attention tests belong to TMT-51.

Reply adapter verification additionally exercises the real CLI in an isolated
home and SQLite database, including inline text and file/stdin decoding, exact result text,
idempotent retry across invocations and rejection without partial finalization.
Input tests cover EOF, byte/deadline limits and listener/descriptor cleanup.
These storage-only checks do not substitute for live tmux cutover tests. The
mock agent invokes the public reply CLI and logs request/submission/summary
events; the virtualized-body test compares the exact complete response against
an independent oracle even when terminal capture has only its tail. State
oracles verify independent request IDs, immutable finals and waiter cleanup.
Monotonic observer tests cover transport/read overruns and deadline equality;
terminal markers or idle output must not produce completion.
Reply-order scenarios release per-request gates after observing causal events,
not elapsed sleeps. Fixture teardown stops producers before discovering active
reply child groups, and verifies group absence even after a mock is forcibly
killed. A stopped public reply child makes that cleanup regression observable
instead of relying on EOF to let the child exit naturally.

`docs:format:check` covers the architecture, policy, conventions, development
guide, repository skills and PR template. It uses `.gitignore` as its ignore
file because the legacy `.prettierignore` excludes Markdown. For other changed
Markdown, run Prettier explicitly with `--ignore-path .gitignore` and the exact
paths. Validate new/changed skill frontmatter and local links as well; formatting
alone does not validate instructions. When available, use the skill-authoring
validator and record its result; otherwise perform and report a manual check.

Use the E2E skill for integration/lifecycle changes, including its twice-run
cleanup gate. Keep the existing CI jobs required even when a local check is not
applicable; do not use this matrix to bypass branch protection.

## Configuration verification

Configuration changes use policy tables for known-field/type/range rules and
real-file tests for rejected-update byte preservation and targeted repair.
The CLI contract suite verifies complete JSON/exit behavior and storage-only
reply/result independence from malformed settings. Docker scenarios preserve
the no-tmux/no-storage assertions for invalid loaded configuration and exercise
valid overrides through the public CLI and deterministic peer. A loader-level
`CONFIG_ERROR` must not weaken the independent runtime capture/timing tests.
Real CLI process tests must declare a bounded process-test timeout, following
the existing CLI contract suites, rather than inheriting the one-second unit
default. Keep child-process termination bounds and behavioral assertions intact;
test-runner budgets are not production timeout policy.

Pane presentation tests must preserve application titles and user-owned border
format, position, and style across default-off binding, explicit opt-in,
configuration changes, conflicts, and unbinding. Use real grouped/linked windows
to guard against accidentally introducing window-scoped writes. Verify the
documented theme fragment with literal format-like names, and inject a cosmetic
write failure while independently checking durable identity state. Configuration
writes must remain storage-only, and invalid loaded settings must precede any
identity mutation. A passing mocked adapter assertion alone is insufficient.

## Installed guidance source ownership

Edit shared agent behavior only in `skills/tmux-team/SKILL.md`. All native
provider targets link the same self-contained directory; there are no generated
projections or provider command wrappers. Verify installed bytes, correct links,
repeat no-op and update visibility through the packed verifier. The artifact
inventory rejects retired provider/plugin assets. Semantic review remains
necessary: byte equality does not prove correct agent behavior.
`tmt learn --skill` is the exact viewer; plain `learn` is the short guide.

Provider names and ordering belong to `src/skill-installation.ts`. Installation
and completion consume that inventory; provider detection and legacy-backup
policy remain in their existing adapters. Test derivation with an altered
inventory, not only matching copies of the current provider names.
Cover every explicit provider target, directory/executable auto-detection,
provider overrides and the neutral no-provider fallback with isolated homes.
Shared `.agents` presence alone must not invent Codex detection. Drift tests
must catch new provider targets and deduplicate shared paths. Packed verification
must independently compare expected paths and exact installed contents, including
fallback JSON without a provider, no-op reinstall and safe conflict handling.
When claiming provider compatibility, record the actual provider version and
loader or live discovery evidence separately from TMT's filesystem tests.
Use provider-native locations when the supported installed baseline does not
discover newer shared paths; never add a second content source or silently edit
provider configuration to make a smoke test pass.

## Packed native-install verification

The packed native-install check verifies release artifacts. It installs the actual
`.tgz` produced by `pnpm pack` into a clean temporary project, loads
`better-sqlite3`'s native `.node` binding, creates an FTS5 virtual table,
executes a query, and invokes the packed `tmt` executable. Installation runs
with lifecycle scripts disabled, and the verifier requires the exact bundled
prebuild for the current platform, architecture, and libc. A successful run
therefore proves that no source compilation is required. Temporary projects
and caches are removed on every exit path.

The same verifier exercises `learn --skill` and default/custom skill installs
from the packed executable in an isolated home. It compares actual source bytes,
checks managed links and repeated no-op, preserves an unrelated sibling, and
changes only the disposable installed source to prove update visibility. This
is followed by application storage verification through the same packed CLI.

`scripts/packed-storage-probe.mjs` runs with the installed package's TypeScript
loader and imports only that package's runtime owners. Its first storage action
is a missing-name role read through the public CLI. It compares the resulting
migration history with the installed migration manifest, creates and discovers
an identity through the public identity CLI (including canonical idempotence), and verifies role writes/reads/clear across
CLI processes. Repository read paths also exercise the remaining current tables.
The attention smoke seeds one request through the installed RequestService, then
uses public packed ackall before any list, submits a public reply, verifies the
late final reopens attention, rejects a stale ack and settles the current revision.
It checks exact retained prompt/final text and absence of internal attempt evidence
from list output. No live pane, checkout helper or test source is needed.
An incompatible future history must fail without erasing history or role data.
Manifest equality alone does not prove schema behavior, nor does this smoke
replace the detailed migration/concurrency suites.

`scripts/packed-artifact-policy.mjs` checks the installed artifact, rejecting
test sources and worker fixtures while requiring the runtime and bundled skills.
Package allowlist exclusions are verified against actual packed contents, not
assumed from their syntax. When changing these checks, exercise a deliberately
broken artifact and confirm the verifier process fails and its temporary root
is removed. A unit assertion that accepts any CLI error is not that evidence.
CLI/probe subprocesses share `scripts/packed-command.mjs` for bounded execution,
exact status and stderr checking. Homes, temporary/cache roots and tmux caller
environment are isolated; cleanup encloses partial setup as well as verification.

Example:

```bash
mkdir -p .tmp/tmt-pack
pnpm pack --pack-destination .tmp/tmt-pack
node scripts/verify-packed-native-install.mjs \
  --package-tarball .tmp/tmt-pack/tmux-team-<version>.tgz \
  --expected-arch x64 --expected-libc glibc
rm -rf .tmp/tmt-pack
```

CI runs this check on macOS x64 and arm64, Linux glibc x64 and arm64, and
Linux musl x64 and arm64. The Linux musl checks run in native Alpine
containers on matching GitHub-hosted runner architectures. If GitHub-hosted
arm64 capacity is unavailable for a pull request, the release gate must run
the same command on a native arm64 runner; emulation does not satisfy this
matrix.

## Testing Strategy

We prefer structured, deterministic assertions in tests. Human-facing formatting is validated sparingly; most tests assert on structured output or file contents.

### 1) Structured Output Verification

- Use JSON mode (`--json`) when a test needs structured command output.
- Assert on the context's structured UI call (`ui.json`) rather than terminal
  formatting or `console.log`.

### 2) Mock Isolation

- Clear mocks before the call being tested and assert the expected call count
  so stale output cannot satisfy the test.

### 3) File Content Verification

- For config and persistence tests, read actual files from isolated temporary
  directories and clean them up in `afterEach`.

### 4) Table Output

- Verify table output through the `ui.table` mock when table structure is the
  behavior under test.

### 5) Avoid console.log mocking

- Do not override `console.log` directly in tests. Use structured UI calls or a
  focused human-readable formatter test instead.

When a test must validate human-readable output, keep it focused and minimal so
formatting changes do not break unrelated behavior tests.
