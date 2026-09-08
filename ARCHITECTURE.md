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
durable reply instructions and transport protection. A verified bound direct
pane uses the same identity preamble as a name; unnamed panes use none. Storage
lookup failure stops preparation rather than silently omitting the prefix.
The `[SYSTEM: ...]` prefix is ordinary delivered text, not an authenticated
provider system-message channel.

Existing preambleMode/preambleEvery settings remain. Eligible attempts reserve identity-ID-keyed
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

## Durable request/response boundary

`talk` waits for an immutable final response through the existing request service
by default. `--detach` sends the same receipt instruction but returns without
observing completion. `reply` submits a complete body; `result` retrieves it.
No terminal marker, capture, debounce, provider cleanup, idle state, summary or
process exit determines completion. `check` remains a diagnostic pane snapshot.
Cooperation is required: a recipient that never calls reply has no durable final.

The [request/response decision document](REQUEST-RESPONSE.md) retains the historical
research and current contracts. TMT-36 supplies the service, TMT-38 the bounded
adapters, and TMT-39 the live cutover under TMT-37. Installed agent instructions
require complete submission before a short truthful user summary. Delivery of a
reply is not success of the requested task. Inbox, daemon, MCP/remote connectivity
and memory remain outside this implementation.

The same document contains the canonical **TMT Exchange contract**.
Exchange (X) extends this request service and SQLite boundary with bounded
original context and originator/recipient provenance, attention revisions and
identity-scoped explicit acknowledgement. It does not authorize a duplicate
service or database, a new X-specific ID format, guessed identity backfill, or
changes to the shipped `talk`/`reply`/`result` verbs. Reads do not acknowledge;
service-owned reads may perform logical expiry and bounded opportunistic cleanup;
`check` remains diagnostic and reconciles only its selected identity binding.
Timeout remains observer-only; offline queues, leases, memory, and MCP state are
separate future work. SQLite supplies no autonomous TTL scheduler, so this does
not promise punctual physical deletion or database-file shrinkage. Keep this
current map and the linked section in sync as each bounded future slice is
implemented. TMT-54 supplies the retention foundation through the existing
global config's `exchange.retentionDays`, default 90 days. Each new request
freezes its policy; the migration preserves seven-day retention for existing
requests and bodies. TMT-55 supplies original prompts and provenance; TMT-51 adds attention.
The default 180-second talk observer timeout
and the reply submission window are distinct from data retention.

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
identity cadence totals. Migration 5 adds independent final-response records and
a bounded completion marker on attempts. Migration 7 adds bounded original
messages and originator/recipient provenance to these same attempt rows.

Each invocation receives an immutable request/attempt identity and records full
server ID, socket, server PID/start time, pane ID and pane PID. An endpoint is
not a display name or `%pane_id` alone. Multiple waits on the same endpoint
retain independent rows; the overlap warning is advisory and `--force` only
suppresses that warning. This is bookkeeping isolation, not transport
serialization or exactly-once agent processing. Finals are matched by request,
attempt and full endpoint rather than by shared terminal output.

Preparation and marking `sending` commit in separate short transactions before
the external effect; no request transaction spans tmux, capture or polling.
Successful transport becomes `sent`. Stageful and generic unknown send failures
are conservatively `uncertain`. Only evidence of no input, including an expired
still-prepared attempt, permits a refund. An expired prepared attempt cannot
later start sending; an expired sending attempt becomes uncertain. Conditional
settlement/refund is idempotent and cannot mutate another request.

Wait release does not cancel recipient work or alter delivery outcome. Expiry is
at least one hour and extends for configured send/wait budgets. Opportunistic
cleanup prunes metadata only after its stored horizon, protecting the settlement
floor, response acceptance deadline and retained final, while keeping cadence
totals. A failure before reservation
or begin-send stops input; a post-send persistence failure cannot safely imply
non-delivery. Commands report `REQUEST_STATE_ERROR` with inspection guidance
when appropriate. There is no automatic retry, daemon or inbox in this slice.

### Immutable final replies

`submitResponse` takes explicit request and attempt IDs, the recorded full endpoint,
and one exact valid Unicode body, bounded to 1,048,576 UTF-8 bytes. It accepts only
`sending`, `sent` and `uncertain`; it does not change transport status or infer a
live pane. `getResponse` returns the original body and association, not a capture.
Empty bodies, whitespace, BOM, NUL, CR/LF and marker-like text are preserved.
Role/preamble normalization is not applied. Request and response wrappers share
exact-text Unicode validation and UTF-8 measurement, retaining separate errors.
The reply adapter passes inline text or decodes bounded file/stdin input before
invoking this service. All three sources share the service's exact-body
validation; the CLI parser only enforces source selection.

The same immediate transaction validates the fence and inserts the final plus its
attempt's `responseSubmittedAtMs` marker. Retained identical retries return the
original record and timestamp, including after restart or attempt cleanup.
Conflicting bodies and wrong fences cannot mutate a final. A response-first
definitely-failed settlement becomes uncertain without refund; already terminal
delivery outcomes cannot be rewritten by contradictory settlement. Completion
means a submitted result, not successful task execution or authenticated delivery.

Submission remains eligible until the later of attempt expiry and seven days from
preparation. Wait release does not close this window. Final bodies expire after
the duration frozen on their request, anchored at submission: reads hide them
at that boundary; opportunistic cleanup
physically removes them. Independent endpoint snapshots and no cascading foreign
keys preserve finals across identity rebinding and support already-orphaned
historical finals; current cleanup retains matching metadata through final expiry. The bounded attempt
completion marker prevents recreation and false refunds after body deletion when
a long attempt deadline is still open. Preparation rejects IDs still owned by a
retained final. After all retained metadata is gone, unknown and previously expired
requests are indistinguishable; there is no permanent tombstone store.

### Frozen retention and bounded housekeeping

TMT-54 appends persisted retention to the existing request/response schema.
`domain/exchange-retention.ts` owns numeric validity and deadline calculations;
the request service owns lifecycle policy and the request adapter owns indexed
candidate selection and mutation. Configuration consumes that same policy.
Context supplies a lazy policy callback used only by new preparation, before
the reservation transaction. Reply, result and cleanup use stored deadlines
without opening current configuration or tmux.

`exchange.retentionDays` is global-only, an integer from 1 through 3650 with a
90-day default. Policy changes affect new requests only. The forward migration
stamps existing requests/bodies with seven days and preserves original time
anchors; it does not rebase on migration time, resurrect missing data or retain
a second legacy service implementation. New arithmetic is checked; historical
deadline calculations remain within the supported integer range.

The original request horizon starts at preparation; final-body retention starts
at first accepted submission. Metadata protects both, the unchanged reply
acceptance window and the existing 24-hour settlement floor. An accepted late
final may extend metadata through its own expiry; reads, duplicate replies,
housekeeping and waiter release do not renew it. Synthetic cleanup settlement
can delay physical deletion for 24 hours without restoring logically expired
metadata. A short configured horizon may
leave metadata eligible for a late reply after request content would expire.
This is a per-content duration, not a hard limit from first creation.

Logical reads hide expired records at deadline equality even before physical
cleanup. Housekeeping uses one short immediate transaction, bounded to 100
expired-attempt transitions, 100 prompt scrubs, 100 final-body deletions and 100 metadata deletions,
ordered by expiry and stable ID. It runs through existing request operations;
repeated calls drain backlog without a daemon or a physical-deletion SLA.
Metadata selection pins its horizon index so a fresh database without planner
statistics cannot sort all terminal candidates before applying the batch limit.
The limit bounds mutations, not a universal maximum on examined index entries.
Failure rolls back the batch and propagates through existing command errors.
No transaction spans tmux, polling or external work. Conditional state changes
preserve exactly-once cadence refunds and completion fences.

Deadlines use UTC wall time, not a sliding timer. Clock rollback does not change
stored deadlines but can delay logical expiry while data is still physically
present. Deletion is not file shrinkage or secure erasure; no per-call VACUUM
or automatic clock-repair mechanism is provided. Identity/profile/cadence data
are outside Exchange content cleanup. Attention consumes
this owner rather than copying its policy.

### Original request context and provenance

Preparation requires the original message, before preamble composition, receipt
instructions or ASCII `!` transport protection. Exact well-formed Unicode up to
1,048,576 UTF-8 bytes is retained, including empty text, BOM, CR/LF and NUL.
Request-specific validation wraps the same exact-text primitive used by replies,
not role/preamble normalization. CLI validation runs after timing/config validation
and before target effects; invalid and oversized input retain their specific
`REQUEST_INPUT_INVALID`/`REQUEST_INPUT_TOO_LARGE` errors rather than becoming
generic request-state failures. Argument size/NUL limits remain OS constraints.

