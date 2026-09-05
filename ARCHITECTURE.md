# Architecture

This is the maintained map of the checked-in v5 implementation, its design
constraints, and known deviations. It is not a promise that all boundaries are
already enforced. [AGENTS.md](AGENTS.md) owns review policy,
[CONVENTIONS.md](CONVENTIONS.md) owns coding style, and
[DEVELOPMENT.md](DEVELOPMENT.md) owns verification commands. Issue specifications
describe proposals; update this map when the implemented changes land.

## Product and state boundaries

TMT is a CLI-owned, local collaboration tool. Each invocation performs its work
and exits. The current implementation has no TMT daemon, network storage service,
identity memory, or durable inbox. Adding a command does not imply those features.

- Durable identities and optional role profiles live in local SQLite. Identity
  is distinct from its transient tmux binding; pane death, unbind, or restart
  must not erase the durable identity or profile.
- Active presence requires agreement among database binding, server instance,
  pane process and identity metadata. Titles are presentation, not identity.
- Names are unique within one local database. Discovery and `talk`/`check`
  routing are current-server-only. `%pane_id` is not unique across servers;
  socket and server/pane process evidence matter.
- Ordinary reconciliation preserves bindings on other sockets. Foreign-name
  collisions use bounded read-only probing; uncertainty is not evidence of death.
- Global identity and preamble content are independent of working directory.
  Workspace `$config` still supplies local settings; old registration fields
  are ignored. Request/cadence state uses the same local SQLite connection;
  legacy JSON request state is ignored and left untouched.
- Role documents are stored data, not executable instructions or automatically
  injected preambles. Explicit durable role access works without tmux; implicit
  access requires verified caller identity.

## Identity-owned preambles

Migration 3 adds `identity_preambles`, keyed by durable identity ID in the same
SQLite database and connection as identities/roles. A narrow application-owned
preamble repository contract supports offline explicit-name CRUD and listing.
The shared durable selector resolves existing names; preamble commands neither
create identities nor infer the caller. Existing positional show/set/clear
grammar and agent/preamble JSON result fields remain; missing identities now
fail explicitly rather than behaving like empty legacy registrations.

Preambles and roles share pure bounded text normalization, not ownership or
injection semantics. Each retains feature-specific error codes. Preamble
updates replace complete content; clear affects only that identity's preamble.
Unbind, pane death and rebind do not erase it. Binding failures never delete
committed identities, regardless of whether they have a preamble or profile.

Talk composes preambles once through a shared delivery-preparation path before
existing wait marker framing and transport protection. A verified bound direct
pane uses the same identity preamble as a name; unnamed panes use none. Storage
lookup failure stops preparation rather than silently omitting the prefix.
The `[SYSTEM: ...]` prefix is ordinary delivered text, not an authenticated
provider system-message channel.

Existing mode/every settings remain. Eligible attempts reserve identity-ID-keyed
SQLite cadence at effective counts 1, 1+N, ...; disabled/no-content/N=0 paths
do not advance it. Set, clear and rebind do not reset cadence. No old JSON
counter import or deletion occurs, so this cutover begins a fresh cadence.
Reservations include pending, sent and uncertain attempts; only proven unsent
attempts refund the effective count for future decisions. Already prepared
payloads are immutable. Reservation order is deterministic under transactions,
but overlapping failures do not promise exact successful-send spacing. That
would require serializing transport, which is not introduced.

Legacy registry adapters and configuration imports are removed. Local settings
editing preserves unknown JSON keys; ordinary preamble operations never rewrite
old files. Opaque old workspace/team metadata is preserved on binding writes
but never supplies identity routing, preambles or deny-policy enforcement.
There is no automatic preamble migration, role conversion or user-file deletion.

These are invariants to protect. Known delivery
gaps below remain limitations, not guarantees supplied by this document.

## Request/response research boundary

Current `talk --wait` completion and body extraction rely on terminal capture;
a matching end marker is not proof of a complete, isolated response body.
`check` is a diagnostic pane snapshot, not correlated response retrieval.
The [request/response decision document](REQUEST-RESPONSE.md) records TMT-35's
source evidence, capability limits and staged proposal. Its structured service
has only its transactional bookkeeping foundation shipped: marker behavior and
CLI grammar remain unchanged, and final-body storage/retrieval is still deferred.
Keep this distinction
and the document's verification status current as those slices are delivered.

## Message delivery and uncertainty

