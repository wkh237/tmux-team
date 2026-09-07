# Rust rewrite preparation

Status: native grammar (#96), storage lifecycle (#97) with native identity schema 9 (#108), configuration (#103)
and bounded tmux evidence (#105)
are implemented in the development preview, not a shipped Rust runtime.
Owner: [#93](https://github.com/wkh237/tmux-team/issues/93);
preparation: [#94](https://github.com/wkh237/tmux-team/issues/94).
The compatibility reference is TypeScript main `cb53533f3a9f19a1a2ab95af59dda20df419200b`
(v5.0.0-alpha.1). [ARCHITECTURE.md](ARCHITECTURE.md) remains the current implementation map.
Update this decision and its evidence when a delivering issue changes an assumption.

## Outcome and boundaries

Replace the user-facing Node/tsx runtime with a native executable, preserving
supported v5 command and data contracts. Node may remain developer test tooling.
The approved native identity amendment [#100](https://github.com/wkh237/tmux-team/issues/100)
adds temporary-by-default identities, explicit `-s`/`--save`, restored `rm`/`remove`,
and visible lifetime/presence in `ls`. Canonical names remain globally unique
within one local database across both lifetimes; folders and Git worktrees do
not establish another namespace or filter discovery. The earlier workspace
scoping proposal was withdrawn by user clarification. It retains one SQLite identity model;
promotion keeps the UUID and retirement must preserve retained exchanges.
This amendment is not implemented by grammar recognition alone. The rewrite
is not authorization to add memory/offline inbox,
start a daemon, implement MCP, publish artifacts, or restore v4 compatibility.
Keep `this`, exact durable replies, `!` shell-mode protection, and default-off,
non-invasive pane badges. Native installation and self-update belong to
[#82](https://github.com/wkh237/tmux-team/issues/82), including its explicitly
proposed `update` alias; that future alias is not current v5 behavior.

## Decision: one reusable policy core, explicit adapters

Use a Cargo workspace under `rust/`, with three focused packages:

| Proposed package | Owns                                                                                                                                            | May depend on                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `tmt-core`       | Domain validation, typed use cases, identity selection, binding protocol, request/final/attention/retention policy; narrow consumer-owned ports | Pure supporting crates; neither CLI nor concrete adapters |
| `tmt-adapters`   | SQLite repositories/migrations, tmux subprocess/metadata/capture/paste, bounded file/stdin IO, configuration and skill filesystem effects       | Core and concrete IO dependencies                         |
| `tmt-cli`        | One grammar, typed invocation translation, composition/lazy resource lifetime, stdout/stderr/exit mapping, completion and help                  | Core and adapters                                         |

The CLI's composition root injects clocks, subprocess and repository capabilities;
commands do not open independent connections. Adapters do not import CLI rendering.
Keep feature types near their owner, private helpers local, and one implementation
of identity selection, request transitions and retention. No generic manager,
plugin registry, repository-per-command, or parallel semantic CRUD layer.
Future MCP would call the same use cases through another adapter, not invoke
CLI handlers or duplicate SQL. No MCP SDK dependency is needed now.

Three packages give enforceable dependency direction; a package per command adds
coordination without a new boundary. A single package would be simpler initially
but leaves IO-to-domain import restrictions solely to review. The proposed split
is by responsibility, not a mechanical copy of every TypeScript file.

### Implemented native preview

The `rust/` workspace contains `tmt-core` (numeric and settings policy),
`tmt-cli` (grammar, typed invocation translation and output), and `tmt-adapters`
(SQLite lifecycle under #97 with schema 9 under #108, configuration files under #103 and Unix
tmux evidence under #105). The npm entry points still execute TypeScript. No command silently
delegates from native to Node.

The preview implements help, version, Bash/Zsh completion and the existing
`config` command. Other recognized effectful commands return
`NATIVE_NOT_IMPLEMENTED`, exit 1, before any settings,
storage, tmux or input acquisition. Text-only commands reject JSON. Native
`name`/`this`/`add` parse temporary defaults and save flags; `rm`/`remove` parse
explicit force. This is not evidence that native lifecycle operations work.

The planned #100 listing includes all non-retired temporary and saved identities,
including saved offline identities. It exposes lifetime separately from verified
presence: `temporary`/`saved` and `active`/`offline`/`unknown`. Unavailable evidence
is not proof of death; retired temporary identities are omitted, while offline
saved identities continue to reserve their names. Visibility does not silently
expand current-server routing or justify unbounded per-identity tmux queries.
The implementing issue must define exact JSON and failure precedence and test
cross-directory name collisions, promotion, retirement/reuse, preserved exchanges
and truthful unknown presence. These are planned native changes, not installed
TypeScript behavior or a second identity registry.

#103 makes settings an invocation-owned shared boundary rather than a rule set
inside each CLI handler. Core owns typed defaults, scalar bounds, setting scope
and clear policy; the adapter discovers existing paths, validates/project raw
JSON and preserves opaque fields during edits. CLI composition renders reports
after file operations. Config never opens SQLite or contacts tmux. Targeted
repair validates container shape before editing, then validates remaining known
values before writing; it does not pre-load unrelated invalid runtime settings.
Negative numeric config operands reach semantic validation, while unknown flags
remain parser errors. No JSON identity registry or new configuration setting is
introduced by this port.

Configuration decoding enables serde_json's `arbitrary_precision` so valid
large exponents reach the compatibility boundary, then normalizes numbers to
the reference runtime's IEEE-754/JSON.stringify semantics (non-finite opaque
values become null when edited; known invalid fields still fail). This policy
is shared by config and editable pane metadata under #105, not a global
reply/body transformation. `preserve_order` avoids
reordering ordinary user objects on targeted writes. The added locked graph is
indexmap 2.14.2, hashbrown 0.17.1 and equivalent 1.0.2, with MIT/Apache-2.0 choices
and declared MSRVs at or below 1.85. RustSec RUSTSEC-2024-0402 is patched before
the selected hashbrown version; the other two packages had no entries at the
recorded advisory revision. Structured CLI JSON contracts do not require byte
equality of whitespace or numeric spelling between serializers.

One Clap registration tree owns recognition and allowed options. Its public
projection removes hidden rejection syntax and inherited-but-unrelated options
before help/completion generation. The unbuilt registration tree remains the
authority for command-local validation; typed invocations contain no Clap types.
Core validity rules are shared with the CLI's numeric syntax adapter.

Clap stops at an unknown option whereas Commander may retain later flags.
The error-only diagnostic adapter derives option arity/scope from that same tree,
skips entire option values and stops at `--`; it only chooses presentation mode.
It never repairs input, constructs requests or dispatches effects. Regression
cases cover unknown options before a real `--json`, inline flag-like values,
required values and literal operands. It is not an independent command parser.

The preview pins Rust 1.97.0, declares MSRV 1.88, and commits Cargo.lock. Actual
locked builds on both versions are required. The selected released dependencies
are Clap 4.6.6, clap_complete 4.6.9 and serde_json 1.0.151. Clap disables defaults,
enabling only std/help/usage/error-context/suggestions/string; the string feature
supports projecting grammar metadata without a duplicate command inventory.
The original grammar slice introduced no derive, color, async runtime or process
dependency; #105 adds the bounded process dependencies described below.
Published manifests for the original grammar graph declare MSRVs at or below 1.85; licenses
are MIT/Apache-2.0 compatible alternatives, with unicode-ident also carrying
Unicode-3.0. RustSec database revision
`5a0ebedfe8bdd2e295b171f4162f8c977bcad9a5` contained no advisory entries for the
locked dependency package names when inspected. This dated inspection is not a
permanent security guarantee; repeat on dependency updates.

#97 pins rusqlite 0.40.2 with default features disabled and only `bundled` enabled,
using libsqlite3-sys 0.38.2. This gives a synchronous adapter with a controlled
SQLite build, including FTS5, without an ORM, pool or extension-loading API.
The added dependency licenses are MIT or MIT/Apache-2.0. At the same RustSec
revision, the nine entries for rusqlite, libsqlite3-sys, shlex and smallvec all
list patched ranges containing the locked versions. Some manifests omit MSRV,
so actual Rust 1.88 locked compilation remains the acceptance evidence.

Historical migrations 1–8 remain unchanged. Native migrations retain their names,
column/index/foreign-key definitions and seven-day migration backfill rather
than applying today's retention configuration retroactively. The private
connection exposes only lifecycle operations until repositories are ported.
A non-installed `storage-probe` example allows bounded cross-runtime tests of
the real adapter, without adding arbitrary SQL or fault flags to public syntax.
Cold concurrent WAL transitions can report retryable busy errors even with a
busy timeout; this preserves the existing storage boundary, not an all-openers
success guarantee. See [SQLite busy-handler behavior](https://sqlite.org/c3ref/busy_handler.html).

#108 appends native schema 9: the same identity table gains `lifetime` and
`retired_at_ms`, with a partial unique canonical-name index for non-retired rows.
Existing rows become saved; their UUIDs, names and timestamps are unchanged.
The migration does not implement retirement commands or erase dependent state.
Its reviewed rebuild follows the
[SQLite generalized ALTER TABLE procedure](https://www.sqlite.org/lang_altertable.html#otheralter):
temporarily disable foreign keys outside the immediate transaction, preserve
the table contents, validate foreign keys before commit and restore enforcement
on all normal success/error paths. The source definition must match the frozen
historical identity table apart from whitespace; custom columns, constraints,
indexes or triggers are rejected instead of silently removed. No ORM, alternate
registry or dependency is added.

### Execution and resource ownership

#105 implements one Unix runner using `subprocess` 1.2.1 for simultaneous pipe
communication, `nix` 0.31.3 with only signal/process features for typed OS
operations, and UUID 1.26.0 for v4 server IDs (pure parsing in core; generation
in adapters). The standard library's safe `CommandExt::process_group` is
available, but does not itself provide concurrent bounded pipe communication.
Using a narrow maintained primitive avoids another hand-written poll loop or
an async runtime. The workspace still forbids authored unsafe code.

The complete lockfile adds 24 packages, but only seven additions are active in
the inspected Linux/macOS graphs: subprocess, nix, uuid, getrandom 0.4.3,
libc 0.2.189, cfg-if 1.0.4 and build-time cfg_aliases 0.2.2. The other 17 are
target-only Windows/WASM/UEFI entries, not a linked async runtime on Unix.
All additions offer MIT or Apache-2.0 licenses; r-efi also offers LGPL as an
alternative, which is not selected. Declared MSRVs do not exceed 1.88; some
manifests omit them, so actual locked MSRV compilation remains required.
The inspected RustSec snapshot is the revision recorded above: nix's
RUSTSEC-2021-0119 affects old getgrouplist implementations and is patched before
0.31.3; that API is outside the enabled features. No other added package had an
advisory entry in that dated snapshot. This is neither a permanent security
guarantee nor verification of untested Windows/WASM/UEFI runtime targets.

Retain the `Job` from `Exec::start`; detached `Exec::communicate` and consuming
timeout convenience methods do not satisfy ownership/cleanup requirements.
Custom bounded stream sinks classify overflow and never return successful
partial output. Communication and process exit share the remaining deadline;
EOF alone is not completion. Failure kills the owned group and waits with a
separate one-second cleanup budget; cleanup failures retain their cause and
propagate through optional caller/target and live/dead/unknown probe boundaries.
They cannot authorize metadata fallback writes. A fallback destructor is bounded
but does not replace explicit error reporting.

Darwin can return EPERM for a zombie-only group. The adapter reaps its owned
leader and clears that error only if a read-only group probe returns ESRCH;
live, denied or unknown groups remain failures. It never signals the numeric
group again after reaping. This follows the zombie filtering in Apple's
[XNU group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c).
The tests exercise overflow, ignored termination, inherited output descriptors,
EOF-before-exit and simultaneous input/output pressure with observable cleanup.

Native endpoint and caller protocols share strict decimal wire parsing. Synthetic
hex/exponent/signed PID fields previously accepted by Number coercion are now
rejected; real tmux/ps decimal output is preserved. This is a fail-closed evidence
boundary, not a broader identity namespace or lifetime policy change. The
development-only probe and Docker scenarios do not implement identity commands,
badge presentation, message delivery, or runtime cutover.

Start with synchronous use cases and SQLite, without Tokio in ordinary CLI startup.
Polling is bounded and does not require an async framework. The command lifetime
owns one lazy connection and an explicit fallible `finish`; RAII alone cannot
report checkpoint/close failures. Dispose before emitting one JSON document.
Preserve primary errors when cleanup also fails; only replace success with
`CLEANUP_ERROR` and bounded correlation. Never call process exit from a use case.

The subprocess adapter needs concurrent bounded draining of stdout/stderr,
monotonic deadlines, timeout kill **and reap**, and signal-aware observer wakeup.
Do not replace bounded calls with unbounded `Command::output`. Rust's `Child`
does not automatically wait or kill on drop; ownership must be explicit.
[Standard library lifecycle contract](https://doc.rust-lang.org/std/process/struct.Child.html).

Keep SQLite's 5-second busy timeout and immediate writer lock for binding,
followed by the existing 3-second bounded tmux coordination budget. Do not move
authoritative snapshots before lock acquisition. Durable identity creation is
a separate commit from endpoint publication. Request transactions stay short;
none spans transport or polling. SQLite/tmux cannot atomically commit together:
preserve inactive orphan-marker recovery rather than inventing a second registry.

Async alternatives remain possible at the future MCP boundary: a blocking worker
may own each connection, with bounded scheduling and cancellation semantics.
Do not share a connection across arbitrary tasks or hold a transaction across
an async suspension. Re-evaluate with actual MCP concurrency requirements;
current CLI contracts do not justify a daemon, pool or async SQL rewrite.

### Dependencies and toolchain evaluation

Research checked 2026-09-07; these are candidates, not installed or locked versions.

| Candidate                                           | Reason and gate before adoption                                                                                                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clap 4                                              | A maintained grammar/help foundation instead of hand-written argv slicing. Use fallible parsing and adapt errors to TMT's output boundary. Test option placement, negative payloads, aliases and JSON rejection against Commander; derive defaults do not establish parity. |
| rusqlite 0.40.x with bundled SQLite                 | Synchronous SQL fits current explicit transactions. Bundling avoids depending on the user's SQLite build. Verify FTS5, WAL, pragmas, extended error classification and target builds; do not enable extension loading or an ORM without a requirement.                      |
| serde/serde_json                                    | Typed public projections plus raw unknown config fields. Verify omitted versus null fields, integer limits, control/Unicode handling and receipt canonicalization. Do not serialize internal endpoints into generic errors.                                                 |
| uuid, base64, a focused timestamp library           | Prefer maintained codecs over new ones. Restrict features; prove UUID syntax, unpadded canonical base64url, UTC millisecond timestamps, and receipt byte compatibility with fixtures.                                                                                       |
| A narrow Unix signal/process dependency if required | Use only for the concrete kill/reap/wakeup gap; compare standard-library support first. No global runtime or broad framework solely for a signal handler.                                                                                                                   |

Clap's inspected upstream manifest declares Rust 1.85 and edition 2024; upstream
rusqlite declares Rust 1.88.0. These are moving upstream snapshots, **not proof of
a released version's dependency graph**. Proposed initial MSRV is at least 1.88;
the scaffold issue must select released versions, inspect their published
manifests and transitive graph, commit Cargo.lock and an exact rust-toolchain,
and verify both declared MSRV and selected toolchain. No unsupported MSRV promise.
[Clap manifest](https://raw.githubusercontent.com/clap-rs/clap/master/Cargo.toml),
[rusqlite manifest](https://raw.githubusercontent.com/rusqlite/rusqlite/master/Cargo.toml).

Use edition 2024 and explicit workspace resolver 3. Cargo's Rust-version-aware
resolver helps choose compatible dependencies but does not replace an actual
locked build. Review licenses and advisories, use `cargo fmt --check`, Clippy with
warnings denied, unit tests and locked builds. Prefer no new dependency when
standard-library functionality satisfies the bounded contract.
[Cargo resolver](https://doc.rust-lang.org/stable/edition-guide/rust-2024/cargo-resolver.html).
Bundled rusqlite 0.40.2 is documented as compiling its own SQLite; platform
artifact verification still has to establish the actual features and linkage.
[Published rusqlite documentation](https://docs.rs/crate/rusqlite/0.40.2).

## Compatibility matrix

Examples below are essential fields, not complete JSON schemas. Dynamic UUIDs,
timestamps and pane IDs are correlated, not hard-coded. Unmentioned existing
options remain supported: [parser](src/cli/parser.ts) and typed
[requests](src/cli/requests.ts) own the full grammar.

| Input / scenario                                                     | Observable contract to preserve                                                                                                                                                                                                                                   | Existing evidence                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name Alice`, `this Alice`, `add %14 Alice`                          | Bound name/pane result; `this` remains an alias. `10.3` is resolved to stable server/pane evidence. Create unknown identity without a role. Occupied-pane failure may retain newly committed offline identity, never undo another binding.                        | [identity lifecycle](test/e2e/identity-lifecycle.e2e.test.ts), [retention](test/e2e/identity-retention.e2e.test.ts), [publication race](test/e2e/publication-race.e2e.test.ts)                                               |
| `whoami`, `unbind`                                                   | Verified caller, bound/unbound distinction; missing caller gives `PANE_NOT_FOUND`/3 before storage. Unbind removes endpoint, not identity/profile, without unrelated config dependency.                                                                           | [caller context](test/e2e/caller-context.e2e.test.ts), [identity lifecycle](test/e2e/identity-lifecycle.e2e.test.ts)                                                                                                         |
| Stripped, malformed or conflicting environment                       | Bounded real ancestry can recover missing evidence; ambient active session is not a caller. Malformed supplied evidence fails closed. No warning-only pretend binding.                                                                                            | [real descendant fixture](test/e2e/real-tmux-caller.ts), [caller context](test/e2e/caller-context.e2e.test.ts)                                                                                                               |
| `list`, `list Alice`, `check Alice --lines 20`                       | Active verified presence versus diagnostic capture. Pane-first selector rules; grouped/linked rows all validated before deduplication; attached-row presentation preference. Targeted operations do not reconcile unrelated bindings.                             | [grouped sessions](test/e2e/grouped-session.e2e.test.ts), [large sessions](test/e2e/large-session.e2e.test.ts), [multiple servers](test/e2e/multi-server.e2e.test.ts), [capture limits](test/e2e/capture-limits.e2e.test.ts) |
| `identity create/show/list`, explicit `role --identity Alice`        | Durable identity works offline, canonical collision reuses UUID; explicit data access never probes tmux or loads unrelated malformed config. Identity is attribution, not authentication or a recipient inbox.                                                    | [durable identity](test/e2e/durable-identity.e2e.test.ts), [roles](test/e2e/role-lifecycle.e2e.test.ts)                                                                                                                      |
| Preamble CRUD and talk cadence                                       | One durable identity-owned source, bounded content, shared identity selection; cadence reservation and failure behavior preserved.                                                                                                                                | [preambles](test/e2e/preamble-lifecycle.e2e.test.ts), [request state](test/e2e/request-state.e2e.test.ts)                                                                                                                    |
| `talk Alice "work" --identity Owner --json`                          | Originator distinct from recipient; retained original prompt distinct from protected transport. Explicit final completes request, not terminal output or summary. Recipient instruction retains reply guidance and summary-after-success rule.                    | [durable talk](test/e2e/durable-talk.e2e.test.ts), [request context](test/e2e/request-context.e2e.test.ts), [message builder](src/tmux-message.test.ts)                                                                      |
| Talk timeout, interruption, detach, transport faults                 | Default 180s; timeout begins before send after preparation/delay, includes transport, exits 4 without cancelling work. Detach returns correlation. No resend after uncertain paste/Enter; safe fallback only before paste. `!` must not trigger agent shell mode. | [durable talk](test/e2e/durable-talk.e2e.test.ts), [transport safety](test/e2e/transport-safety.e2e.test.ts)                                                                                                                 |
| `reply <id> --receipt <token> --message "done"`, file/stdin variants | Exactly one input; exact UTF-8 through 1 MiB including file/stdin NUL, bounded EOF deadline. Identical retained retry keeps original time; mismatch/conflicting final exits 5. Receipt is local correlation, not authorization.                                   | [response integrity](test/e2e/response-integrity.e2e.test.ts), [reply lifecycle](test/e2e/reply-child-lifecycle.e2e.test.ts), [receipt codec](src/reply-receipt.test.ts)                                                     |
| `result <id> --json` outside tmux                                    | Completed exact body or unavailable/`RESPONSE_NOT_AVAILABLE`/3. Unknown, pending and expired are not falsely distinguished. Reads do not acknowledge or renew retention.                                                                                          | [response integrity](test/e2e/response-integrity.e2e.test.ts), [exchange retention](test/e2e/exchange-retention.e2e.test.ts)                                                                                                 |
| `x list/show/ack/ackall --identity Owner`                            | Originator-scoped attention; reads are not ack. Per-revision ack and transactional ackall watermark; late final reopens attention. Settled is final plus ack, not work success.                                                                                   | [exchange attention](test/e2e/exchange-attention.e2e.test.ts), [attention migration](src/storage/request-attention-migration.test.ts)                                                                                        |
| `config set exchange.retentionDays 90 --global`                      | New requests freeze retention; historical requests retain seven days. Expiry is logical with bounded opportunistic cleanup, not autonomous SQLite TTL. Unknown config remains raw; known invalid values fail even when overridden.                                | [config policy](src/config.test.ts), [exchange retention](test/e2e/exchange-retention.e2e.test.ts)                                                                                                                           |
| `config set ui.paneBadge on --global`, then bind                     | Default off; setting alone does not scan or mutate panes. Binding validates config first, then best-effort cosmetic update after durable success. Never overwrite user titles/window border format/style.                                                         | [pane badges](test/e2e/pane-badge.e2e.test.ts)                                                                                                                                                                               |
| `learn --skill`, `install`, `install --dir <root>`                   | Exact canonical skill bytes; existing provider paths, non-interactive mode, custom-root isolation, source-overlap rejection, recoverable force backups and drift checks. No provider app install or reload.                                                       | [install](src/commands/install.test.ts), [packed verification](scripts/verify-packed-native-install.mjs)                                                                                                                     |
| Bad options, text-only command with JSON, cleanup error              | Parser fails before resources. One buffered JSON document after disposal, stable codes/status and stderr policy; literal payload flags do not change mode. Retired `wait`, `update`, `rm` etc stay rejected until a separately approved contract changes them.    | [options](test/e2e/command-options.e2e.test.ts), [CLI errors](test/e2e/cli-errors.e2e.test.ts), [retired commands](test/e2e/retired-commands.e2e.test.ts), [runner](src/cli-runner.test.ts)                                  |

### Portability risks not established by current green tests

The baseline's 1,077 unit and 96 Docker tests are evidence, not complete coverage.
No existing test proves Rust parity or mixed-runtime operation. Explicitly add:

- JavaScript safe-integer bounds versus Rust i64/u64, checked runtime retention
  arithmetic versus the historical migration's explicit saturation,
  millisecond date formatting, Unicode trim/lowercase and ASCII numeric syntax.
  Never substitute Unicode case folding for existing canonicalization silently.
- Canonical receipt key order/base64url round-trip, invalid UTF-8/lone surrogates,
  raw unknown config preservation and public missing/null fields. Serde defaults
  are not a compatibility specification.
- Native signal/process-tree cleanup, bounded pipe capture and real stripped-env
  ancestry on supported macOS/Linux targets; a Node-wrapper PID test alone cannot
  prove a direct native binary follows the same causal caller rules.
- Same-scenario execution against each binary, migration from each supported
  historical schema, mixed writers/readers and live receipt handoff, rather than
  comparing two empty databases or only a dependency's ability to open SQLite.

## Test architecture transition

Keep Vitest, Docker, private tmux sockets and deterministic mock agents.
[#95](https://github.com/wkh237/tmux-team/issues/95) adds the shared test-only
executable descriptor (absolute binary plus argv prefix), validated before fixture
allocation and used by CLI contracts, E2E, mock replies, real descendants and the
resource probe. Missing/non-executable selection fails without TS fallback.
Default remains TS until explicit cutover; an explicit peer descriptor supports
future mixed-runtime cases. See [selector usage](DEVELOPMENT.md#selecting-the-cli-under-test).
The seam itself proves neither native behavior nor mixed-runtime compatibility.

Keep SQL oracles independent and read-only. Existing TS unit tests importing
services/worker modules remain TS regression tests while corresponding Rust
units/concurrency tests are built; do not count them as native evidence. The
packed storage probe imports TS runtime modules and therefore needs an artifact
inventory/public-CLI/independent-SQL replacement before native cutover. Retain
the incompatible-history, concurrency and cleanup assertions it currently proves.
Grammar/architecture AST guards also need native equivalents, not deletion.

Run the full shared suite per runtime once supported; interim subset selection
must be explicit in the issue and cannot be represented as full parity. Keep
benchmark timing outside ordinary CI pass/fail assertions; causal behavior and
subprocess bounds remain deterministic gates. See [baseline protocol](PERFORMANCE-BASELINE.md).

## Data, receipt and coexistence fixture plan

Preserve the exact ordered migration 1–8 version/name history in
[migrations.ts](src/storage/migrations.ts), SQL invariants and data transforms.
Do not introduce a new migration framework with a different history table.
Use offline task-owned copies generated by the baseline TS runtime, with known
UUIDs, profiles, preambles, binding evidence, cadence, retained prompts/finals,
retention deadlines and attention revisions. Never copy a live WAL database by
copying just its main file; use a consistent SQLite backup or close/checkpoint
the isolated fixture before copying. WAL requires local shared-memory semantics;
network filesystems are not a new supported deployment.
[SQLite WAL documentation](https://www.sqlite.org/wal.html).

Original schema-8 coexistence matrix (historical plan, superseded by #108's
forward-only identity amendment below):

1. TS creates and closes data; Rust opens/reads/writes; TS reopens and sees the
   same identity UUID and exact bodies without reset. Repeat in reverse order.
2. Historical prefixes 0–8 migrate with preserved data and recorded names;
   newer, renamed, missing or non-contiguous history fails without repair/reset.
3. TS talk emits receipt, Rust reply accepts it, TS result reads it; reverse the
   runtimes. Exercise in-flight sending/sent/uncertain, late reply after timeout,
   identical retry after acknowledgement loss and conflicting second final.
4. Concurrent mixed-runtime identity collision, binding publication/reconciliation,
   reply race, ackall versus late final and cleanup versus active waiter. Reuse
   existing barriers; verify committed state independently, not only exits.
5. Read-only/corrupt/locked storage, private file modes, foreign keys, WAL,
   synchronous NORMAL, FTS5 and close/checkpoint failure classification.

#97 delivered the unchanged schema-8 storage baseline. #108 intentionally moves
the native preview to schema 9; baseline TypeScript rejects it. Mixed-runtime
writers/readers and binary rollback to schema-8 TS are not supported after this
upgrade. Do not weaken history validation or maintain a second native legacy
mode just to preserve a transitional test. Native development uses isolated
fixtures, never a live user database.

Before release, #82/#93 must stop old writers, create a consistent recoverable
backup and explain that binary rollback is not schema downgrade. Acceptance
still requires every supported historical prefix, exact retained records,
native concurrent lifecycle/attention races, and execution of old v1 receipts
against migrated in-flight and retained requests. #106 owns receipt transition;
this schema slice proves preservation, not execution. A restored pre-upgrade
backup cannot include work written after upgrade; recovery must not promise
lossless downgrade. Final cutover removes the production TS runtime and
redundant transitional adapters; Node-based tests and historical fixtures may stay.

## Delivery gates

Preparation produces this decision, test inventory and measured TS baseline.
Next comes [executable selection (#95)](https://github.com/wkh237/tmux-team/issues/95),
then [native grammar (#96)](https://github.com/wkh237/tmux-team/issues/96) and
[storage foundations (#97)](https://github.com/wkh237/tmux-team/issues/97), then
the smallest identity-to-durable-reply vertical slice. Complete the remaining
contracts and mixed-runtime matrix before cutover and distribution readiness.
Each implementation PR has its own issue/worktree, bounded contract matrix,
local checks, primary review and one candidate CI push. Split any slice that
cannot remain reviewable; preparation does not pre-authorize one giant rewrite PR.

Unresolved release decisions owned by #82 include minimum macOS/glibc versions,
musl artifacts, signing/provenance, atomic upgrade/rollback, PATH/manager ownership,
skill relocation and clean install without Node. Do not promise native support
based on a developer's successful macOS build alone.
