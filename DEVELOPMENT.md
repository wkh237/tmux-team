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
Final-response tests use real temporary SQLite and an injected clock for exact
submission/retention boundaries, plus independent processes for writer races.
The live CLI consumes this same service; Docker/mock-agent scenarios verify
request correlation and exact-body retrieval across the real CLI/tmux boundary.

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
does not substitute for application storage/migration verification in TMT-29.

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
