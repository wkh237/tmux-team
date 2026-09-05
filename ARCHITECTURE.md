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

These are invariants to protect. Known publication, caller-context and delivery
gaps below remain limitations, not guarantees supplied by this document.

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
  fixture or define an explicit compatibility adapter instead.
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

| Gap                                                                                                                                                      | Owning issue                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding insert/metadata publication/reconciliation are not yet a coordinated crash-safe protocol. SQLite uniqueness alone does not supply it.            | [TMT-20](https://linear.app/tigerpig-dev/issue/TMT-20)                                                                                                                 |
| Some current-pane commands can fall back to an ambient pane outside a caller session; role selection guards this separately.                             | [TMT-21](https://linear.app/tigerpig-dev/issue/TMT-21)                                                                                                                 |
| Numeric/flag validation and legacy metadata/backfill need hardening.                                                                                     | [TMT-22](https://linear.app/tigerpig-dev/issue/TMT-22), [TMT-23](https://linear.app/tigerpig-dev/issue/TMT-23)                                                         |
| Message adaptation/fallback and JSON wait/counter updates have safety/concurrency gaps.                                                                  | [TMT-24](https://linear.app/tigerpig-dev/issue/TMT-24), [TMT-25](https://linear.app/tigerpig-dev/issue/TMT-25)                                                         |
| JSON/process error boundaries are inconsistent; update/remove still act on legacy registries.                                                            | [TMT-26](https://linear.app/tigerpig-dev/issue/TMT-26), [TMT-27](https://linear.app/tigerpig-dev/issue/TMT-27)                                                         |
| Optional identity-service fallbacks, broad contracts and concrete repository coupling remain. The parser also imports a command-owned role request type. | [TMT-28](https://linear.app/tigerpig-dev/issue/TMT-28)                                                                                                                 |
| Shipped skill/help inventories drift; packed verification does not yet prove application migrations.                                                     | [TMT-29](https://linear.app/tigerpig-dev/issue/TMT-29)                                                                                                                 |
| Non-tmux identity management, memory and durable inbox are future capabilities, not installed APIs.                                                      | [TMT-30](https://linear.app/tigerpig-dev/issue/TMT-30), [TMT-15](https://linear.app/tigerpig-dev/issue/TMT-15), [TMT-16](https://linear.app/tigerpig-dev/issue/TMT-16) |

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