The tmux message adapter prepares one payload with the existing ASCII `!` to
fullwidth substitution and trailing-newline policy. This protects coding-agent
shell-mode shortcuts; it is not literal code delivery or provider capability
detection. Buffer paste is preferred. Only a set-buffer failure before paste
has been invoked permits one literal-key fallback with that same payload.
Normal and fallback paths share the configured delay and Enter submission.

Once paste or literal input has been invoked, failures are uncertain and cannot
trigger replay or another Enter. The narrow message-delivery error contract
carries the failed stage without coupling commands to the concrete tmux adapter.
Both wait and non-wait `talk` map it to `DELIVERY_UNCERTAIN` (exit 1), with
inspection guidance; successful result shapes remain unchanged. Exact-attempt
SQLite cleanup never changes another waiter or refunds a sent/uncertain attempt.
Transport typing alone does not supply complete response-body correlation.

Transport subprocesses have a one-second timeout, SIGKILL termination and a
64 KiB output bound. Argv-based capture has a one-second timeout and 4 MiB output
bound; overflow/failure does not return a successful partial capture. These
bounds are separate from configured Enter delay and response timeout. Temporary
buffer cleanup targets only the operation's unique buffer and cannot change
the delivery outcome. There is no exactly-once agent-processing guarantee.

## Transactional live request state

The request application service owns preparation, transport state, waiter
release and preamble reservation policy through a narrow repository port.
The concrete request adapter composes over Context's existing SQLite connection;
it does not open a second handle. Migration 4 adds attempt metadata and persistent
identity cadence totals. Neither prompts nor response bodies are stored here.

Each invocation receives an immutable request/attempt identity and records full
server ID, socket, server PID/start time, pane ID and pane PID. An endpoint is
not a display name or `%pane_id` alone. Multiple waits on the same endpoint
retain independent rows; the overlap warning is advisory and `--force` only
suppresses that warning. This is bookkeeping isolation, not transport
serialization or proof that terminal-captured responses cannot interleave.

Preparation and marking `sending` commit in separate short transactions before
the external effect; no request transaction spans tmux, capture or polling.
Successful transport becomes `sent`. Stageful and generic unknown send failures
are conservatively `uncertain`. Only evidence of no input, including an expired
still-prepared attempt, permits a refund. An expired prepared attempt cannot
later start sending; an expired sending attempt becomes uncertain. Conditional
settlement/refund is idempotent and cannot mutate another request.

Wait release does not cancel recipient work or alter delivery outcome. Expiry is
at least one hour and extends for configured send/wait budgets. Opportunistic
cleanup prunes terminal metadata after 24 hours while keeping cadence totals.
This policy is not future final-response retention. A failure before reservation
or begin-send stops input; a post-send persistence failure cannot safely imply
non-delivery. Commands report `REQUEST_STATE_ERROR` with inspection guidance
when appropriate. There is no automatic retry, daemon or inbox in this slice.

## Caller context

The tmux adapter owns current-pane evidence: a strict `TMUX_PANE` ID and the
socket/server PID in `TMUX` must agree with a bounded, read-only query of that
explicit pane. Missing, malformed, stale or mismatched evidence yields no caller;
there is no ambient/default-pane fallback. Environment evidence selects local
context, not an authenticated principal, and is not a defense against deliberate
environment spoofing.

`name`, `this`, `whoami` and `unbind` reject missing caller context with
`PANE_NOT_FOUND` (exit 3) before opening identity storage. Implicit role access
uses the same caller policy and returns `IDENTITY_REQUIRED` (exit 1) without
bootstrapping storage or reconciling unrelated bindings. Context keeps repository
access lazy until a selected operation needs it. A valid unbound pane is still
distinct from an absent caller.

Explicit `add`, `talk` and `check` target resolution remains available outside
tmux; explicit `role --identity` access remains storage-only. These selectors
choose a target or data owner, not the caller's identity. No listener, non-tmux
identity binding, memory or inbox is implied by this boundary.

## Binding publication and recovery

Identity creation and binding publication are distinct commit points. Invalid
names and missing preflight pane evidence create no identity. Once the identity
INSERT commits, every later binding failure retains that UUID, even when another
operation only observed it without writing a profile. A valid new name attempted
on an occupied pane still fails with `PANE_ALREADY_BOUND` (exit 5), but the new
identity remains offline. Retrying on an available pane reuses it. This trades
possible unused names for durable observation safety; no feature-table-specific
deletion guards, automatic garbage collection or identity deletion API exist.
Active discovery still requires a verified binding; explicit data access does not.

