# Office architecture

Current browser and data ownership is defined here. [Design](design.md),
[planned commands](commands.md) and [contracts](../../contracts/office/README.md)
separate proposed capabilities from implemented behavior.

## Current implementation

Office is an optional React SPA under `apps/office`. Its local shell has a home
route, setup explanation, unknown-route recovery and provider-local presentation
state. Default preview does not initialize Firebase. Explicit `emulator` mode
on loopback enables local Google-provider popup sign-in, UID display and logout
through the Auth Emulator, not real Google. Explicit `cloud` mode requires
owner-local Firebase web configuration and uses the same Google/session adapter.
It does not load local identities,
install an extension, open a connector listener or dispatch work. The native CLI
remains independent. Login alone does not grant world access. A
Console-managed tester gate controls direct client create/read of owner-only worlds;
Firestore Rules enforce both gates, immutable fields and default-deny paths.
This is not an invitation, presence or connected-agent implementation.

Each admitted world has a single owner-only `home` block.
`src/blocks/block-contract.ts` owns client values, catalog and footprint policy;
`firebase-blocks.ts` implements its port using the existing initialized SDK.
`block-state.ts` owns the server-confirmed projection and separate unsaved draft.
Watch observations and save confirmations share one nondecreasing revision
projection. A failed watch is terminal until the block is reopened; late
callbacks cannot restore its content. Repeated unchanged admission leaves the
active world subscription and editor draft intact.
It starts in the mounted `BlockPanel` effect, is keyed by world, and disposes on
route/admission loss. Late observations and saves cannot restore disposed data.
`block-scene.tsx` renders controlled vector primitives; `block-view.tsx` owns
selection and controls. No canvas engine, generic scene framework, new global
store or remote-state copy is introduced. Pointer selection/tile placement and
equivalent numeric/keyboard controls edit locally; explicit Save uses the
revision-checked Firestore transaction. Agent assignment and commands are not implemented. The contract and shared validation vectors live in `contracts/office`.
Save confirmation and conflict inspection use one-shot transaction reads in the
same adapter, independent of watch-channel recovery. Watch snapshots remain
the ongoing projection, not an acknowledgment channel for explicit saves.
The pure contract's sole codec converts readable furniture maps to four-character
storage tokens, allowing Rules to validate all 16 objects and exact rotated
bounds within their expression budget.

`src/auth/firebase-session.ts` is the only Firebase initialization/composition owner.
`firebase-config.ts` validates explicit activation before SDK initialization.
`src/worlds/firebase-worlds.ts` owns direct SDK operations; `world-state.ts`
depends on the Firebase-free `world-contract.ts` port and value types, not the
concrete adapter. The contract owns shared client validation and the adapter
implements it; the block adapter and world form reuse its world-ID contract.
Rules retain independent validation as the authority boundary, not a generated
client-only guard. There is no second domain model or request layer. `world-state.ts`
owns one admission listener and at most one selected-world listener. Session and
admission generations fence late creates; route generations also fence world
listener callbacks. Creation success navigation is local to the mounted create
form and rendered through the router; unmounted forms cannot redirect a later
view. Leaving does not cancel the write or discard its session-owned retry draft.
React subscribes
directly, with no parallel Jotai/Query copy. Firestore cache-only snapshots never
grant access or display world data; only server-confirmed observations do.
The document contract is in `contracts/office/private-world.md`; Rules are the
untrusted-write enforcement boundary. The client name check is feedback only.
The entry point creates one uniquely named app outside React rendering and
disposes it on hot replacement. `session.ts` owns one observer, bounded public
identity projection, action serialization, sanitized errors and teardown.
`session-view.tsx` subscribes directly with React's external-store interface;
Jotai and Query do not mirror identity. Only the observer changes identity;
failed actions retain the observed state, and late completions cannot revive
a disposed session. Auth uses explicit in-memory persistence from initialization:
reload signs out and other tabs/contexts do not inherit the identity. No tokens
are exposed in view snapshots. This memory policy is not a substitute for Rules
authorization. Removing tester admission clears private UI and denies subsequent
server operations; previously disclosed content cannot be recalled. No production
Firebase setup is implied.

| Owner              | Responsibility                                                   | Forbidden dependency                                                    |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/office`      | Browser routes, accessible views, UI state, app tests            | Local SQLite, filesystem/process APIs, Rust source or test helpers      |
| `services/office`  | Demo-project emulator bootstrap and private-world security rules | Unrestricted local execution or implicit agent authority                |
| `contracts/office` | Versioned design schema and structural conformance fixtures      | Browser rendering, Firebase effects or duplicate domain policy          |
| `rust/`            | Existing local CLI, domain and concrete adapters                 | Office assets, Node or a Firebase account required by ordinary commands |
| `docs/office`      | Definitions, scenarios and operational guidance                  | Describing planned behavior as shipped                                  |

There is no connector crate, deployable service or shared runtime package yet.
Create each only with its first concrete consumer and reviewed contract.
Do not relocate established Rust, test, script or canonical skill paths simply
to make the tree symmetric.

## Frontend stack

- React + Vite SPA with TanStack Router; no Next.js, SSR or TanStack Start.
- Jotai owns shared cross-view presentation state; component-local forms and
  selection use React state. Each mounted app owns its store. No identity,
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
  adding one. The scaffold needs no canvas engine, sprites or
  speculative universal scene abstraction.

## Trust boundaries for later design

[Sandbox design](sandbox.md) owns the planned data-only prop and exploration
boundary. It does not introduce a runtime/plugin SDK into the current app or
extend the fixed-asset block codec. Keep future native inputs and rendering
conformant to a versioned contract, not a second layout model.

The browser is an untrusted client of server-enforced membership rules. A local
connector must be explicitly installed, paired and running before it can receive
remote work for selected local agents. One-shot block operations are a separate
scoped authorization path, not a requirement to run a background process.
Visiting, chatting, board editing, requesting work and
executing locally are separate permissions. An optional receptionist can route
work but cannot replace authentication or authorization.

Browser presence, connector connectivity, individual agent availability and
durable work state are distinct observations. Proximity or user-supplied content
never grants tool access. Shared requests correlate with existing local exchanges;
they do not mirror the SQLite database or become an alternate task engine.

The planned protocol defines version negotiation, ownership/correlation,
deduplication, expiry/revocation and failure semantics separately from the SPA.
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

DOM tests use the real router, with focused session lifecycle tests beside the
owner. Playwright under `apps/office/e2e` proves real Chromium/SDK/Auth Emulator
popup flow, cancellation, transport failure, memory isolation and default-preview
network inactivity. Its opt-in Docker target extends the existing emulator image;
it does not duplicate emulator pins or use the native tmux harness. Upstream
emulator CDN presentation assets are blocked, not replaced with fake auth
responses. Google's public popup/iframe library is still required: browser
tests allow its script GETs on `apis.google.com`, keep all auth requests local,
and reject other destinations. This is not a fully offline flow. Direct-SDK
Rules scenarios additionally prove tester/owner isolation and immutable creation;
the browser world scenario proves grant/create/read/revocation through the UI.
They do not prove connector lifecycle, real Google login or remote collaboration.

On tester revocation, subsequent server reads/writes are denied and the app's
admission stream clears the view and detaches its world listener. Do not claim instantaneous
server stream closure or recall of prior data. Real cloud revocation timing must
be verified during the explicitly authorized pilot.