Talk's command-local `--identity` uses the shared durable selector through
IdentityService. An existing explicit name, including an offline identity,
takes precedence over a verified caller; omission records a verified caller or
unknown originator. Unlike role access, absent caller identity is allowed.
Unknown explicit names and ambiguous/reconciliation failures stop before
preparation or send. Selection is local attribution, not authentication.
Recipient resolution precedes originator lookup and remains independent.

The internal target projection carries durable identity and binding evidence,
without extending public ActiveRegistration. Before preparation, the existing
binding evaluator checks this evidence against a fresh recipient-scoped endpoint snapshot.
Changed server/socket/process or identity/binding markers fail closed. This is
a verified observation of the intended recipient, not a guarantee against a
later rebind before processing. Recipient UUID persists independently of cadence,
including disabled or absent preambles; unnamed panes have unknown recipient.
Public talk/list/check projections never expose this internal evidence.

Migration 7 leaves historical prompt columns NULL and provenance unknown; cadence
identity_id is not an originator or historical recipient backfill source. New
attempts atomically retain original text, byte count, its preparation-anchored
expiry and explicit/verified/unknown originator plus optional recipient UUID.
No current name lookup rewrites persisted UUIDs after rebinding.

General attempt records and metadata/list queries exclude prompt text and bytes.
The existing service's focused getRequestContext(requestId) read returns a retained
attempt and a retained/expired/unavailable prompt projection. Empty retained text
is distinct from unavailable historical context. Logically expired metadata or
unknown requests return no record. Reads share readWithCleanup's clock and
transaction, without current config or tmux. Identity-scoped x show reuses this
prompt projection, not a second service or public inbox.

Prompt expiry is preparedAtMs plus the frozen duration, never the potentially
extended metadata horizon. Late replies, reads, settlement and retries cannot
renew it. The indexed ordered scrub phase clears at most 100 expired text/byte
payloads in the existing cleanup transaction, retaining the expiry marker.
Logical equality is expired even when physical cleanup has not reached the row.
Local storage is always on for new requests in this slice: avoid secrets; no
upload, redaction, encryption or secure-erasure guarantee is supplied.

Typed response errors distinguish invalid/oversized input, unknown request, wrong
attempt/recipient, ineligible state, expiry and conflict. Rejections preserve
attempts, cadence and replies. No cancellation, listener, remote authorization,
provider-specific state machine or alternate database is introduced.

### Explicit reply and result adapters

`reply <request-id> --receipt <receipt> (--message <text> | --file <path> | --stdin)` submits one
complete final. `result <request-id>` reads a retained final without waiting.
Both select storage-only Context capabilities: no live caller, pane reconciliation
or tmux construction is required. Neither infers a request from a pane or name.
`talk` generates the exact receipt after preparation and sends it inside the
single recipient instruction frame, for both default waiting and detach. The
frame uses `<tmt-reply>` tags to group a single reply-command template, with
the receipt included once. It does not promise hidden provider rendering or
bound terminal output/result extraction. HTML comments are not used: their
ASCII exclamation mark conflicts with the shared shell-mode protection.
Only short submission/summary/error guidance travels with each request;
input limits and retry/retention details remain in installed skills and help.
An instruction/encoding failure before beginSend settles definitely_failed and
releases its waiter, refunding cadence through the existing service.

The receipt is a versioned, bounded, canonical base64url JSON envelope containing
the explicit request, attempt and complete recorded endpoint. It is correlation,
not authentication against another process running as the same OS user. The
adapter validates its shape and positional request match; the shared service
validates the recorded fence and transition in its existing transaction. Routine
acknowledgements, result output and errors do not include the receipt or endpoint.

The input-adapter layer shares strict UTF-8 decoding in `src/strict-utf8.ts`.
File, stdin and receipt adapters use the same fatal decoder with BOM preservation;
they retain their own size/deadline limits and public error translations. Receipt
JSON/canonical-envelope checks and role/preamble normalization remain separate
policies. The decoder neither acquires resources nor normalizes decoded text.

File input follows symlinks to regular files, using nonblocking open, descriptor
type validation and a cap-plus-one bounded read with guaranteed closure. It is
explicit user-selected input, not a filesystem confinement boundary. Reply and
role input share bounded file decoding, not feature limits or normalization.
Stdin requires explicit `--stdin`, rejects a TTY, and completes only on EOF within
five seconds and the 1 MiB body cap. Failure removes input listeners/timers and
does not submit a partial body. Fatal UTF-8 decoding preserves BOM and exact text.
Inline input may be explicitly empty and is never normalized. Shell quoting
and operating-system argv limits apply; NUL and large bodies require file/stdin.
No storage transaction spans input acquisition.

Submission returns `status: submitted`, request ID, byte count and the original
submission timestamp, including on an identical retry. Result JSON returns
`status: completed` with exact `response`, byte count and timestamp. Human output
is formatted; exact-text consumers use JSON. Missing retained bodies return
`RESPONSE_NOT_AVAILABLE`/`status: unavailable` (exit 3), covering pending, unknown
and expired results without inventing distinctions the service cannot establish.
Submission conflicts use exit 5; stdin deadline uses exit 4. Neither timeout nor
unavailable output cancels recipient work or changes service retention.

## Talk observer and retired settings

`src/domain/interaction-limits.ts` owns pure capture and timing validity rules.
The parser owns decimal/duration syntax and maps failures to usage errors;
talk retains its timing error translation and conditional wait validation.
Check validates its effective capture count before target lookup: integers
0 through 2,147,483,647 are accepted, with zero preserving visible-pane capture.
Invalid runtime counts return `INVALID_CAPTURE_LINES` (exit 1), without capture
or reconciliation. These argument limits do not replace tmux's existing
one-second timeout and 4 MiB output bound. Loaded-setting failures are rejected
earlier by the shared configuration boundary described below; direct runtime
command inputs retain their feature-specific validation and errors.

The parser rejects retired `--wait`, talk `--lines`, and explicit
`--timeout`/`--detach` combinations before Context effects. `send` follows the
same talk semantics. Runtime timing validation precedes preamble/request mutation:
timeout is finite, positive and at most 24 hours; poll interval is finite and
positive. Default timeout remains 180 seconds unless configured. Pre-send delay
and configured paste-enter delay must be finite, non-negative and no greater
than 2,147,483,647 milliseconds, avoiding timer overflow that could send early.

The monotonic deadline starts immediately before beginSend/transport, after
pre-send delay, preparation and receipt construction. It is checked before and
after each synchronous getResponse read; equality or a read crossing the bound
returns timeout, with no final read afterward. Sleeps are clamped to remaining
time. Transport/Enter elapsed time counts, but synchronous transport cannot be
cancelled mid-operation by this logical observer deadline. A retained late
response remains available through result. No transaction spans polling.

Wait/polling mode and extraction-only maxCaptureLines are absent from runtime
types, defaults and resolved output. Raw stored values remain opaque and are
not automatically rewritten. Explicit local `config clear mode` may remove
that key; config set mode and global clear remain unsupported. captureLines
still controls check diagnostics. Historical migrations/nonce columns stay
unchanged; new talk attempts do not create a nonce.

## Configuration policy and raw-file preservation

`src/config.ts` owns path resolution and raw-file loading/writing;
`src/config-settings.ts` owns fresh canonical defaults, known-setting validation
and runtime projection. This focused policy reuses the pure
capture/timing predicates in `domain/interaction-limits.ts`; commands do not
copy default objects or use permissive `parseInt` conversion. CLI setter syntax
is decimal integer text for its supported numeric keys, while loaded JSON
paste delay retains the runtime's finite fractional-millisecond support.

Global/local roots and supplied `defaults`/`$config` containers must be non-null
objects, not arrays. Every supplied known value is validated before merging,
including lower-tier values that would be overridden. Missing values use fresh
defaults; nulls, strings and invalid enums are not coerced. Unknown and retired
fields remain raw data and do not enter resolved runtime settings. Existing
global/local precedence and path selection remain unchanged.

Raw edit reads validate container shapes without first rejecting the value
being repaired. Save validates the complete resulting destination before
directory creation or writing; unrelated invalid known values still reject.
Rejected updates preserve file bytes, while successful writes preserve unknown
fields. This does not supply crash-atomic or concurrent JSON-file updates.
Loaded shape/value errors join JSON errors at `CONFIG_ERROR` (exit 1), with
file/field context; invalid setter arguments retain their existing command error.