Binding publication, active reconciliation and unbind share the repository's
SQLite immediate-transaction boundary. Authoritative endpoint snapshots are
taken after acquiring the write lock, so a reconciler cannot prune a new
binding using evidence captured before publication. Bind verifies the written
metadata against fresh server/pane evidence before committing its success.

The lock acquisition uses the existing five-second SQLite busy timeout. Tmux
work inside the boundary shares a three-second monotonic deadline after lock
acquisition, including metadata fallbacks and bounded foreign probes. Exhausted
budgets or failed observations abort the operation; a failed metadata read is
not treated as permission to overwrite unrelated pane fields. This intentionally
trades bounded writer contention for a small coordination protocol, without a
new lease table or a grace-period heuristic.

SQLite and tmux are not a distributed atomic transaction. A crash after metadata
publication but before commit can leave an orphan marker; it is inactive because
no committed binding agrees with it. Reads never backfill it. Explicit binding
can replace it. An interrupted unbind may leave a row with missing metadata;
subsequent reconciliation removes that inactive binding, not the durable identity
or role profile. Success describes verified presence at the commit point, not a
promise that the pane cannot exit or another operation cannot unbind it later.

## V5 compatibility policy

V4 compatibility belongs to the maintenance branch, not a parallel v5 runtime.
V5 has one durable SQLite identity model. Earlier name-only v5 pane markers
are not automatically imported: discovery accepts only validated durable
metadata that agrees with the recorded binding. Explicit `name`, `this`, or
`add` can establish a supported binding; reads do not upgrade old markers.

Remove obsolete compatibility paths through bounded, tested changes rather
than adding fallbacks. Do not delete existing user files as part of code
removal. Preserve supported product behavior, including the `this` alias,
coding-agent `!` shell-mode protection, and durable identities/profiles.
The legacy `update`, `remove`/`rm`, and `migrate` commands and their handlers
are removed. The shared parser rejects them before lazy resources are accessed;
they do not delete or migrate user data. Workspace registry consumers are
removed; preambles now have one durable identity-owned source. Identity services
are required lazy dependencies, not optional switches to another implementation.
Raw tmux exposes no name-only registration reader/writer; the target resolver's
identity view comes from verified service presence. `init` and local `$config`
settings remain supported.

## Application ports and resource ownership

Identity binding, role profiles and preambles declare their own narrow repository
ports. The SQLite adapter composes these contracts over its existing connection;
application services neither import concrete storage nor open or close it. Context
owns the CLI connection and closes it once during disposal, including after a
service initialization failure. Explicit worker/test composition owns its own
repository handles. Immediate transaction locking and bounded tmux work remain
the binding coordination boundary, not an additional connection per service.

Required identity-service wiring stays lazy to preserve caller validation before
storage. Role's lazy repository adapter also preserves no-storage rejection for
invalid implicit callers; explicit role and preamble operations do not construct
tmux. Missing required dependencies fail closed instead of selecting legacy
behavior. Role and preamble commands retain their existing unavailable-service
error mappings within the shared invocation output boundary.

`TargetResolverPort` contains only pane resolution and the verified active-name
view. The shared target resolver retains pane-first ordering; `identityAwareTmux`
supplies that view through the required identity service. CLI role request types
live in the CLI layer, not in the command handler. Focused AST import checks
cover direct literal imports/re-exports in maintained production sources; they
are not a complete semantic dependency or dynamically computed-import analysis.

## CLI output and lifecycle

The invocation runner owns parsing, initialization, startup checks, dispatch and
final disposal. Context remains the sole repository lifetime owner; the runner
injects its UI and non-returning exit control flow, then disposes once before
publishing the result. Commands do not own process termination. The executable
sets the returned exit status and allows output pipes to drain naturally.

JSON output is buffered per invocation, not captured through global console
patching. Exactly one document goes to stdout after cleanup. Expected command
errors preserve their codes, details and meaningful exit statuses. Parser errors
use `USAGE_ERROR` without constructing Context; configuration parsing uses
`CONFIG_ERROR`; unexpected failures use `INTERNAL_ERROR`. Diagnostics belong on
stderr when requested. Successful commands without a detailed result emit
`{ok:true}`. A cleanup failure replaces a pending success with `CLEANUP_ERROR`
and an effects warning, but cannot replace an existing primary failure/status.
This is output consistency, not rollback of command effects.

The alpha timeout envelope intentionally changes only its `error` string to
`{code: "TIMEOUT", message}`. Exit 4, status, correlation/target fields and
nullable partial response remain. SIGINT only signals and wakes the talk poll;
the awaited command flow releases its waiter and exits through the runner.
It must not throw exit control flow across an event callback. Neither timeout
nor interruption cancels recipient work or alters recorded delivery certainty.

