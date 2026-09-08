# TMT-35 request/response channel research

Status: historical research based on `cecaec7` (2026-09-05), with the accepted
direction and TMT-36 service contract maintained below. The shared final-response
service, explicit reply/result adapters and default durable `talk` are implemented
through TMT-36/38/39 under TMT-37. No provider integration, daemon,
inbox or memory feature is supplied here.

## Accepted direction and implemented CLI contract

The [accepted design](https://linear.app/tigerpig-dev/document/accepted-design-durable-replies-automatic-completion-and-human-21745047ee15)
supersedes the earlier opt-in proposal below. TMT-36 adds immutable full replies
to the existing request service; TMT-37 changes the CLI to wait for a durable
reply by default, with bounded `--timeout` and explicit `--detach`, retiring
`--wait` and the polling/wait mode switch. The default-wait change is implemented
by TMT-39. Explicit `reply`/`result` adapters are described
below. Terminal capture and `check` must not be treated as authoritative durable
completion or full-body retrieval.

A cooperating agent first successfully submits its complete final body, then
shows the user a short summary of work, actual verification, and unresolved
items. A summary is not completion evidence. Submission failure must not be
reported as delivery success; a failed summary cannot undo an accepted reply.
A delivered reply may truthfully report failed or blocked work.

CLI and future MCP/provider adapters must compose the same functional core.
MCP and authenticated remote connectivity are a separate future project; neither
requires a daemon, network service, or parallel state machine in this slice.

### TMT-36 service implementation contract

The tracked implementation extends `RequestService` with `submitResponse` and
`getResponse`. Submission supplies `requestId`, `attemptId`, the recorded six-field
endpoint and an exact body. A response record carries those values, its UTF-8
`bodyBytes`, and immutable `submittedAtMs`. The body limit is 1,048,576 bytes,
inclusive. Empty text, BOM, NUL, CR/LF and valid Unicode are preserved; malformed
Unicode and oversized input fail before mutation. File/stdin decoding is a later
adapter responsibility, not an alternate response store.

One immediate transaction validates the request, attempt and full endpoint and
accepts only `sending`, `sent` or `uncertain`. A matching retained final is an
idempotent retry with its original timestamp; different content cannot overwrite
it. `prepared` and `definitely_failed` cannot submit. If a reply wins the race
against definitely-failed settlement, settlement remains conservatively uncertain
and cannot refund cadence. A local reply is not authentication or proof of an
external transport effect. No transaction spans external work.

The submission deadline is the later of attempt expiry and seven days after
preparation. Equality is expired. Wait release and the existing one-hour minimum
attempt expiry do not end that window. Cleanup preserves terminal attempt metadata
through both this deadline and the existing 24-hour settlement retention floor.
Final bodies have independent retention after submission, using the duration
frozen on their request (90 days by default for new requests); expired bodies
are hidden by reads and deleted by opportunistic cleanup. This is not a scheduled
physical-deletion SLA. Retained retries remain idempotent past submission expiry.

TMT-54 persists retention through a forward migration. Existing requests and
bodies retain a concrete seven-day duration, preserving submission timestamps;
new global policy never extends those old bodies. The global config's
`exchange.retentionDays` accepts integer days 1 through 3650, default 90.
`config set exchange.retentionDays <days> --global` changes future preparation
only; local override/clear is rejected. Reply/result use stored deadlines and
do not load current configuration. No permanent alternate legacy runtime path
or migration-time rebasing is introduced.

Initial metadata expiry protects the preparation content horizon, reply
acceptance deadline and attempt-expiry-plus-24-hour settlement floor. An actual
nonexpired settlement protects its own floor; first final submission extends
metadata through that body's expiry. Reads, housekeeping, waiter release and
identical retries do not renew retention. Metadata cannot be pruned ahead of a
retained final or still-eligible reply. TMT-55 retains original prompts and
provenance as described below; TMT-51 adds identity-scoped attention.

Service-owned request/result reads apply logical expiry independently of physical
cleanup. Opportunistic cleanup uses deterministic limited batches in a short
transaction: up to 100 expired-attempt transitions, 100 prompt scrubs, 100 final deletions and 100
metadata deletions. Batch failure rolls back and propagates through the existing
error boundary. Repeated invocations drain backlog; no invocation means no
scheduled deletion. Deadlines are fixed UTC wall-clock values. Clock rollback
can delay logical expiry while content is physically present, but never changes
the stored deadline or restores deleted data. Cleanup is not secure erasure,
file shrinkage, acknowledgement, cancellation or a change to reply eligibility.

Migration 5 adds independent `request_responses` rows, with complete endpoint
snapshots and no cascading foreign keys to attempts or identities. It also adds
`response_submitted_at_ms` to attempts, committed atomically with the final body.
That bounded completion marker prevents recreation or false cadence refunds if a
long-lived attempt outlasts its body's retention. It is not a second result body or
an unbounded tombstone store. After all retained metadata is physically removed,
an unknown request cannot be distinguished from a previously expired one.

Typed response errors distinguish invalid/oversized input, unknown request, wrong
attempt, wrong recipient, ineligible state, expiry and conflicting content.
Rejected submissions preserve attempts, cadence and responses. Storage failures
remain storage failures. No cancellation operation, retry routing policy or new
CLI command is introduced by this service contract itself.

### Explicit CLI adapters (TMT-38, extended by TMT-40)

TMT-37 is split into TMT-38 (bounded submission/retrieval) and TMT-39 (default
durable `talk`, obsolete-mode removal and the exact-body Docker cutover).
The current grammar includes TMT-40's inline source:

```text
tmt reply <request-id> --receipt <receipt> (--message <text> | --file <path> | --stdin) [--json]
tmt result <request-id> [--json]
```

The receipt is an explicit version-1 base64url envelope of request ID, attempt ID
and the complete six-field endpoint. Its encoded length is at most 8192 characters.
It is not authentication. The recipient must use the supplied receipt, not infer
the latest request from a pane. `talk` supplies it in the recipient instruction,
including detached requests. No receipt is included in routine result/ack output.

Files must resolve to regular files; symlinks are followed, and descriptors are
closed after bounded reads. Explicit stdin requires EOF within five seconds.
Both reject malformed UTF-8 and bodies beyond 1,048,576 bytes before submission,
preserving empty text, BOM, NUL, CR/LF and whitespace without normalization.

Inline `--message` passes its exact string to the same service validation.
Exactly one source is required; an explicit empty inline string is valid.
Shell quoting and OS argv size limits apply, and argv cannot contain NUL.
Use file/stdin for larger or NUL-containing bodies.

TMT-40 groups one reply command in `<tmt-reply>` tags, including the receipt
once, with brief submission/summary/error guidance outside. This is request
grouping, not a hidden UI promise or terminal-output boundary. HTML comments
would conflict with ASCII `!` protection, which remains unchanged. Detailed
input and retry rules remain in installed skills/help instead of every request.

Reply success returns `status: submitted`, `requestId`, `bodyBytes` and
`submittedAtMs`. Identical retries preserve the timestamp; different bodies
cannot overwrite a final. Result success returns `status: completed`, `requestId`,
exact `response`, `bodyBytes` and `submittedAtMs`. JSON is the exact-text interface;
human output adds formatting. A missing retained result is `status: unavailable`
with `RESPONSE_NOT_AVAILABLE` (exit 3), not a claim that a request is unknown,
cancelled or completed. Input deadline uses exit 4; conflicting final uses exit 5.

Storage-only commands work after pane closure and waiter exit. They reuse the
service and its retention, not another reply store. Agent guidance requires a
truthful short user summary only after successful submission. Submission means
the result was delivered, not that the requested task succeeded. Summary failure
does not undo or justify repeating an accepted final.

### Native compact receipt preview (#120 under #106)

The native internal codec emits exactly 25 ASCII characters: `v2_` plus
canonical unpadded base64url of the first 16 SHA-256 digest bytes. The preimage
starts with ASCII `tmux-team/reply-receipt/v2` and NUL, followed in order by
request ID, attempt ID, server ID, socket path, server PID, server start time,
pane ID and pane PID. Each string is exact UTF-8 prefixed with its unsigned
64-bit big-endian byte length; PIDs are unsigned 64-bit big-endian integers.
Independent goldens freeze this protocol, including Unicode byte lengths and
ambiguous concatenation boundaries. Padding, nonzero trailing bits, unsupported
versions and partial tokens are rejected.

A raw v4 UUID would encode compactly but carries only 122 random bits and does
not bind the endpoint. The selected digest binds the whole recorded association
without storing another token. Its 128-bit output space is not a promise of
128-bit collision resistance, secrecy or authorization. Predictable inputs stay
predictable; native callers must generate independent random request/attempt IDs.
This local correlation format is not a remote MCP access credential.

The existing `submit_response` takes one `SubmitResponse` with a recorded or
compact `ResponseProof`. Within its existing immediate transaction it looks up
the explicit request ID, prefers a retained final, and validates the proof using
that record's attempt/endpoint. It never scans by token, looks up a current pane
or performs a preliminary housekeeping read. Identifier uniqueness still fails
atomically; there is no token registry, retry loop or collision-resolution table.
Wrong compact proofs return `RESPONSE_RECEIPT_MISMATCH`; unknown requests retain
`RESPONSE_REQUEST_NOT_FOUND`. Rejections mutate nothing. Both proof modes use the
same body, eligibility, immutable-final, retention and attention implementation.

Native v1 decoding is compatibility input only, not another emitter or service.
It preserves bounded strict UTF-8, the exact old object shape, safe positive PIDs,
canonical base64url spelling, positional request matching, and JSON whitespace,
key-order and duplicate-key-last-value behavior. Retained finals remain sufficient
for retry after attempt removal; expiry and conflicts never renew them. Tests
execute original TS-generated v1 receipts against migrated frozen schema-8
fixtures, including in-flight and orphan finals. This proves service handoff,
not simultaneous TS/schema-8 access to native/schema-9 state.

Installed TypeScript still emits v1. #122 enables public native preview
`reply`/`result`, using this codec and the existing service with complete bounded
input before storage. Both v1 and v2 receipts work without tmux or current config.
The same submitted/completed/unavailable output and exit contracts apply; a
stopped schema-8 fixture can migrate through native reply while retaining its v1
instruction. This is not permission to mix writers after schema-9 migration.
Native talk is still absent. Parent #106 owns generated instruction measurements,
canonical installed guidance and full private-tmux/mock-agent acceptance before
cutover; installed skill/README instructions remain unchanged for now.

### TMT-39 live durable completion

`talk <target> <message> [--timeout <time> | --detach] [--json]` waits for the
shared service's complete final by default. It no longer captures or cleans
terminal output to determine completion. `send` follows the same semantics.
The recipient must cooperate by invoking reply; idle output, fake markers,
process exit and human summaries do not complete a request.

Timeout defaults to 180 seconds unless configured, accepts finite positive
seconds or ms/s suffixes, and is bounded to 24 hours. Explicit timeout and
detach are mutually exclusive. The monotonic deadline starts immediately before
beginSend/transport, after delay/preparation/receipt encoding. Checks before and
after each synchronous response read treat equality or crossing as timeout;
there is no final post-deadline read. Poll sleeps are bounded by remaining time.
Synchronous transport/Enter time counts, but cannot be cancelled mid-operation.
Timeout/interruption only releases the observer; late results remain retrievable.

Detached JSON is `{status:"sent",requestId,target,pane,identity?}`. Completed
talk returns `status:"completed"`, the same correlation and exact `response`,
`bodyBytes`, `submittedAtMs`. Timeout uses `status:"timeout"`, request/target/pane
correlation and `error:{code:"TIMEOUT",message}` (exit 4), without partialResponse,
nonce, endMarker or truncated. Delivery/state uncertainty remains nonzero and
retains inspection correlation, never automatic resend. Failure during receipt
construction before beginSend refunds a proven-unsent reservation.

`--wait` is rejected with migration guidance; talk rejects `--lines` while check
retains it. Stored mode/maxCaptureLines values are inert, not automatically
rewritten; explicit local `config clear mode` deletes only that obsolete key.
Historical migrations/nonce columns stay unchanged; new attempts omit nonce.

The Docker peer submits through the real public reply CLI, logs causal
request/submitted/summary or failure events, and retains a full-body oracle.
Virtualized output exposes only its tail; acceptance requires exact complete
talk/result equality, not a missing-interior characterization. Same-pane input
serialization, exactly-once processing, inbox and remote authentication are
still outside scope. User-installed skills teach full submission first, then
a truthful work/tests/blockers summary; failed submission is never success.

## TMT Exchange foundation and attention

This section is the canonical contract for a TMT Exchange (X).
TMT-54's retention foundation and TMT-55's provenance/original context are
implemented. TMT-30 also supplies explicit storage-only identity create/show/list;
TMT-51 supplies identity-scoped attention below. The current `talk`,
`reply`, `result`, and diagnostic `check`
contracts above remain unchanged.

Planning and bounded follow-up ownership are tracked by [TMT-49](https://linear.app/tigerpig-dev/issue/TMT-49),
[TMT-50](https://linear.app/tigerpig-dev/issue/TMT-50), with retention in
[TMT-54](https://linear.app/tigerpig-dev/issue/TMT-54) and provenance/context in
[TMT-55](https://linear.app/tigerpig-dev/issue/TMT-55),
[TMT-51](https://linear.app/tigerpig-dev/issue/TMT-51) (attention), and
[TMT-30](https://linear.app/tigerpig-dev/issue/TMT-30) (implemented identity bootstrap).
The same identity commands work inside and outside tmux, without implicit
selection or automatic binding. Explicit talk attribution may use an existing
identity even while another pane is bound to it; this is not authentication.

X is a logical collaboration record that relates an originator's request, its
delivery attempts, the recipient's one immutable final reply, and per-identity
attention state. It should extend the existing `RequestService` and
`RequestRepository` over Context's existing SQLite connection. It does not
mandate a second `XService`, a second database, a new table name, or a new ID
format: existing request IDs and receipt/attempt fencing remain reusable.
Attention revisions/high-water marks are not response-body revisions. A final
reply remains one immutable body; an identical retry remains idempotent and a
conflicting body remains a conflict. A late accepted reply can create the final
body or reopen an unacknowledged attention revision; it never overwrites an
existing final body.

Migration 7 adds independent originator selection kind (unknown, explicit or
verified), optional originator UUID and recipient UUID. Existing `identity_id`
remains target preamble/cadence state, while public `talk.identity` remains
recipient presentation. Historical rows keep unknown provenance and NULL
original context; no pane, cadence, name, receipt or old-file backfill occurs.

New preparation requires exact original message text, before preamble, receipt
instruction or `!` protection. The existing service validates well-formed Unicode
and a 1,048,576 UTF-8 byte inclusive limit through a primitive shared with response
validation. Empty, BOM, CR/LF, NUL and Unicode are preserved, without role/preamble
normalization. Request wrappers retain `REQUEST_INPUT_INVALID` and
`REQUEST_INPUT_TOO_LARGE` (exit 1). CLI argument limits still apply; no talk
file/stdin option is added. Validation follows config/timing checks and precedes
target effects, then originator selection, cadence and transport.

`talk <target> <message> --identity <existing-name>` (and `send`) selects an
existing durable originator even when offline, overriding implicit caller
selection. The option is command-local, not a global flag or recipient selector.
Omission records a verified caller when present, otherwise unknown; anonymous
talk/result still work. Unknown explicit selection is NAME_NOT_FOUND (exit 3);
ambiguous or reconciliation failures stop before sending (exit 1).
The internal target projection retains the independently verified recipient UUID
even with no preamble, and rechecks identity/binding markers and full server/pane
evidence against the fresh pre-preparation snapshot. A changed observation rejects
before persistence/cadence/send; later rebinding never rewrites recorded IDs.
This does not authenticate authorship or guarantee which identity later processes input.

Original messages are retained locally, always on for new preparation in this
slice; avoid secrets. There is no upload, indexing, redaction, encryption or
secure-erasure claim. Their fixed expiry is preparation plus the frozen policy,
not the extendable metadata horizon. Final submission cannot renew the prompt.
General metadata/list queries exclude prompt text/bytes. A focused internal
getRequestContext(requestId) read returns one retained attempt and a prompt
status: retained with exact message, byte count and expiry; expired with expiry;
or unavailable for historical content. Unknown/expired metadata returns no
record. Equality is expired even outside the bounded physical scrub batch.
The shared cleanup transaction scrubs at most 100 ordered indexed expired
prompts, retaining their expiry markers. It neither renews nor acknowledges.
`x show` reuses that projection for identity-scoped public context.

`x` commands select the originator's data with
`--identity <name>` through the shared durable selector. Omission requires a
verified caller identity; outside that context it fails rather than guessing.
Selection is local attribution, not authentication. This required
identity for `x` does not change talk's deliberate anonymous-caller exception.

The attention contract is identity-scoped and explicit:

- A read, including `result`, `x show`, or an unacknowledged listing, never
  mutates attention state or acknowledges a revision. Service-owned reads may
  perform logical-expiry checks and bounded housekeeping; `check` remains a
  diagnostic command whose existing reconciliation behavior is separate.
- The default unacknowledged view is scoped to the originator. The
  recipient's responsibility to submit a result is distinct from the
  originator's responsibility to acknowledge it; a recipient view must not be
  inferred from the current result command.
- `tmt x ack <request-id> --revision <revision>` acknowledges the exact observed
  attention revision for the selected identity. If the X is still pending,
  this acknowledges only the progress observed at that point; it does not
  claim a successful task or cancel delivery.
- A reply that arrives after that acknowledgement creates a newer attention
  revision and reopens the X for that identity. A single ack must use a
  revision/high-water compare-and-swap so it cannot acknowledge a newer result
  that was committed after the caller's observation.
- `tmt x ackall` takes one bounded, atomic snapshot of the
  selected identity's eligible revisions. Results committed concurrently after
  that snapshot remain unacknowledged and cannot be hidden by the batch.
- An X is settled only when it has a final reply and its current attention
  revision is explicitly acknowledged. A proven failed delivery may be
  acknowledged as an exception for attention management, but that is not
  successful work or a delivered result.

The command surface is `tmt x list`, `tmt x show <request-id>`,
`tmt x ack <request-id> --revision <revision>`, and `tmt x ackall`.
`tmt x` is equivalent to `tmt x list`. All accept command-local `--identity`
and `--json`; only list accepts `--limit` and `--after`, and only ack accepts
the mandatory `--revision`. Old `ack --all` and batch tokens are rejected.

Migration 8 assigns deterministic initial revisions to already known v7 originators
ordered by preparation time and request ID. Unknown/anonymous provenance stays
outside identity attention. Per-originator counters survive request cleanup;
revision exhaustion rolls back the whole request/final write. Preparation and
the first accepted final are the only revision events. Delivery transitions,
waiter release, cleanup, reads and identical retries do not advance them.

Ackall needs no previous list: inside the existing immediate transaction it
advances one identity's acknowledged-through watermark to its latest revision.
It neither enumerates nor counts nor updates individual requests. A writer
committed before that snapshot is included; a later writer allocates a higher
revision. Each invocation takes a new snapshot. Single ack compares the supplied
revision inside the transaction and never advances the identity watermark.

List returns `{identity,items,nextAfter}` with at most 50 items by default
(`--limit` 1..200). `--after` is a nonnegative decimal safe integer (default 0).
Rows are ordered by increasing revision and only unacknowledged retained metadata
is returned. One extra metadata-only row detects continuation: `nextAfter` is
the last returned revision when more exist, otherwise null. This is a live view;
deduplicate by request ID and restart at 0 to refresh. No body is loaded by list.

Summary fields are `requestId`, nullable `recipientIdentityId`, `preparedAtMs`,
`delivery`, `final`, `revision`, `acknowledged`, `settled`, `retentionExpiresAtMs`.
Final is `not_submitted`, `retained` (submission time, bytes and expiry), `expired`
(submission time and expiry), or `unavailable` (marker exists but eligible body
is absent). Missing final is not evidence that a task is running. Show returns
`{identity,exchange}` and adds `prompt` plus exact `final.response` when retained.
Attempt IDs, receipts and endpoint evidence are not exposed.

Ack returns `{identity,requestId,revision,acknowledged:true,changed}`; a repeat at
the current already-effective revision has changed:false. Ackall returns
`{identity,acknowledgedThrough}`, not a count or a claim that every body was read.
Stale revision is `X_REVISION_CONFLICT` (exit 5). Unknown, anonymous, wrong-owner
and metadata-expired IDs share `X_NOT_FOUND` (exit 3). Invalid runtime parameters
use `X_INPUT_INVALID` (exit 1); revision overflow uses `X_REVISION_EXHAUSTED` (1).
Unexpected failures use sanitized `X_ERROR` (1); shared identity errors remain.

`talk`, `reply`, and `result` remain the verbs for sending, submitting, and
reading. `check` remains a pane diagnostic only. Timeout and interruption
remain observer-only: they do not cancel or complete X, and the existing
180-second default remains current behavior. No offline queue, lease, daemon,
memory feature, or MCP state machine is implied. An eventual minimal MCP
client may use live tmux delivery and the same SQLite-backed reply path without
requiring caller identity or an inbox; authenticated remote access is separate.

TMT-54 owns the shared frozen policy, metadata/final horizons and bounded
housekeeping. TMT-55 supplies prompt privacy/validation and consumes the
preparation-anchored horizon; TMT-51 defines attention/ack and
unavailable-versus-pending projections through that same owner. Do not add a
parallel cleanup subsystem. SQLite has no autonomous TTL scheduler, so no daemon,
cron, network service or punctual physical-deletion promise is introduced.

Acknowledgement is not deletion, and unread records are not retained
indefinitely. An expired result is unavailable, not pending. A hard metadata
horizon eventually makes an old X indistinguishable from unknown, honestly and
without a permanent tombstone guarantee. Eligibility and fencing metadata must
not be deleted before their acceptance/late-reply obligations end, and an
expired final must never be resurrected. Data deletion is not database-file
shrinkage or secure erasure: do not run `VACUUM` on every command or treat
`auto_vacuum` as a TTL mechanism ([SQLite `auto_vacuum`](https://sqlite.org/pragma.html#pragma_auto_vacuum),
[SQLite serverless operation](https://www.sqlite.org/zeroconf.html)).

Attention design must say which visible state survives prompt/body expiry,
when an expired revision can no longer reopen, and how identity rebinding
affects a view. It consumes the stored metadata horizon; reads/ack must never
silently renew it. TMT-54's exact boundaries and bounded cleanup are not new
policy knobs for the attention adapter to reinterpret.

The implemented interpretation of the default duration is exactly 90 days,
using the existing global config file:

```json
{
  "exchange": {
    "retentionDays": 90
  }
}
```

This applies to newly prepared requests only. Older migrated records retain
seven days, without resurrecting expired or deleted bodies. Request content
uses preparation time; final content uses submission time; metadata protects
both plus settlement/acceptance obligations. A late final can therefore keep
metadata longer than 90 days from creation. Ack and reads do not renew
retention. The 180-second `talk` observer timeout and the unchanged reply
acceptance window remain separate lifetimes.

The following semantic scenarios are illustrative only, not final JSON schemas:

| Operation                                       | Observable semantic outcome                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `talk` succeeds and the final reply is accepted | Delivery/result succeeds, but the originator's X view remains unacknowledged until explicit ack.                                    |
| `talk` times out, then ack, then a late reply   | Timeout releases only the observer; ack covers the current revision; the late reply creates a newer revision and reopens attention. |
| `result` after the retention boundary           | The result is unavailable/expired, not pending; opportunistic cleanup may later remove eligible physical rows.                      |

Each implementation slice must carry observable verification: service and
repository tests for exact state/retention and failed-finalization behavior,
multi-process races for single ack and `ackall`, real Docker/mock-agent
scenarios for talk/reply/result correlation and late replies, and packed-skill
verification when any shipped command guidance changes. Reuse the existing
request worker harness and E2E fixture; do not add tests for unshipped commands
to the installed skill. Foundation/configuration work (TMT-46/TMT-29) is complete.
After attention delivery and verification, the remaining sequence is minimal
MCP, then memory. Offline queue/lease work remains a separate future track.
If pursued, an offline queue or lease is separate from X and is not an MCP
prerequisite.

TMT-24 implementation update: transport now prevents replay after an input
stage may have acted, preserves the same `!` protection on fallback, reports
`DELIVERY_UNCERTAIN`, and bounds argv-based capture. The current implementation
map below describes the research baseline; its broad resend fallback is no
longer present. At that baseline, request/response storage, instruction-boundary
extraction and structured final-body delivery remained unresolved. See ARCHITECTURE.md for the
maintained shipped transport boundary.

## Historical implementation map (research baseline, not current runtime)

TMT-25 implementation update: request/attempt bookkeeping and identity cadence
now share the existing SQLite connection through an application service.
Independent wait records use full server/pane-instance evidence, exact-attempt
cleanup, and short transactions outside tmux effects. Cadence uses reservations,
not an exact ordering of successful concurrent sends. Old JSON state is ignored
and preserved. The map and matrix below remain the historical research baseline;
see ARCHITECTURE.md for the maintained shipped state. Final-body
storage is implemented by TMT-36; TMT-38/39 now implement TMT-37's live durable
reply integration. The following marker/JSON-state descriptions are historical.

`cmdTalk` resolves one target, then either sends and returns (`talk` without
`--wait`) or creates a request ID, random nonce, and
`RESPONSE-END-<nonce>` marker. Wait mode stores `{id, nonce, pane,
startedAtMs}` in the shared JSON state file, sends through the tmux adapter, and
polls pane capture until it sees the nonce-specific marker and a debounce
period has elapsed.

The request ID is returned in completed and timeout JSON, but it is not carried
by a durable response record. Active state is keyed by pane and updated with
whole-file read/modify/write operations. Existing requests produce a warning;
the warning is not a lock. Cleanup is request-ID guarded, but concurrent
writers can overwrite state and a crashed process leaves only a TTL-cleaned
entry.

The current body extractor searches for the instruction and marker in terminal
scrollback. It expands capture when the instruction has scrolled away, then
falls back to the last configured lines and marks the result truncated. On a
timeout, `partialResponse` is taken from scrollback and may contain unrelated
history. Terminal capture therefore cannot establish full request/body
causality under concurrent same-pane waits.

Two baseline corrections are material:

1. `src/tmux.ts` has a broad send catch that retries the original message with
   legacy `send-keys` after buffer/paste/Enter failure. This is an existing
   transport fallback owned by TMT-24; it is not an authoritative response
   retry and must not be mistaken for one.
2. The generated instruction contains `RESPONSE-END-xxxx (where xxxx = N)`,
   while `isInstructionLine` looks for the literal `RESPONSE-END-N` in that
   line. The start boundary is therefore defective even before scrollback
   expansion. Fixing it is separate from choosing an authoritative response
   source.

The existing E2E harness is reusable: each scenario gets a private tmux server,
real CLI subprocesses, deterministic mock agents, JSONL request/response events
with pane PID and nonce, bounded polling, and cleanup. Existing talk tests use
temporary state directories and derive a mock response from the nonce in the
sent instruction. Neither suite currently proves two waiters competing for one
pane without response mixing.

## Capability matrix

| Capability           | Current behavior                                                                   | Proposed research boundary                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Request identity     | CLI request ID plus short nonce; nonce appears in the prompt and marker            | Keep an explicit request and attempt identity; do not make short nonce format the permanent protocol contract                       |
| Transport attempt    | Tmux buffer/paste/Enter with a legacy resend fallback                              | TMT-24 owns bounded transport, attempt outcome, and uncertain-send reporting; uncertain send must not be replayed automatically     |
| Authoritative body   | Scrollback marker extraction, including truncated/history fallback                 | A completed body must come from a request-correlated final source; terminal output is diagnostic evidence only                      |
| Terminal diagnostics | `capture` is used both for detection and body extraction                           | Preserve capture for progress/debugging, but keep it separate from the authoritative response body                                  |
| Persistence          | JSON state tracks one active request per pane; no durable response                 | TMT-25 should provide one short-transaction SQLite request/response service; no unbounded transaction around tmux                   |
| Wait lifecycle       | Timeout returns partial scrollback; cleanup is best effort and TTL-based           | Distinguish waiter timeout, cancellation, expiry, completed, and uncertain send; late replies must be fenced                        |
| Provider output      | No provider adapter; marker protocol is injected into pane input                   | Thin future adapters may map final outputs into the same response contract; the first slice can use explicit cooperating submission |
| Roles/preambles      | Legacy preambles can modify sent text; durable roles are separate and not injected | Do not use roles or preambles as request identity, transport state, or response storage                                             |
| Inbox/headless       | No daemon, durable inbox, or owned headless runner                                 | Defer broad inbox (TMT-16/31/32), advanced identity management (TMT-30), memory (TMT-15), and provider runner rollout               |

## Alternatives and supported limits

| Candidate                             | Full-body source and cooperation                                         | Correlation and cost                                                                                                   | Recommendation                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Unmodified interactive pane           | Only rendered screen/history; hidden semantic text is unavailable        | Marker heuristic, no authoritative body ownership                                                                      | Keep existing behavior explicit as best effort; do not silently upgrade its guarantee                               |
| Explicit cooperating final submission | Agent/tool submits its complete final text outside the terminal renderer | Explicit request/attempt plus recipient validation; one shared repository, no listener                                 | First bounded live-channel candidate; agent cooperation is required                                                 |
| Provider final-response hook          | Supported hook supplies final text independently of the viewport         | Must bind the actual provider turn to a TMT attempt; unrelated turns and hook retries must be rejected or deduplicated | Optional thin adapter after core contract; no automatic configuration installation                                  |
| Owned headless process                | Structured output/final file from a process whose lifecycle TMT owns     | Stronger run association but requires a runner and provider-specific decoding                                          | Useful later; cannot transparently attach arbitrary existing interactive panes                                      |
| Raw PTY/pipe output                   | Bytes emitted while recording is active                                  | Requires lifecycle ownership and parsing redraws; cannot recover semantic text never emitted                           | Diagnostics, not the universal response channel                                                                     |
| Local response artifact or IPC        | Artifact can carry a full response; IPC can deliver an envelope          | Artifact needs bounded validation, publication and ingestion; a listener adds lifecycle complexity                     | A file may be an input adapter, not another authoritative store; no daemon needed for short-lived SQLite submission |

These are architectural inferences from the source capabilities below, not
claims of verified provider integration. A completion event alone never proves
body completeness. Session ID, pane identity, a display name, or an idle screen
alone cannot associate a response with a particular request.

## Staged architecture option

The smallest coherent path is one local SQLite request/response service behind a
narrow application port. A request has an explicit immutable request ID; each
send has an explicit attempt ID and is fenced to that request and recorded
recipient/endpoint instance (not a `%pane` alone).
Fencing must use the recorded request/attempt identity, never “the latest
request for this pane.” A final submission with the same request and identical
content is idempotent; a conflicting final submission for the same request is
rejected and diagnosed.

The minimum final body is one bounded UTF-8 text submission, committed together
with its completion state. Its exact size cap and rejection/output schemas must
be set before implementation; oversize, invalid input or partial writes must not
produce a completed record. Avoid streaming/chunk assembly until an actual
consumer requires it. Later chunk adapters must prove ordering, completeness
and terminal outcome before calling the same finalization operation.

Use the existing database path/lifecycle and parser. A narrow response service
owns validation and transitions; commands and provider adapters do not implement
their own SQL or state machines. Correlation/attempt fencing is not strong
authentication against other processes running as the same local user. Do not
log reusable submission tokens or ingest arbitrary transcript paths by default.

Transactions should record or finalize state briefly, then release the lock
before tmux/provider subprocess work. A waiter timeout is local observation
expiry, not cancellation of a provider attempt. Cancellation and expiry need
distinct states and fencing rules. If the send result is uncertain, the caller
records uncertainty and does not replay the prompt automatically. An accepted
late reply remains retrievable after its original waiter exits. A later explicit
retry requires a specified attempt policy; request idempotency does not promise
exactly-once execution of agent tools. Retention must be explicit and bounded,
not a copy of the current one-hour active-state cleanup.

Suggested delivery order:

1. TMT-24: preserve `!` shell-mode protection, eliminate unsafe replay and bound
   transport stages with sent/failed/uncertain outcomes.
2. TMT-27/28: retain preambles through the specified identity-owned model and
   establish narrow shared resource/repository ports. Sequence only prerequisites
   needed by the next slice; TMT-26 owns broad CLI error unification.
3. TMT-25: replace JSON bookkeeping with short-transaction SQLite request
   ownership. Do not add a second store when final responses are introduced.
4. [TMT-36](https://linear.app/tigerpig-dev/issue/TMT-36) owns immutable final
   responses in the shared service;
   [TMT-37](https://linear.app/tigerpig-dev/issue/TMT-37) owns default durable live CLI
   completion, timeout/detach, exact-body retrieval and shipped skill guidance. These are
   bounded children of TMT-31/32, not the broader inbox/offline-routing rollout.
   Their preparation gates require exact types, limits and CLI contracts before
   implementation. Prove timeout/late replies and fencing before expanding modes.
5. Broad inbox, non-tmux identity management (TMT-30), memory (TMT-15), and owned
   headless runners remain later work; memory is not a prerequisite of replies.

No stage requires a daemon. No stage authorizes automatic resend, provider
parallel state, or a new CLI spelling.

## Source capability notes

Source verification date: 2026-09-05. These are capability findings only; no
provider integration test was run.

- [OpenAI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): JSON exposes an `agent_message` item and turn outcome, with `-o` support for a final file. This is a non-interactive result surface, not an instruction to attach an existing TUI.
- [Claude headless mode](https://code.claude.com/docs/en/headless): Claude can return result JSON suitable for a final-response adapter. The adapter still needs request/attempt ownership outside the provider process.
- [Claude hooks](https://code.claude.com/docs/en/hooks): the Stop hook exposes `last_assistant_message`; transcript persistence is not guaranteed to have flushed, and continuation hooks require care to avoid loops or duplicate work.
- [Gemini hooks reference](https://geminicli.com/docs/hooks/reference/): `AfterAgent` provides the prompt response and original prompt. Hook retry behavior must not be treated as an idempotent TMT submission without request fencing.
- [Gemini headless CLI](https://geminicli.com/docs/cli/headless/): headless operation can provide response JSON or message chunks plus a result. TMT should consume a bounded final result, not invent a second chunk protocol.
- [tmux manual](https://raw.githubusercontent.com/tmux/tmux/master/tmux.1): capture reads pane screen/history, while pipe-pane receives program output. A pane supports one pipe command at a time. Neither supplies semantic request ownership; neither can recover text never rendered or emitted. Correlation alone also cannot restore missing text.

## Historical user-observable contract: research baseline versus proposal

At the research baseline, behavior was observable as `status: sent` for non-wait sends,
`status: completed` with `requestId`, `nonce`, `endMarker`, and `response` for
marker-detected waits, and `status: timeout` with optional `partialResponse`.
Human output also prints a response extracted from the pane.

Proposed behavior is intentionally a contract direction, not a schema change:
`completed` would mean a correlated final body was durably accepted; terminal
diagnostics would not be presented as that body. Timeout, cancellation, expiry,
and uncertain send would remain distinguishable from completion, and a late or
conflicting final submission would not complete a newer request. Exact JSON
fields, status names, and limits must be specified in the implementation issue;
this document does not commit to them.

## Verification matrix

### Historical research diagnostic, now replaced by full-body acceptance

Before TMT-39, `test/e2e/response-integrity.e2e.test.ts` exercised the real CLI against the
existing private-server fixture in `virtualized` mock mode. The mock constructs
a full 202-line plain-text body, renders only its last three lines and the
completion marker, then records the full body in its causal event. The scenario
checks exact event text, matching nonce/PID, visible tail, completed/truncated
output, and the missing interior in both 100-line and 2,000-line captures.

A passing diagnostic proves a limitation of the current terminal source, not
reliability of a replacement. The event log is a test oracle, not a production
response store. This synthetic case is not a diagnosis of a particular provider.
TMT-37 must use exact returned/retrieved body equality against this oracle and
durable request/attempt association; it cannot reuse the missing-body assertion
as its success criterion. The reproduction does not depend on the separate
instruction-boundary bug: enlarging or correcting extraction cannot recover an
interior that the mock never emitted.

### Implementation acceptance

Implementation work should add deterministic tests for:

- exact text, Unicode, multiline content, and empty bodies;
- redraws, scrollback/history, marker-like user text, and the current
  placeholder/nonce boundary;
- two concurrent requests to one pane, plus independent requests to different
  panes;
- identical duplicate final submissions and conflicting final submissions;
- late replies after waiter timeout, cancellation, expiry, and process restart;
- request/attempt fencing so a stale writer cannot clear or complete a newer
  request;
- tmux paste/Enter failure, legacy transport fallback, and uncertain-send
  handling without automatic replay;
- durable state preservation after failed finalization and cleanup after
  success, timeout, cancellation, and thrown errors.

The E2E cases now assert JSON fields plus causal mock-agent events keyed by
request ID and PID, not terminal echo alone. Use barriers and bounded polling rather
than fixed sleeps, and run the Docker suite twice when lifecycle/cleanup code
changes. Provider-source adapters should use recorded fixtures and remain
network-free; no actual provider integration result is claimed here.