Context keeps settings lazy for storage-only capabilities. `reply`, `result`
and explicit role access do not acquire a dependency on unrelated malformed
configuration. Config-consuming talk/check fail before tmux or request storage;
help retains its safe default fallback. Exchange retention configuration uses
this same owner, not another loader.

### Opt-in pane presentation

Global-only `ui.paneBadge` defaults to `off` and uses the existing configuration
validation, raw-file preservation, projection, and CLI owner. Binding commands
resolve it before identity mutation. Successful `name`/`this`/`add` then publish
or clear the pane-local `@tmux-team.badge` through `Tmux.setPaneBadge`; `unbind`
clears it without loading unrelated configuration. Failed identity mutations
leave presentation untouched. Configuration writes themselves remain
storage-only: no scan or retroactive refresh of existing panes.

The adapter owns bounded label rendering and one bounded best-effort tmux
option write. It neutralizes format-introducing hashes and controls and limits
the name to 48 Unicode code points; durable names are unchanged. Cosmetic
failure cannot undo a committed binding. This port must never change pane
titles or window-scoped border format, position, or style. Users own theme
integration and any restoration of an older overwritten layout. There is no
automatic theme installer, secondary identity registry, or redraw subprocess.

## Caller context

The tmux adapter owns current-pane evidence. Complete `TMUX_PANE` and `TMUX`
environment evidence must agree with a bounded query of that explicit pane.
When environment evidence is missing, a bounded read-only process-ancestry
lookup may identify a unique pane process on the selected tmux server. An
ambient active pane or session name is never caller evidence. Supplied malformed,
stale or conflicting evidence must not be rescued by fallback. Missing process
visibility, inaccessible sockets or ambiguous matches yield no caller. This
lookup deduplicates matching session/pane rows before counting candidates;
conflicting process/socket/server evidence for a repeated pane is still rejected. This
supports environment-stripped descendants, not arbitrary sandbox isolation;
nondefault servers still need a usable server-selection mechanism.
The fallback uses the system `ps` utility with a shared one-second deadline
and a bounded ancestry depth/output size. A system without `ps` cannot use this
fallback; the normal complete-environment path does not acquire that dependency.
Environment/process evidence selects local context, not an authenticated
principal, and is not a defense against deliberate environment spoofing.

`name`, `this`, `whoami` and `unbind` reject missing caller context with
`PANE_NOT_FOUND` (exit 3) before opening identity storage. Implicit role access
uses the same caller policy and returns `IDENTITY_REQUIRED` (exit 1) without
bootstrapping storage or reconciling unrelated bindings. Context keeps repository
access lazy until a selected operation needs it. A valid unbound pane is still
distinct from an absent caller.

Explicit `add`, `talk` and `check` target resolution remains available outside
tmux; explicit `role --identity` access remains storage-only. These selectors
choose a target or data owner. Talk's explicit originator selects local attribution
without binding the caller. No listener, non-tmux
identity binding, memory or inbox is implied by this boundary.

## Standalone durable identity operations

TMT-30 exposes explicit `identity create <name>`, `identity show <name>` and
`identity list` through the existing IdentityService and SQLite repository.
They use storage-only parser capabilities and never probe tmux, reconcile
bindings, load unrelated configuration or infer an omitted name. Ordinary
`list` keeps its verified active-presence contract.

Standalone creation and binding reuse the same validated canonical creation
primitive. An immediate transaction makes the standalone `created` result
truthful under concurrent canonical collisions; repeated creation preserves
the original UUID, display name, timestamps, profiles and binding. Binding
retains its separate durable-identity and endpoint-publication commit points.
Show validates names and uses the shared durable selector; ordered listing
uses the existing repository query. No schema or dependency is added.

The pure public identity projection in `domain/identity.ts` is shared with role
results and exposes only UUID/name/canonical name, not timestamps or endpoint
evidence. It is distinct from active-pane presentation. Creation/discovery is
not login, exclusive caller ownership, authentication, an endpoint or a listener.
Anonymous talk and request-ID results remain available; identity-scoped attention
requires explicit or verified originator provenance.

### Exchange attention ownership

The typed `exchange` request dispatches `x` list/show/ack/ackall through a thin
command into the existing RequestService and composed RequestRepository.
`request-attention.ts` owns attention types and projections, not another service
or connection. Identity resolution uses the shared selector/error boundary before
request-service acquisition. Explicit selectors never execute tmux; all X actions
use storage-only Context capability and avoid unrelated configuration.

Migration 8 adds per-request revision/ack metadata and one per-originator counter
and acknowledged-through watermark. Known preparation and first final submission
advance revisions atomically with their existing writes. Delivery transitions,
reads, expiry, retries and waiter release do not. Counters survive content cleanup;
overflow fails closed. Historical unknown provenance is never inferred.

List performs ordered, indexed, metadata-only keyset reads, fetching at most
limit+1 rows (default 50, maximum 200). The live cursor may revisit a request whose
final receives a new revision. Show shares retained prompt/final projection and
logical expiry. Neither read acknowledges or renews retention.

Single ack checks the exact observed revision inside the immediate transaction.
Ackall takes its own current transaction snapshot and advances one identity
watermark, without enumerating requests, counting them, or requiring client
tokens/batches. Later commits receive higher revisions and remain unacknowledged.
Effective acknowledgment is the maximum of individual and identity-wide values.
Settled means final marker plus acknowledged revision, not successful work or
retained body. No second inbox, recipient queue, event log or memory layer is added.

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

Discovery and reconciliation use one local binding-evidence evaluator in
`identity-service.ts`, composing identity/pane presence, server and process
evidence, and durable metadata agreement. Scoped and full reconciliation share
the foreign-socket preservation guard and binding mutation helper; discovery
still excludes bindings that do not match the current server. The shared predicate does not
change publication, transaction, or routing policy.

Single-target operations select only relevant evidence. Caller lookup and unbind
read the caller pane and its indexed database binding; named lookup reads the
canonical identity and its unique binding. Binding checks the target and any
existing location for the selected name, including bounded foreign-server
probing when needed. Post-publication verification and talk's fresh recipient
check request only that pane. No scoped observation prunes or touches unrelated
bindings. Bare `list` and explicit internal reconciliation remain full discovery
operations and can remove stale current-server bindings. Durable identities are
never removed by either kind of reconciliation.

The existing target resolver passes pane/canonical-name selection into the
identity-aware view, preserving pane-first interpretation without materializing
all identities. Verified target projections retain pane details from the same
observation, so `list` does not perform a second discovery to render them.
Identity and binding lookups use existing SQLite unique keys; no schema change,
alternate resolver, cached presence or new connection is introduced.

The tmux adapter reads pane metadata in the same `list-panes -F` batch as
endpoint evidence. This format and pane filters are verified on the pinned
tmux 3.3a; absent metadata does not justify another subprocess per pane.
Scoped snapshots use tmux's `-f` filter, with a server-only observation when
the selected pane is absent. Empty scopes never expand to all panes, and
malformed scopes or incomplete endpoint evidence fail closed. This bounds
subprocess fan-out and returned pane evidence, not tmux's internal traversal
time. Metadata publication still explicitly reads the selected pane's options
to preserve unrelated fields before writing; those failures remain fatal.

`list-panes -a` enumerates session/pane rows, not unique panes: grouped sessions
and linked windows legitimately repeat stable pane IDs with different targets.
The adapter validates every row before deduplication, including rows that would
otherwise be discarded. Repeated IDs must agree on pane PID and raw metadata;
conflicting evidence fails closed. Display target, cwd and foreground command
are not endpoint identity; the presentation projection prefers a row whose
`session_attached` value is positive, while retaining first-seen order for ties
and when all rows are detached. This preference is presentation-only and does
not alter pane identity, routing, binding validation or caller evidence. Current
snapshots and foreign probes share this validation.

Binding publication, active reconciliation and unbind share the repository's
SQLite immediate-transaction boundary. Authoritative endpoint snapshots are
taken after acquiring the write lock, so a reconciler cannot prune a new
binding using evidence captured before publication. Bind verifies the written
metadata against fresh server/pane evidence before committing its success.