Text-only help/version/completion/learn reject JSON mode with `JSON_UNSUPPORTED`
before effects; upgrade retains its JSON rejection. No new text-command schemas
or grammar are introduced. Runtime boot failures before application loading and
unwritable output streams are outside the one-document guarantee.

## Current module map

| Location                                                                                                                                 | Responsibility and integration points                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bin/tmux-team](bin/tmux-team), [src/cli.ts](src/cli.ts), [src/cli-runner.ts](src/cli-runner.ts), [src/cli-output.ts](src/cli-output.ts) | Executable entry, guarded invocation lifetime and one buffered JSON result after disposal; natural output draining.                                                     |
| [src/cli/parser.ts](src/cli/parser.ts), [src/cli/application.ts](src/cli/application.ts)                                                 | Repository-owned Commander adapter produces typed invocations and capability metadata; dispatcher routes them. Do not create another positional parser.                 |
| [src/context.ts](src/context.ts), [src/types.ts](src/types.ts)                                                                           | Composition and lazy resource lifetime; shared UI, adapter, service and configuration contracts. The shared types module is not a dumping ground for new domain models. |
| [src/commands/](src/commands/)                                                                                                           | CLI orchestration, error mapping and presentation. Some delivery policy still lives in commands; they are effectful adapters, not pure functions.                       |
| [src/domain/](src/domain/)                                                                                                               | Pure name validation, bounded text normalization, feature-specific errors and identity models; no alternate in-memory binding model.                                    |
| [src/identity-service.ts](src/identity-service.ts)                                                                                       | Durable binding, presence, reconciliation and an application-owned identity repository port; supplies verified identities to the target resolver.                       |
| [src/role-service.ts](src/role-service.ts), [src/identity-context.ts](src/identity-context.ts)                                           | Role use cases with an application-owned repository port and shared durable explicit/implicit identity selection.                                                       |
| [src/target-resolver.ts](src/target-resolver.ts)                                                                                         | Shared name/pane resolution; pane-shaped arguments are resolved before names.                                                                                           |
| [src/storage/](src/storage/)                                                                                                             | SQLite lifecycle, migrations, errors and SQL implementing composed application-owned repository ports; Context owns the CLI handle.                                     |
| [src/tmux.ts](src/tmux.ts)                                                                                                               | External tmux commands, snapshots, opaque metadata preservation and paste/capture. No workspace registry adapter.                                                       |
| [src/tmux-message.ts](src/tmux-message.ts), [src/message-delivery.ts](src/message-delivery.ts)                                           | Stageful protected input and shared submission policy; narrow delivery uncertainty contract consumed by commands without importing the tmux implementation.             |
| [src/role-content.ts](src/role-content.ts)                                                                                               | Bounded role file reading/UTF-8 decoding; pure role and preamble normalization share `domain/text-content.ts`.                                                          |
| [src/preamble-service.ts](src/preamble-service.ts)                                                                                       | Explicit durable-name preamble CRUD/list and its narrow repository contract. Context composes the existing SQLite connection.                                           |
| [src/config.ts](src/config.ts)                                                                                                           | Path/settings resolution. Legacy registration fields and request JSON are not runtime authorities.                                                                      |
| [src/request-service.ts](src/request-service.ts), [src/storage/request-repository.ts](src/storage/request-repository.ts)                 | Application-owned live request/cadence policy and its composed SQL adapter. Context owns the shared connection.                                                         |
| [src/ui.ts](src/ui.ts), [src/exits.ts](src/exits.ts)                                                                                     | Presentation helpers and exit-code registry; do not invent conflicting mappings.                                                                                        |
| [src/commands/install.ts](src/commands/install.ts), [src/update-check.ts](src/update-check.ts), [skills/](skills/), [plugins/](plugins/) | User-facing integrations, instructions and updates. These differ from repository developer skills in `.agents/skills/`.                                                 |
| [test/e2e/](test/e2e/), [scripts/](scripts/), [.github/workflows/ci.yml](.github/workflows/ci.yml)                                       | Docker fixtures/scenarios, orchestration/pack verification and CI. Unit tests are colocated with source; concurrency workers currently also live in `src/`.             |

## Dependency and module design rules

The direction for new or refactored behavior is:

