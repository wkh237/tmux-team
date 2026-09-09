# Office foundation

Tracking: [#175](https://github.com/wkh237/tmux-team/issues/175), under
[#173](https://github.com/wkh237/tmux-team/issues/173).
The owner approved workspace-first delivery. The full protocol and trust design
in [#174](https://github.com/wkh237/tmux-team/issues/174) remains open; this
document describes the implemented workspace. The
[v1 design](design.md), [planned commands](commands.md) and
[wire contracts](../../contracts/office/README.md) now record the design baseline;
they do not make the shell a connected Office.

## Current implementation

Office is an optional React SPA under `apps/office`. Its local shell has a home
route, setup explanation, unknown-route recovery and provider-local presentation
state. It does not authenticate, contact Firebase, load local identities, install
an extension, open a listener or dispatch work. The native CLI remains unchanged.

| Owner                        | Responsibility                                              | Forbidden dependency                                                    |
| ---------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/office`                | Browser routes, accessible views, UI state, app tests       | Local SQLite, filesystem/process APIs, Rust source or test helpers      |
| `services/office` (reserved) | Future Firebase rules, indexes and emulator tests           | Unrestricted local execution or implicit agent authority                |
| `contracts/office`           | Versioned design schema and structural conformance fixtures | Browser rendering, Firebase effects or duplicate domain policy          |
| `rust/`                      | Existing local CLI, domain and concrete adapters            | Office assets, Node or a Firebase account required by ordinary commands |
| `docs/office`                | Decisions, scenarios and operational guidance               | Describing planned behavior as shipped                                  |

There is no connector crate, deployable service or shared runtime package yet.
Create each only with its first concrete consumer and reviewed contract.
Do not relocate established Rust, test, script or canonical skill paths simply
to make the tree symmetric.

## Frontend decisions

- React + Vite SPA with TanStack Router; no Next.js, SSR or TanStack Start.
- Jotai owns ephemeral UI state. Each mounted app owns its store. No identity,
  authentication or durable task state is inferred from a UI atom.
- TanStack Query is the chosen future owner for non-streaming remote requests
  when needed. It is not installed without a consumer. Firestore streams need a
  single subscription/cache owner; do not mirror authoritative snapshots in both
  Query and Jotai or create a second request lifecycle.
- Use the VoidZero component tools: Vite (Rolldown), Vitest, Oxlint and Oxfmt.
  This does not require adopting Vite+'s runtime/package-manager management.
  Office uses its own current Vitest configuration; the established native and
  tooling suites keep their existing runner contract pending a scoped migration.
  One pnpm lockfile records both. Root tooling/docs retain Prettier, Office uses
  Oxfmt, and no file has competing formatter owners.
- Drawing dependencies are allowed. Compare a library's actual map/drag/board
  functionality, accessibility, bundle cost, maintenance and license before
  choosing it in #179/#180. The scaffold needs no canvas engine, sprites or
  speculative universal scene abstraction.

## Trust boundaries for later design

The browser is an untrusted client of server-enforced membership rules. A local
connector must be explicitly installed, paired and running before it can expose
selected local agents. Visiting, chatting, board editing, requesting work and
executing locally are separate permissions. An optional receptionist can route
work but cannot replace authentication or authorization.

Browser presence, connector connectivity, individual agent availability and
durable work state are distinct observations. Proximity or user-supplied content
never grants tool access. Shared requests correlate with existing local exchanges;
they do not mirror the SQLite database or become an alternate task engine.

Before implementing these features, review the #174 design for version
negotiation, ownership/correlation, deduplication, expiry/revocation and failure
scenarios. Refine each downstream issue before adding its runtime consumer.
Firestore deployment means an owner's Firebase project, not self-hosted Firestore
or automatic federation. No cloud provisioning, billing or deployment occurs here.

## Foundation behavior

| Input                                 | Observable result                                             |
| ------------------------------------- | ------------------------------------------------------------- |
| Open `/`                              | Local preview and no world/agents connected; no cloud request |
| Follow Setup or open `/setup`         | Planned setup and permission boundaries, no fake login        |
| Open an unknown path                  | Not-found view with a working return link                     |
| Expand preview details, then navigate | Disclosure stays open in this mounted app                     |
| Unmount and start another app         | Disclosure resets; no global/persisted UI state               |

The DOM tests use the real router and user interactions. They do not prove
browser layout, hosting rewrites, Firebase rules, connector lifecycle or remote
collaboration. Those need their own downstream evidence.
