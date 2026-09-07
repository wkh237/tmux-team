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
`bin/tmux-team` as a subprocess and exercise CLI process propagation, tmux
transport, pane movement, and fixture cleanup. Failures include the
container/Vitest output, and each fixture kills its private server and removes
its temporary state.

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