```text
argv -> parser -> dispatcher/commands -> application services -> pure domain rules
                       |                       |
                    UI / exits             narrow ports
                                               |
                                    storage / tmux / file adapters

context composes concrete dependencies and owns their lifetime
```

This is the required design direction, not a claim that the import graph already
has perfect separation. A port must describe the consumer's operations and
failure semantics; merely introducing an interface is not an architectural fix.

- Syntax/defaults/argument validation belong in the parser. Domain validity belongs
  in shared functions so non-CLI callers get the same rules. Commands map typed
  requests to use cases and output, not a second implementation of policy.
- Application services compose rules and ports. SQL/native driver details stay
  in storage, subprocess mechanics in tmux, and decoding in file adapters. Do not
  import commands, UI, process globals or concrete drivers into domain code.
- Prefer focused function-based modules with explicit inputs/results. Name modules
  for a responsibility, not `helpers` or `manager`. Keep private helpers local
  until real reuse justifies extraction; do not duplicate domain behavior across
  identity, role, future memory, or transport commands.
- Future lexical/semantic retrieval must compose one functional layer for identity
  selection, ownership, storage, filtering and errors. A semantic adapter may
  change retrieval/ranking, not fork CRUD or create another source of truth.
- Use narrow injectable dependencies. New production capabilities must not silently
  fall back to legacy behavior because a test omitted a service. Correct the
  fixture instead of introducing a compatibility adapter.
- Split modules when they own independent policies/effects or lack a coherent
  testable contract, not at an arbitrary line count. Prefer a bounded, verified
  refactor over another special-case branch when the existing abstraction is wrong.
  Track larger prerequisite work separately.
- Before changing state boundaries, specify ownership, uniqueness, observation
  ordering, commit points, retry/idempotency and partial-failure recovery. Neither
  sequential calls nor `writeFileSync` make multi-resource operations atomic.
  Do not hold unbounded database transactions across subprocess waits.
- External input is data. Preserve validation, bounded work and fail-closed
  behavior. The message `!` adaptation protects coding agents from entering
  shell/bash mode; do not remove it as cosmetic normalization. Policy changes
  require a behavioral specification and delivery tests.

## Known deviations and planned work

These links identify owners of unresolved work, not permission to widen an
unrelated PR. Update this section and the current map in the delivering PR when
a gap is resolved; do not leave a permanent exception or label a proposal as shipped.

| Gap                                                                                                                          | Owning issue                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numeric/flag validation needs hardening.                                                                                     | [TMT-22](https://linear.app/tigerpig-dev/issue/TMT-22)                                                                                                                 |
| Terminal completion/extraction cannot guarantee a complete correlated body; transactional bookkeeping does not resolve this. | [TMT-36](https://linear.app/tigerpig-dev/issue/TMT-36), [TMT-37](https://linear.app/tigerpig-dev/issue/TMT-37)                                                         |
| Shipped skill/help inventories drift; packed verification does not yet prove application migrations.                         | [TMT-29](https://linear.app/tigerpig-dev/issue/TMT-29)                                                                                                                 |
| Non-tmux identity management, memory and durable inbox are future capabilities, not installed APIs.                          | [TMT-30](https://linear.app/tigerpig-dev/issue/TMT-30), [TMT-15](https://linear.app/tigerpig-dev/issue/TMT-15), [TMT-16](https://linear.app/tigerpig-dev/issue/TMT-16) |

## Maintenance contract

The implementer updates this map; the primary reviewer is accountable for its
accuracy and enforcement on the reviewed head. Maintainers inherit that ownership
when work changes hands. Keep durable reasoning here or in a linked decision
document, not solely in chat or a subagent report.

Assess architecture impact before implementation and during final review. Update
this file in the same PR when a change affects module responsibility/location,
dependency direction, public command/selector/error contracts, storage schema
or lifecycle, trust boundaries, resource ownership, shared abstractions, test
architecture, or a listed deviation. Update CONVENTIONS, DEVELOPMENT and relevant
skills when their policies or procedures change.

For a significant decision, record the problem, chosen boundary, alternatives
and tradeoffs, observable input/output or state changes, compatibility/migration,
failure behavior and verification plan in the issue before coding. Reflect the
implemented decision here at delivery. If detailed history no longer fits this
map, use a focused linked decision document rather than duplicate rules.

Every PR reports affected sections or a reasoned `Architecture impact: none`
with inspected boundaries. Checkmarks and a green formatter do not prove
conformance. Review callers and tests against this map and resolve drift before
merge. A deferred refactor needs an owning issue and truthful remaining behavior,
not an idealized diagram.