Metadata adapter failures distinguish reads from writes through the narrow
`pane-metadata-error.ts` contract. Public errors expose only the stage and
bounded exit/permission classification, never raw stderr, command arguments or
metadata payloads. Post-publication verification failures identify mismatched
pane/server or database binding evidence instead of claiming that the write
failed. These diagnostics do not change transaction rollback or durable-identity
retention. The CLI does not infer an outside-tmux warning solely from `$TMUX`;
operation-specific resolution supplies the actual result.

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
supplies that view through the required identity service. Config, preamble, role,
talk, reply and result request types have one owner in `src/cli/requests.ts`; both the
parser and command handlers consume those declarations. Handlers do not redeclare
or re-export a parallel request contract. Feature validation and public error
mapping remain in their existing owners. A focused AST check derives owned type
names from that canonical module and rejects same-named declarations elsewhere;
it does not prove equivalence of renamed or anonymous structural types. Focused AST import checks
cover direct literal imports/re-exports in maintained production sources; they
are not a complete semantic dependency or dynamically computed-import analysis.

## CLI output and lifecycle

The Commander registrations in `src/cli/parser.ts` own command arguments,
aliases and option acceptance. Help and shell completion project that grammar
instead of maintaining independent command/option inventories. Recognition of
historically common options at the root preserves meaningful pre-command
placement; the selected command still rejects unrelated options before Context
creation. Command-local options remain local. Hidden retired or unsupported
options are rejection contracts, not advertised capabilities.

Parser diagnostics use parsed option values and sources rather than searching
raw argv for flag-like strings. Literal payloads and option values do not enable
JSON or debug output. Root help/version requests undergo the same option
validation before text-only JSON rejection. Reply/result retain their narrow
option contracts; an ignored `--config` path override is rejected rather than
stored in the typed flags or silently changing configuration precedence.

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
Failure replacement preserves only bounded data-property requestId/target/pane
correlation from the pending document, never its response, receipt, endpoint or
arbitrary fields. This is output consistency, not rollback of command effects.

Talk timeout uses `{code: "TIMEOUT", message}`, exit 4 and request/target/pane
correlation, without partialResponse, nonce, endMarker or truncated. SIGINT
only signals and wakes the talk poll;
the awaited command flow releases its waiter and exits through the runner.
It must not throw exit control flow across an event callback. Neither timeout
nor interruption cancels recipient work or alters recorded delivery certainty.

Text-only help/version/completion/learn reject JSON mode with `JSON_UNSUPPORTED`
before effects; upgrade retains its JSON rejection. No new text-command schemas
or grammar are introduced. Runtime boot failures before application loading and
unwritable output streams are outside the one-document guarantee.

## Bundled skill viewing and installation

All providers install the single canonical `skills/tmux-team/SKILL.md` directory.
Claude links it at `~/.claude/skills/tmux-team`; Codex, Gemini and OpenCode share
`~/.agents/skills/tmux-team`. Antigravity CLI uses
`~/.gemini/config/skills/tmux-team`; Pi uses `~/.pi/agent/skills/tmux-team`,
respecting `PI_CODING_AGENT_DIR`. Pi's native target supports the verified 0.85.0
loader without assuming newer shared-directory discovery. There are no generated provider copies, command
wrappers, marketplace manifests or plugin assets. Native Claude skill invocation
is `/tmux-team`, not a separately maintained slash-command contract.
The educational learn guide points to the canonical viewer and grammar-backed
help rather than owning another command inventory.

For the installed TypeScript reference, the ordered provider list and its derived
type live in `skill-installation.ts`.
Installer acceptance, install-all expansion and completion consume that owner;
provider environment detection and Codex-specific backup rules remain installer
policies. Command and option grammar still belongs to the parser.
Detection uses provider-specific directory or executable evidence, not the mere
presence of the shared `.agents` directory. OpenCode detection respects its explicit
configuration directory override before the XDG root; its skill link remains shared. No-provider installation
uses the neutral universal config and omits `agent` from the result instead of
inventing a Codex installation. Explicit selectors do not require a provider binary.
All installation modes are non-interactive; none installs provider applications,
edits provider settings, bypasses permissions, or reloads active conversations.

`learn --skill` emits the exact bundled universal `SKILL.md`, without startup
checks, ANSI formatting, or an added newline. It is text-only and rejects JSON
before effects. Plain `learn` remains the educational guide.

`install --dir <skills-root>` resolves exactly `<skills-root>/tmux-team` against
the invocation directory. It is mutually exclusive with an explicit provider
or `all`; empty directory input is rejected before effects. Custom mode links
the universal skill and never migrates default-provider paths. Existing managed
links are no-ops; unmanaged paths are refused unless explicit force requests a
recoverable backup outside the skills root. Unrelated siblings remain outside the operation.
Before mutation, source/destination overlap is rejected, including destination
parents that alias the bundled source through symlinks. Force is not permission
to move the installed package source or create a recursive self-link.

In that reference runtime, `src/skill-installation.ts` owns shared package-root, bundled-source, managed-target,
and legacy directory candidate resolution used by install, the viewer and local
drift inspection. Candidate resolution operates without package-root discovery,
preserves installer preference order, deduplicates equivalent paths, and excludes
the active `.agents` target. The installer owns provider detection/presentation and
optional legacy backup; the update checker owns reminder policy and reports legacy
directory paths directly, detecting incomplete directories and broken links. No
custom-install registry, arbitrary folder scan, provider plugin update or agent
reload is implied. Links follow source updates at the same package path; reinstall
explicitly after relocation. Automatic drift inspection covers known defaults only,
and npm version checking is not an alpha-channel skill version tracker.
Managed-target drift inspection enumerates the provider path owner and deduplicates
shared targets, rather than separately maintaining a Claude/Codex-only path list.

The retired Claude command path is shared by installer and drift inspection.
Default Claude installation preserves and warns about the old command; explicit
force backs it up only after successful native skill installation. Broken old
links remain observable. Custom installs never migrate provider defaults.
Existing Claude plugin configuration and caches remain user-owned and untouched.
Forced skill-target replacement stores collision-safe backups in the skills
root's sibling `.tmt-skill-backups`, not among discoverable skill directories.
This policy belongs to the shared link installer for native and custom targets;
legacy command-file backups retain their existing adjacent-file behavior.

The existing packed native verifier also invokes the packed viewer and default
and custom installation in an isolated home. It verifies actual link contents,
repeat no-op, unrelated sibling preservation and source-update visibility;
unit/CLI contract tests cover conflicts, backups and invalid input. This does
not replace the storage/concurrency suites.

The packed verifier additionally checks the actual installed inventory and runs
an isolated storage probe using the installed TypeScript loader and runtime
modules. Public role commands initialize storage and prove cross-process profile
persistence; standalone identity creation/show/list use the public CLI as well. Exact
installed migration-manifest comparison is paired with repository/schema reads,
and incompatible history must fail without resetting data. This is verification
infrastructure, not another migration runner or application service. Test files
and test-support workers are excluded from the package; runtime TypeScript and
the canonical skill remains distributed. Retired command/plugin assets are rejected
by the package inventory check rather than maintained as compatibility copies.

### Rust preview installation ownership (#133)

The preview embeds the same authored skill bytes at compile time. The core
`skill_provider::Provider` inventory owns native names/order and feeds grammar,
completion and adapter selection. `skill_installation::ProviderEnvironment`
captures provider path inputs once; its target and legacy candidates are shared
by installation and passive drift inspection. TypeScript remains a temporary
reference owner until cutover, not a runtime fallback or permanent shared manifest.

The adapter materializes exact bytes at
`<global-dir>/skill-assets/<sha256>/tmux-team/SKILL.md`. Digest and exact directory
inventory establish local managed-source evidence, not remote authentication.
Sources and digest directories cannot be symlink substitutions. A modified current
bundled source blocks installation even under force. Modified older sources remain
preserved; their links are unmanaged conflicts eligible only for forced link backup.
Valid older managed links
can refresh to a new source without force; unmanaged targets require explicit
recoverable backup outside active discovery. Legacy backups use that same native
backup owner, unlike the installed reference's adjacent command-file policy.

A stable OS-locked file serializes cooperating installers without a PID registry
or database. Resolve target parents before source-overlap checks; publication
replaces the leaf entry rather than following its symlink. Stage source directories
and replacement links on their destination filesystem. Installer intents are
bounded to 4096 paths/1 MiB in versioned `skill-installations.json`, written before
links so custom targets remain discoverable after partial failure. Recorded paths
are not overwrite authority: refresh must verify actual managed links again.
Errors identify completed targets and recoverable backups. There is no atomic
transaction across providers or power-loss rollback guarantee. Old sources and
abandoned stages are preserved; never remove them merely by matching a filename.

