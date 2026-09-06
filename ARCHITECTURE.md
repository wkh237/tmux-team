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
`check` remains diagnostic and retains its existing reconciliation behavior.
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
binding evaluator checks this evidence against a fresh full endpoint snapshot.
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
evidence, and durable metadata agreement. Reconciliation alone applies the
foreign-socket preservation guard before evaluation; discovery still excludes
bindings that do not match the current server. The shared predicate does not
change publication, transaction, or routing policy.

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

The ordered provider list and its derived type live in `skill-installation.ts`.
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

`src/skill-installation.ts` owns shared package-root, bundled-source, managed-target,
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
