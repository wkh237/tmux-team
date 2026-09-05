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
- Global identity is independent of working directory. Workspace config,
  registrations, preambles and JSON request state remain compatibility surfaces,
  not new sources of durable identity truth.
- Role documents are stored data, not executable instructions or automatically
  injected preambles. Explicit durable role access works without tmux; implicit
  access requires verified caller identity.

These are invariants to protect. Known delivery
gaps below remain limitations, not guarantees supplied by this document.

## Request/response research boundary

Current `talk --wait` completion and body extraction rely on terminal capture;
a matching end marker is not proof of a complete, isolated response body.
`check` is a diagnostic pane snapshot, not correlated response retrieval.
The [request/response decision document](REQUEST-RESPONSE.md) records TMT-35's
source evidence, capability limits and staged proposal. Its structured service
is not shipped: current marker behavior, JSON bookkeeping and CLI grammar remain
unchanged until their bounded implementation issues land. Keep this distinction
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
inspection guidance; successful result shapes remain unchanged. Request-ID
guarded JSON cleanup remains, but its concurrency limitations are not repaired
by transport typing.

Transport subprocesses have a one-second timeout, SIGKILL termination and a
64 KiB output bound. Argv-based capture has a one-second timeout and 4 MiB output
bound; overflow/failure does not return a successful partial capture. These
bounds are separate from configured Enter delay and response timeout. Temporary
buffer cleanup targets only the operation's unique buffer and cannot change
the delivery outcome. There is no exactly-once agent-processing guarantee.

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
they do not delete or migrate user data. Preamble-related workspace registry
consumers and optional service fallbacks still exist pending TMT-27/TMT-28;
their presence is tracked debt, not a compatibility commitment. `init` and
local `$config` settings remain supported in this staged removal.

## Current module map

| Location                                                                                                                                 | Responsibility and integration points                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bin/tmux-team](bin/tmux-team), [src/cli.ts](src/cli.ts)                                                                                 | Executable/process boundary, startup checks, dispatch, disposal and exit. Some top-level error paths remain inconsistent.                                                              |
| [src/cli/parser.ts](src/cli/parser.ts), [src/cli/application.ts](src/cli/application.ts)                                                 | Repository-owned Commander adapter produces typed invocations and capability metadata; dispatcher routes them. Do not create another positional parser.                                |
| [src/context.ts](src/context.ts), [src/types.ts](src/types.ts)                                                                           | Composition and lazy resource lifetime; shared UI, adapter, service and configuration contracts. The shared types module is not a dumping ground for new domain models.                |
| [src/commands/](src/commands/)                                                                                                           | CLI orchestration, error mapping and presentation. Several commands still contain legacy behavior or delivery policy; they are not pure functions merely because they receive Context. |
| [src/domain/](src/domain/)                                                                                                               | Name/role validation and identity models without filesystem, tmux, SQLite or UI effects. `domain/service.ts` contains the older in-memory binding model.                               |
| [src/identity-service.ts](src/identity-service.ts)                                                                                       | Durable identity binding, presence and reconciliation, plus adaptation to the legacy target resolver.                                                                                  |
| [src/role-service.ts](src/role-service.ts), [src/identity-context.ts](src/identity-context.ts)                                           | Role use cases and explicit/implicit identity selection. Role repository types still derive from the concrete repository interface.                                                    |
| [src/target-resolver.ts](src/target-resolver.ts)                                                                                         | Shared name/pane resolution; pane-shaped arguments are resolved before names.                                                                                                          |
| [src/storage/](src/storage/)                                                                                                             | SQLite lifecycle, migrations, errors and repository SQL. Lifecycle ports exist; domain repository ports are not fully separated.                                                       |
| [src/tmux.ts](src/tmux.ts)                                                                                                               | External tmux commands, snapshots, metadata, paste/capture, and compatibility registry adapter.                                                                                        |
| [src/tmux-message.ts](src/tmux-message.ts), [src/message-delivery.ts](src/message-delivery.ts)                                           | Stageful protected input and shared submission policy; narrow delivery uncertainty contract consumed by commands without importing the tmux implementation.                            |
| [src/role-content.ts](src/role-content.ts)                                                                                               | Bounded file reading/UTF-8 validation; pure normalization lives in `domain/role.ts`.                                                                                                   |
| [src/config.ts](src/config.ts), [src/registry.ts](src/registry.ts), [src/state.ts](src/state.ts)                                         | Path/config resolution and legacy registry/request/counter state. JSON state is not transactional storage.                                                                             |
| [src/ui.ts](src/ui.ts), [src/exits.ts](src/exits.ts)                                                                                     | Presentation helpers and exit-code registry; do not invent conflicting mappings.                                                                                                       |
| [src/commands/install.ts](src/commands/install.ts), [src/update-check.ts](src/update-check.ts), [skills/](skills/), [plugins/](plugins/) | User-facing integrations, instructions and updates. These differ from repository developer skills in `.agents/skills/`.                                                                |
| [test/e2e/](test/e2e/), [scripts/](scripts/), [.github/workflows/ci.yml](.github/workflows/ci.yml)                                       | Docker fixtures/scenarios, orchestration/pack verification and CI. Unit tests are colocated with source; concurrency workers currently also live in `src/`.                            |

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

| Gap                                                                                                                                                      | Owning issue                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Numeric/flag validation needs hardening.                                                                                                                 | [TMT-22](https://linear.app/tigerpig-dev/issue/TMT-22)                                                                                                                                                                         |
| JSON wait/counter updates still have concurrency gaps; terminal completion/extraction cannot guarantee a complete correlated body.                       | [TMT-25](https://linear.app/tigerpig-dev/issue/TMT-25), [TMT-35](https://linear.app/tigerpig-dev/issue/TMT-35), [TMT-36](https://linear.app/tigerpig-dev/issue/TMT-36), [TMT-37](https://linear.app/tigerpig-dev/issue/TMT-37) |
| JSON/process error boundaries are inconsistent; preamble/config still consume workspace registries after command retirement.                             | [TMT-26](https://linear.app/tigerpig-dev/issue/TMT-26), [TMT-27](https://linear.app/tigerpig-dev/issue/TMT-27)                                                                                                                 |
| Optional identity-service fallbacks, broad contracts and concrete repository coupling remain. The parser also imports a command-owned role request type. | [TMT-28](https://linear.app/tigerpig-dev/issue/TMT-28)                                                                                                                                                                         |
| Shipped skill/help inventories drift; packed verification does not yet prove application migrations.                                                     | [TMT-29](https://linear.app/tigerpig-dev/issue/TMT-29)                                                                                                                                                                         |
| Non-tmux identity management, memory and durable inbox are future capabilities, not installed APIs.                                                      | [TMT-30](https://linear.app/tigerpig-dev/issue/TMT-30), [TMT-15](https://linear.app/tigerpig-dev/issue/TMT-15), [TMT-16](https://linear.app/tigerpig-dev/issue/TMT-16)                                                         |

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