Only interactive, non-JSON human commands inspect deduplicated known provider
and legacy paths. Help/version/completion, init, learn, install, upgrade and
machine invocations skip passive inspection. It performs no network, tmux,
SQLite, executable lookup or custom-intent scan, and never changes command success.
The CLI owns this reminder policy and presentation; the adapter owns observation.
Explicit install and future #82 update own custom-target refresh. `init` separately
reuses ConfigPaths and exclusive local file creation; it creates no other state.
Neither this boundary nor tests imply native release publication or network upgrade.

## Current module map

| Location                                                                                                                                                                   | Responsibility and integration points                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [bin/tmux-team](bin/tmux-team), [src/cli.ts](src/cli.ts), [src/cli-runner.ts](src/cli-runner.ts), [src/cli-output.ts](src/cli-output.ts)                                   | Executable entry, guarded invocation lifetime and one buffered JSON result after disposal; natural output draining.                                                     |
| [src/cli/parser.ts](src/cli/parser.ts), [src/cli/application.ts](src/cli/application.ts)                                                                                   | Repository-owned Commander adapter produces typed invocations and capability metadata; dispatcher routes them. Do not create another positional parser.                 |
| [src/context.ts](src/context.ts), [src/types.ts](src/types.ts)                                                                                                             | Composition and lazy resource lifetime; shared UI, adapter, service and configuration contracts. The shared types module is not a dumping ground for new domain models. |
| [src/commands/](src/commands/)                                                                                                                                             | CLI orchestration, error mapping and presentation. Some delivery policy still lives in commands; they are effectful adapters, not pure functions.                       |
| [src/domain/](src/domain/)                                                                                                                                                 | Pure name validation, bounded text normalization, feature-specific errors and identity models; no alternate in-memory binding model.                                    |
| [src/identity-service.ts](src/identity-service.ts)                                                                                                                         | Durable identity creation/discovery, binding, presence and reconciliation through one repository port; supplies verified identities to the target resolver.             |
| [src/role-service.ts](src/role-service.ts), [src/identity-context.ts](src/identity-context.ts)                                                                             | Role use cases with an application-owned repository port and shared durable explicit/implicit identity selection.                                                       |
| [src/target-resolver.ts](src/target-resolver.ts)                                                                                                                           | Shared name/pane resolution; pane-shaped arguments are resolved before names.                                                                                           |
| [src/storage/](src/storage/)                                                                                                                                               | SQLite lifecycle, migrations, errors and SQL implementing composed application-owned repository ports; Context owns the CLI handle.                                     |
| [src/tmux.ts](src/tmux.ts)                                                                                                                                                 | External tmux commands, snapshots, opaque metadata preservation and paste/capture. No workspace registry adapter.                                                       |
| [src/tmux-message.ts](src/tmux-message.ts), [src/message-delivery.ts](src/message-delivery.ts)                                                                             | Stageful protected input and shared submission policy; narrow delivery uncertainty contract consumed by commands without importing the tmux implementation.             |
| [src/role-content.ts](src/role-content.ts)                                                                                                                                 | Bounded role file reading/UTF-8 decoding; pure role and preamble normalization share `domain/text-content.ts`.                                                          |
| [src/bounded-utf8-file.ts](src/bounded-utf8-file.ts), [src/response-content.ts](src/response-content.ts)                                                                   | Shared bounded regular-file decoding and response-specific EOF/deadline input. Feature adapters retain their own limits and error mappings.                             |
| [src/reply-receipt.ts](src/reply-receipt.ts), [src/commands/reply.ts](src/commands/reply.ts), [src/commands/result.ts](src/commands/result.ts)                             | Versioned local correlation codec and storage-only CLI adapters over the existing request service. No SQL, endpoint discovery or completion policy duplication.         |
| [src/preamble-service.ts](src/preamble-service.ts)                                                                                                                         | Explicit durable-name preamble CRUD/list and its narrow repository contract. Context composes the existing SQLite connection.                                           |
| [src/config.ts](src/config.ts)                                                                                                                                             | Path/settings resolution. Legacy registration fields and request JSON are not runtime authorities.                                                                      |
| [src/request-service.ts](src/request-service.ts), [src/storage/request-repository.ts](src/storage/request-repository.ts), [src/domain/response.ts](src/domain/response.ts) | Application-owned request/cadence/final-response policy, composed SQL adapter and exact-body validation. Context owns the shared connection.                            |
| [src/ui.ts](src/ui.ts), [src/exits.ts](src/exits.ts)                                                                                                                       | Presentation helpers and exit-code registry; do not invent conflicting mappings.                                                                                        |
| [src/commands/install.ts](src/commands/install.ts), [src/update-check.ts](src/update-check.ts), [skills/](skills/)                                                         | User-facing integrations, instructions and updates. These differ from repository developer skills in `.agents/skills/`.                                                 |
| [test/e2e/](test/e2e/), [scripts/](scripts/), [.github/workflows/ci.yml](.github/workflows/ci.yml)                                                                         | Docker fixtures/scenarios, orchestration/pack verification and CI. Unit tests are colocated with source; concurrency entrypoints live in `src/test-support/workers/`.   |

`src/commands/talk.ts` owns the bounded observer and existing request lifecycle
composition. `src/talk-instruction.ts` owns concise recipient guidance only;
input limits remain enforced by the shared response service. The instruction
builder does not parse or infer terminal completion.
The test mock independently recognizes the documented request instruction frame
and invokes the public reply CLI, rather than importing a production response
store or completing requests through a test-only endpoint.

`src/test-support/cli-executable.mjs` owns the test-only executable descriptor:
an absolute executable plus an argv prefix. CLI-contract sandboxes and E2E
fixtures validate/freeze the selection before allocating resources; the fixture
propagates it to real tmux descendants and a separately selectable mock reply
peer. The startup resource probe uses the same owner. This is plain ESM so mock
agents and measurement scripts need no TypeScript loader to select a native CLI;
the adjacent declaration exposes the narrow interface to TypeScript callers.
Selection does not own spawning or disposal: each existing launcher retains its
process-group, timeout, stream and cleanup rules. No production code reads these
test settings, and the entire test-support directory remains excluded from npm.
See DEVELOPMENT for selector usage and the distinction between selectable CLI
contracts and TypeScript-only workers/pack probes.

Identity, request and response concurrency suites share the bounded process
harness in `src/test-support/request-workers.ts`. Each scenario owns its handles
and stops workers in `finally` before deleting fixture files. Worker entrypoints
are resolved relative to their modules, not the caller's working directory.
Readiness barriers, result collection and forced teardown remain test-only;
they do not add production synchronization or change SQLite retry policy.
Package exclusion is a separate inventory concern: fixture placement alone
does not prove that npm omits those files.

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

### Native grammar preview

`rust/` contains a development-only native CLI under #96; installed entry points
remain TypeScript. `tmt-core` owns numeric and settings policy, while `tmt-cli`
owns one Clap grammar, typed requests, presentation, configuration and identity command composition
and explicit no-effects rejection for unimplemented commands. `tmt-adapters`
owns the SQLite lifecycle under #97 and native schema 9 under #108, configuration files under #103,
and bounded Unix tmux evidence under #105;
neither core nor typed requests depend on concrete IO.

Help and completion use a filtered projection of the same grammar, excluding
hidden rejection syntax and unrelated inherited options. Parser errors choose
JSON mode through a grammar-derived, value-aware diagnostic adapter, never a
raw search for `--json` inside payloads. Successful parsing supplies typed
invocations without exposing Clap to application use cases. The binary returns
an exit status through `main` and does not terminate from a domain operation.

Native syntax includes the approved #100 amendment (`rm`/`remove`, temporary
binding defaults and `-s`/`--save`). Names remain globally unique across temporary
and saved identities in one database; no project/workspace name isolation or
directory-based discovery filter is planned. Native `ls` lists all
non-retired identities, including saved offline entries, and show lifetime
separately from active/offline/unknown presence. Unverified evidence cannot retire
a temporary identity or release a saved name. Visibility does not extend routing.
The storage-only identity record foundation under #111 supplies shared creation,
promotion and non-retired selection; #113 wires storage-only create/show/list.
Binding command wiring, retirement and presence listing are implemented under
#109. The durable-global invariants elsewhere in
this map still describe the shipped TypeScript runtime, not the amended
native lifecycle. See [RUST-REWRITE.md](RUST-REWRITE.md) for transition boundaries.

`test/native/` uses the existing CLI sandbox/executable selector for explicit
native-preview process assertions. It requires a selected build, rather than
silently testing TS. The named shared parser-contract subset remains separate
from full native parity. Native unit tests cover typed grammar and core policy;
real tmux behavior remains gated by the existing Docker harness as it is ported.

#### Native architecture guards

`rust/crates/tmt-cli/tests/architecture.rs` is a test-only integration gate run
by ordinary `cargo test --locked` and the existing Native Rust contracts CI job.
Its collector follows production lib/bin module roots from bounded, offline
Cargo metadata; its policy and adversarial fixtures live in separate test
modules. It reuses the process adapter rather than inventing a subprocess runner.

Cargo metadata supplies the actual dependency inventory, including build and
target-specific edges. Explicit layer allowlists require review for new normal
or build dependencies and package aliases; dev dependencies are exempt. Canonical
crate names keep source-layer checks meaningful. The `syn` AST collector follows
inline and external modules, conservatively scans unknown platform/feature cfg
branches, and skips only branches proven absent with `test=false`. Missing,
ambiguous, escaped, malformed, path-remapped or source-included modules fail
closed rather than silently disappearing from coverage.
Associated impl/trait items use the same cfg evaluator as ordinary items.

Core syntax may use reviewed pure standard-library modules, not filesystem,
process or terminal output. CLI grammar, parser, diagnostics and typed invocation
must not import adapters or command handlers. Clap stays in the parsing boundary
(plus entry-point completion rendering), never command handlers. Public core
declarations and policy functions, typed invocation declarations and shared
output types supply reserved names directly from their owners: adapters and
handlers must reuse them, not define competing same-named types or policy
functions. Public declarations in inline modules also seed ownership; methods
do not reserve free-function names. Generic `From<String> for Failure` is rejected; command-local error
mapping must choose its public code and status explicitly.

These are syntactic regression checks, not full Rust name resolution, macro
expansion or semantic equivalence analysis. Differently named duplicate business
logic, effects hidden in macros, and behavior reached through permitted APIs
still require primary review. Comments and literals are not source references.
Changing a boundary requires updating its policy, positive/negative fixtures
and this map together, not adding a file exclusion to make the gate green.

The native storage adapter owns one synchronous, private rusqlite connection.
Opening enforces private files, WAL, foreign keys, the five-second busy timeout,
NORMAL synchronization and real FTS5 availability. Migrations 1–8 retain their
historical definitions, immediate transaction boundaries and lock-held history
rechecks. Migration 6 keeps frozen seven-day retention, bounded batches and
JavaScript-safe saturating timestamps; this is not today's configuration policy.
Close always releases the connection even if checkpoint fails, preserving the
primary error. Cold WAL transitions can return retryable contention, as in the
TypeScript adapter; no new retry loop is hidden in this lifecycle layer.

Native `core::names` is the sole identity-key and pane-target classifier. It
preserves ECMAScript whitespace, NFKC and locale-neutral lowercase, with trimmed
display names and the existing control/pane-shaped rejection. Fixed ICU4X 2.3
normalization/casing data prevents the compiler's Unicode version from changing
canonical keys. This is not case folding or a locale-sensitive name registry.
The pinned Node 22.23.2 reference uses Unicode 17.0; dependency updates must
recheck parity. Stored canonical keys and timestamps are never renormalized.

Native `core::identity` owns lifetime and storage-only create-or-resolve policy.
Its reader and transaction-scoped writer ports are implemented by
`storage::identities` over the existing private connection. Canonical lookup and
creation/promotion share an immediate transaction; only one concurrent caller
can report creation. Save promotes temporary rows in place, while ordinary
reuse never downgrades saved rows or rewrites names/timestamps. UUID generation
and UTC millisecond timestamps belong to the concrete adapter. The service
neither opens/closes storage nor probes tmux. Binding must call this same
creation owner before its separate publication transaction, not fork the policy.
Non-retired selection uses schema 9's index and deterministic BINARY ordering.
Tombstones are excluded and replacement names receive fresh UUIDs; no profile,
binding, request, cadence or attention row is changed by creation/promotion.
Retirement authorization and live presence belong to `core::binding` (#109),
not this storage-only foundation.

`core::binding` owns one evidence evaluator and the binding use cases over
narrow transaction/endpoint ports. Active agreement requires identity, binding,
server/socket/PID/start, pane PID and normalized marker agreement. A changed
server ID alone or inaccessible evidence is unknown, never proof of death.
Conclusive endpoint loss retires temporary rows; saved rows detach and remain
offline. Marker mismatch detaches only the binding, retaining even temporary
identity records. Never-published temporary rows remain offline for retry.

Binding reconciles only the selected old name before invoking the shared
create/promote owner. Creation/promotion commits separately from publication,
so occupied panes or failed metadata writes retain the new UUID/save decision.
Publication acquires a fresh immediate transaction, re-reads ownership and
observations, checks conflicts, writes metadata and verifies before commit.
Concurrent retirement must never resurrect a tombstone. Explicit unbind retires
temporary rows and detaches saved rows without erasing profiles. `rm` retires
either lifetime and deletes only its role/preamble; saved removal requires
`--force`. Exchanges, UUID provenance, attention and cadence survive both.
Unknown evidence fails closed even for forced removal. Matching active markers
are cleared on their recorded socket, never an ambient foreign fallback.

`storage::bindings` extends the existing connection, shared identity decoder and
immediate transaction helper. Global listing starts with one joined ordered
query, groups scopes by full server evidence and probes the selected socket
first, then deterministic socket/server order. No subprocess is spawned per
identity. `tmux::BindingSession` owns a three-second monotonic budget reset after
lock acquisition; SQLite's five-second contention wait is separate. Exhausted
global observations preserve remaining rows as unknown. Scoped lookup never
reconciles unrelated rows; reads never backfill orphan metadata. Native public
presence output omits internal binding/process evidence and stale pane details.

`binding_command` performs caller/target preflight before config/storage,
validates binding settings before identity changes, composes the core use cases,
and publishes one buffered report only after close. Shared `output` owns the
identity projection as well as error publication. Optional pane badge updates
are post-success, recheck the recorded endpoint and alter only the pane-local
option. They never rewrite titles or border themes; failed child cleanup still
propagates instead of claiming clean success.

Native `identity_command` composes the existing typed request, ConfigPaths and
one invocation-owned Storage handle. It never loads configuration contents or
constructs tmux. Create requests Saved through the same core creation owner;
show and ordered list use the existing non-retired selector. Its explicit public
projection adds lifetime to UUID/name/canonical name, without timestamps or
endpoint evidence. Human output names lifetime rather than claiming presence.
Semantic name validation follows storage acquisition, matching standalone TS
ordering; invalid names can initialize the database but cannot create rows.

Native `output` owns shared status-aware failure presentation for parsing,
configuration and identity commands. The identity command retains its report
until explicit close has run, even on operation failure. Failed cleanup replaces
only success with CLEANUP_ERROR and an effects warning; the pending identity and
raw storage causes are not serialized. Existing primary codes, status and causes
survive cleanup failure. Missing identities return NAME_NOT_FOUND/3; unexpected
storage/path failures use bounded IDENTITY_ERROR/1. RAII remains the fallback,
not the ordinary close path. No general service container, second error writer
or new resource framework is introduced by this slice.

#### Native transactional requests

Under #118, `core::request::RequestService` owns preparation, delivery-state
transitions, waiter release, exact final submission, context/result reads and
bounded housekeeping. `RequestRecords` is available only inside the existing
Storage immediate transaction. The clock is sampled after acquiring that lock;
the concrete caller supplies attempt IDs and frozen settings before entry.
There is no service-owned connection, tmux lookup, file input or configuration
loader. #122 supplies public native reply/result composition; #129 composes
public talk over the same service and bounded transport.

`core::retention` is the shared settings/runtime owner for day limits and checked
JavaScript-safe deadlines. Historical migration arithmetic remains frozen.
`core::exact_text` validates UTF-8 bytes without normalization; request and final
bodies share the 1 MiB bound but retain feature-specific errors. Rust strings
already exclude lone surrogates; byte-oriented input must reject malformed UTF-8.

Preparation reserves cadence and known-originator attention with its original
prompt and immutable endpoint. Begin-send and settlement remain separate commits.
Expired prepared attempts commit waiter release/refund before reporting failure;
expired sending attempts become uncertain without refund. Same terminal settlement
and waiter release are idempotent. No request transaction spans transport or polling.

Final submission checks an existing retained final first, allowing exact retries
after attempt metadata removal. Otherwise it validates the request/attempt/full
recorded endpoint, eligibility and completion marker before writing a final,
marker, horizon and attention revision atomically. It never consults current
identity/pane presence; retirement/name reuse does not redirect historical replies.
Rejected submissions perform no housekeeping or other mutation. Reads can perform
bounded cleanup but never acknowledge attention. Prompt, body and metadata expiry
remain independent; only first submission/explicit settlement can extend metadata.

`storage::requests` composes the private connection and shared transaction helper;
record decoding and SQL stay in the adapter. Ordered bounded cleanup retains the
existing horizon-index protection and settlement floor. Attention counter writes
preserve acknowledgment watermarks; revision arithmetic belongs to core. No schema,
receipt table or alternate persistence owner is introduced.

#120 adds `request::correlation` for pure association hashing and the
`reply_receipt` wire adapter for compact encoding and decode-only v1 compatibility.
The exact [receipt protocol](REQUEST-RESPONSE.md#native-compact-receipt-preview-120-under-106)
has one maintained definition. One `SubmitResponse` carries typed `ResponseProof`;
there is no parallel submission API. The existing transaction derives/compares
compact proofs from its retained-final-first lookup, then uses the same final
validation and mutation. No new repository method or schema is needed. Wire
decoding never opens storage. Malformed tokens and proof mismatch remain distinct.

The reviewed pure SHA-256 dependency is permitted only in core; base64 is
permitted only in adapters. Existing serde_json handles bounded v1 envelopes,
not v2 digest serialization. Architecture tests enforce these dependency edges
with positive and adverse cases. This is local correlation, not remote access
control. #129 uses compact receipts in native talk; #106 still owns the installed
recipient-instruction transition before native cutover.

#122 adds `response_command` for public storage-only reply/result. It consumes
the parser's existing typed invocation and the codec before any input acquisition.
Inline/file/stdin input completes and validates before ConfigPaths discovery and
the sole invocation-owned Storage open. Current settings, identity and tmux are
not consulted. The command injects a UTC millisecond clock sampled by the service
under its existing transaction. No service policy, SQL or extra connection moves
into the handler. Reports remain buffered until explicit close; unavailable
results are primary status-3 failures, so cleanup cannot replace them.
Shared `output::Failure` carries only optional request-ID/status correlation,
never bodies, receipts or endpoint evidence. Cleanup failure on success preserves
the explicit request ID with an effects warning.

`response_input` owns bounded complete acquisition, using the existing core
exact-text validator. Files use nonblocking open, regular-file verification and
cap-plus-one reads; explicit symlinks to regular files remain supported. Stdin
requires EOF under a five-second monotonic deadline and a 1 MiB cap, rejects TTYs,
and uses safe nix poll/read/fcntl without reader threads or another process runner.
Inherited open-file flags are restored before returning; normal failure preserves
its primary cause and any restoration failure. RAII supplies descriptor closure
and fallback flag restoration, not a substitute for explicit cleanup reporting.
The CLI owns stdin exclusively during acquisition. Nonblocking flags do not make
arbitrary kernel/filesystem stalls cancellable; regular-file reads retain the
existing local-file contract, not a remote-filesystem latency guarantee.
Darwin's EOPNOTSUPP terminal probe is accepted only after fstat confirms a socket;
other probe failures stay errors. Public messages remain bounded and exclude paths
and OS causes. Existing nix adds only fs/poll runtime features; term is test-only
for an isolated pseudoterminal rejection case, with no new locked packages.

#124 adds `tmux::transport` on the existing Tmux/CommandRunner boundary. Its
explicit socket and stable pane inputs are routing results, not permission or
fresh identity evidence. The caller retains the original prompt; this adapter
alone protects ASCII exclamation marks and ensures a trailing newline for pane
transport. An invocation owns a UUID-named buffer, one paste (or one literal
fallback after set-buffer failure), the configured delay and one Enter. A failed
paste, literal input or Enter is uncertain delivery and must never be replayed.
Ordinary owned-buffer cleanup is best effort; failed subprocess cleanup is
retained and prevents fallback. Delivery errors keep primary and secondary
cleanup causes without exposing payloads or endpoint paths.

Send commands retain a one-second, 64 KiB-per-stream subprocess budget; capture
uses one second and 4 MiB per stream. These are per-command bounds, not an
overall send/observer deadline: configured Enter delay remains separate. Capture
is complete diagnostic text or failure, never a completion signal. Both paths
use the same process group/deadline/reaping owner as endpoint evidence, with no
new process runner or dependencies. Public check and talk composition are supplied
by #125 and #129 respectively; installed-runtime promotion remains separate work.
The development-only tmux probe exercises these APIs in the existing private
Docker fixture. Fault injection parses the actual tmux command after socket
options, keeping explicit native and ambient TypeScript calls observable through
one harness path.

#125 adds current-server routing and public diagnostic check/read. The existing
`PaneIdentity` observation retains its server and optional binding alongside the
pane/identity, so later delivery can consume the same evidence rather than
rediscovering discarded fields. `binding::current_name_presence` performs a
normalized lookup and one scoped current snapshot under the existing binding
transaction. It reuses `reconcile`/`evaluate_binding`; foreign socket evidence
cannot become an active route, and unknown evidence does not authorize cleanup.
Global `name_presence`/listing remain separate presence reporting, not routing
permission. No new record port, SQL owner or name-creation policy is introduced.

CLI `target` composes pane-first selector IO and these core projections.
`binding_error` is the shared presentation translation for binding and target
callers, not a second policy owner. `check_command` validates configuration,
opens one Storage handle, resolves the target, captures outside the binding
transaction, explicitly closes storage, then emits diagnostic output. Only
public identity name/canonical-name fields enter that report; server/process
evidence stays internal. Terminal text still never completes a request.
Native process tests share one calibrated tmux tripwire instead of copying
host-protection wrappers across command suites. Docker's existing wrapper owns
capture failure injection after successful target resolution.

#127 adds native role/preamble commands. Core `profile` owns one bounded
normalization contract and a validated content value; exact exchange text remains
separate. Its profile reader/writer ports share role/preamble mechanics without
merging their tables or injection semantics. The existing identity record decoder,
Storage connection and immediate transaction helper remain the SQL owners.
Writes revalidate the observed non-retired identity ID within the transaction,
so a retired/reused name cannot receive a stale profile write. Reads and listing
hide retired owners; profile operations do not promote lifetime or change cadence.

CLI `identity_context` composes explicit canonical lookup or existing verified
caller/binding evidence, never pane-target routing for an explicit identity.
`profile_command` acquires role files before opening storage, resolves identity,
normalizes content, applies the shared operation and closes before presentation.
Explicit access does not load settings or probe tmux. Role and preamble retain
their separate public projections and error codes. Native public identity
projections include the lifetime field established by #109.

Adapter `bounded_file` is the shared regular-file byte acquisition owner for
role and reply: nonblocking open, regular-file check, maximum-plus-one read,
and overflow rejection before decoding. Callers retain their respective UTF-8
and content policies. Reply stdin flags, deadlines and exact-body validation are
unchanged; role does not gain stdin. This is not a path-confinement boundary.

#### Native durable talk composition

#129 adds `talk_command`, with preparation, observation and presentation local
to that use case. It reuses `target`, `identity_context`, profile reads,
`RequestService`, compact receipts and `Tmux` transport; no handler SQL or
parallel lifecycle is introduced. Config and exact original input validate
before endpoint/storage effects. Optional attribution permits an unknown caller;
explicit selection stays lookup-only. After pre-send delay, a fresh scoped
snapshot passes through the existing binding evaluator before preparation.
This is evidence, not a processing lease.

Preparation persists the exact original prompt; only transport payload adds
reserved preamble and reply guidance. Roles are never injected. Independent
request/attempt UUIDs feed the existing 25-character v2 encoder. Begin-send and
settlement remain separate service commits around transport. Proven preparation
failure maps to `DELIVERY_PREPARATION_FAILED`; uncertain paste/literal/submit
maps to `DELIVERY_UNCERTAIN`, with stage and request correlation. Neither retries.
Every post-preparation waiting path releases only its waiter; late finals remain
eligible. A monotonic deadline begins before begin-send, includes transport, and
is checked before/after reads. Crossing reads lose without rereading. Positive
polling intervals round up to a millisecond and clip to the remaining deadline.
The shared adapter wall clock is separately sampled inside service transactions.

Adapter `interrupt` owns SIGINT registrations through pinned `signal-hook` and
a nonblocking Unix self-pipe waited through existing nix poll. No worker thread
or second process runner is added. First SIGINT wakes observation; a second
retains emergency termination during blocked synchronous work. Bounded process/
SQLite operations and configured Enter delay are not instantly cancellable.
The guard stays through waiter/storage cleanup and publication, then unregisters
its callbacks and closes descriptors. The library's OS dispatcher remains until
process exit; this is a CLI lifetime, not host-application signal restoration.

Shared failure output carries public target/request/stage fields, while primary
and secondary cleanup causes stay internal. Storage closes before publication;
close failure cannot publish success. Installed-runtime and skill cutover remain
separate delivery gates.

#### Native exchange attention

#131 adds `x list/show/ack/ackall` through the same `RequestService` and
transaction-scoped `RequestRecords`. The attention module defines typed summary
and detail projections, sharing final-state metadata and acknowledgment rules.
The existing request adapter owns joined metadata-only list queries and guarded
updates; it adds no schema, connection, revision allocator or retention policy.
Detail reuses the original-context projection and reads exact final text only
for detail, never for listing. Immutable submission markers distinguish expired
or unavailable bodies from work that has never received a final.

Explicit identity selection is storage-only; implicit selection requires a
verified caller before request access. Retired-name reuse does not transfer
UUID-owned history. Reads never acknowledge. Exact-revision ack conflicts with
a newer final; repeated current ack is idempotent. Ackall captures the current
identity watermark atomically without a preliminary client read, and later
revisions remain visible. Final submission plus current acknowledgment defines
settled state, independently of delivery or observer exit. Cleanup and ack share
the existing transaction and clock; failure rolls both back. CLI storage closes
before presentation. Installation and installed-skill cutover remain separate.

#### Native storage and runtime adapters

Native migration 9 adds `lifetime` (default `saved` for existing identities) and
nullable `retired_at_ms` to that same identity table. A partial unique index
reserves canonical names only for non-retired rows; old UUID/name metadata can
survive name reuse. It does not retire rows, remove bindings or profiles, or
acknowledge exchanges. Actual retirement and cleanup authorization belong to
the binding service, not SQL triggers or a second registry.
Lifetime and retirement are independent: explicit confirmed removal may also
retire a saved identity; ordinary pane death must not do so.

Changing the old unconditional unique constraint requires a table rebuild.
The private opening connection temporarily suspends foreign keys outside the
immediate migration transaction. The runner rechecks history under the lock,
validates the historical identity definition, rejects custom identity
columns/constraints/indexes/triggers, checks existing foreign keys, copies
the identity table, replaces it, records the migration and checks foreign keys
again before commit. Enforcement is restored after commit or rollback, before
any successful handle can escape. A failed opening closes the connection.
The rebuild never renames the original table first or edits sqlite_schema;
bindings, role/preamble/cadence rows and request identity references are preserved.
SQL, record-insertion and commit failure tests verify rollback and enforcement,
not merely a healthy empty database.

This is a forward-only development boundary: installed TypeScript remains on
schema 8 and rejects schema 9. Do not use the native preview against user state
or run old and new writers on the same database. Before distribution, #82/#93
must provide stopped-writer cutover, consistent backup/recovery and preserved
old-receipt execution. Replacing a binary does not downgrade a database.

`storage-probe` is a development-only example using that real adapter, not a
public CLI command or alternate storage implementation. Shared bounded subprocess
tests compare closed TypeScript schema-prefix fixtures and independent SQL
observations and exercise failure recovery. Prefixes 0–8 retain historical
schema/data semantics except the explicit ninth identity amendment; tests assert
TypeScript rejects the upgraded database without mutation and native reopen is
idempotent. Independent snapshots retain exact bodies, provenance, horizons and
attention across the rebuild. The earlier schema-8 reverse-open success is
superseded by this explicit forward boundary, not silently counted as passing.
These tests establish migration preservation, not native request/identity parity.

The native `config` command uses core-owned typed values, defaults, editing scope
and local-clear rules. Its filesystem adapter owns global/XDG/legacy and upward
local-path discovery, JSON container validation, known-setting projection and
raw edits preserving opaque fields. A targeted repair validates shape, edits
only the intended field, then validates all remaining known values before write.
Loaded sources and resolved settings come from the same projection. CLI code
does not contain a competing settings validator, and core imports no JSON or IO
library. This shared boundary is available to subsequent native use cases;
configuration operations never acquire the storage or tmux adapters.
Precedence and source accounting live in core `ResolvedSettings`, not the file
adapter. Config and pane metadata reuse `json_document` to normalize arbitrary
JSON numbers to the prior runtime's IEEE-754/stringification semantics; this
explicit editable-document boundary never rewrites retained reply
bodies. Ordered JSON maps minimize edit churn. XDG and derived file paths are
normalized lexically without requiring discarded components to exist or
resolving user symlinks.

The native `process` adapter owns argv-only execution, concurrent stdin/stdout/
stderr communication, independent output caps and monotonic deadlines. It uses
`subprocess` communication while retaining the process-group owner, with explicit
kill/reap and a separate one-second cleanup budget. No detached reader threads,
shell interpolation or async runtime are introduced. An exceptional unreaped
child is detached only to avoid an unbounded destructor and is reported as
failed cleanup, never successful termination. Group signals are not sent after
the leader has been reaped. On Darwin, a zombie-only group may return EPERM;
only read-only confirmation of group absence after reaping clears that error.

Native `tmux` composes this runner for target resolution, caller ancestry,
coherent scoped snapshots and metadata read/modify/write. `tmt-core::endpoint`
owns observation types and ID validity, not registration. Caller and snapshot
wire parsing share strict decimal safe-integer decoding; unlike permissive
JavaScript Number conversion, signs, exponents and hexadecimal fields are not
accepted as process evidence. Actual tmux/ps output uses decimal fields.
Missing and malformed caller evidence fails closed; complete context uses one
small query, while ancestry and its pane query share a one-second deadline.
Scoped reads never expand an empty scope, and linked/grouped rows are validated
before deduplication. Only reliable recorded-PID absence establishes death.
Known-socket probes never initialize or overwrite foreign server metadata.
Validated observation scopes are bounded to 1,024 panes and a conservatively
estimated 32 KiB filter argument before construction. Larger probes are unknown,
not dead; explicit snapshots fail closed. Filters append a balanced disjunction
into one buffer, bounding tmux evaluation depth rather than nesting once per
identity. A copied server UUID on another socket cannot pass full evidence
agreement; binding fails closed rather than adding a second endpoint registry.

Expected unavailable caller/target evidence and uncertain probes retain their
optional/unknown results, but failed subprocess cleanup propagates as an error.
It cannot trigger fallback server initialization or be hidden by best-effort
observation. Metadata reads remain fatal before writes; unknown siblings survive
marker replacement/clear. Binding coordination uses the application port above;
message transport uses the same bounded runner under #124.

The non-installed `tmux-probe` example exposes only narrow adapter operations
and counts runner calls. The existing Docker fixture selects it through the
shared executable descriptor. The same pinned Debian image builds native
artifacts, runs adapter unit tests under `--init`, and executes real private-tmux
scenarios with mock agents and no network. These are adapter integration tests,
not public command acceptance on their own. The same image separately selects
the native CLI for identity lifecycle (#109) and durable talk (#129) scenarios.

The [Rust rewrite decision](RUST-REWRITE.md) records the proposed native package
boundaries, compatibility/test matrix, data coexistence gates and dependency
evaluation under [#93](https://github.com/wkh237/tmux-team/issues/93).
It is not the shipped module map. [Preparation #94](https://github.com/wkh237/tmux-team/issues/94)
adds opt-in measurement tools reusing the E2E fixture and bounded packed-command
runner; [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md) owns their protocol and
limitations. Production remains TypeScript until an explicitly verified cutover.
The test-only tmux trace keeps one record per invocation by normalizing newlines
in logged arguments, while forwarding the original arguments unchanged. A real
tmux buffer round-trip verifies this separation; it is not a transport rewrite.

These links identify owners of unresolved work, not permission to widen an
unrelated PR. Update this section and the current map in the delivering PR when
a gap is resolved; do not leave a permanent exception or label a proposal as shipped.

| Gap                                                                                   | Owning issue                                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Memory and an offline recipient inbox remain future capabilities, not installed APIs. | [TMT-15](https://linear.app/tigerpig-dev/issue/TMT-15), [TMT-16](https://linear.app/tigerpig-dev/issue/TMT-16) |

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
