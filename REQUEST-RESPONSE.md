# TMT-35 request/response channel research

Status: historical research based on `cecaec7` (2026-09-05), with the accepted
direction and TMT-36 service contract maintained below. The shared final-response
service is implemented; live CLI integration is still TMT-37 work. No provider
integration, daemon, inbox, memory feature, or new CLI syntax is supplied here.

## Accepted direction (2026-09-05; CLI integration not yet shipped)

The [accepted design](https://linear.app/tigerpig-dev/document/accepted-design-durable-replies-automatic-completion-and-human-21745047ee15)
supersedes the earlier opt-in proposal below. TMT-36 adds immutable full replies
to the existing request service; TMT-37 changes the CLI to wait for a durable
reply by default, with bounded `--timeout` and explicit `--detach`, retiring
`--wait` and the polling/wait mode switch. These are proposals, not installed
commands. Terminal capture and `check` remain diagnostics, never authoritative
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
Final bodies have independent seven-day retention after submission; expired bodies
are hidden by reads and deleted by opportunistic cleanup. This is not a scheduled
physical-deletion SLA. Retained retries remain idempotent past submission expiry.

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
CLI command is introduced by this service contract.

TMT-24 implementation update: transport now prevents replay after an input
stage may have acted, preserves the same `!` protection on fallback, reports
`DELIVERY_UNCERTAIN`, and bounds argv-based capture. The current implementation
map below describes the research baseline; its broad resend fallback is no
longer present. At that baseline, request/response storage, instruction-boundary
extraction and structured final-body delivery remained unresolved. See ARCHITECTURE.md for the
maintained shipped transport boundary.

## Current implementation map

TMT-25 implementation update: request/attempt bookkeeping and identity cadence
now share the existing SQLite connection through an application service.
Independent wait records use full server/pane-instance evidence, exact-attempt
cleanup, and short transactions outside tmux effects. Cadence uses reservations,
not an exact ordering of successful concurrent sends. Old JSON state is ignored
and preserved. The map and matrix below remain the historical research baseline;
see ARCHITECTURE.md for the maintained shipped state. Final-body
storage is implemented by TMT-36; TMT-37 live structured reply integration is
still not shipped.

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

## User-observable contract: current versus proposal

Current behavior is observable as `status: sent` for non-wait sends,
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

### Research diagnostic, not a delivered channel

`test/e2e/response-integrity.e2e.test.ts` exercises the real CLI against the
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

The E2E cases should assert JSON fields plus causal mock-agent events keyed by
nonce and PID, not terminal echo alone. Use barriers and bounded polling rather
than fixed sleeps, and run the Docker suite twice when lifecycle/cleanup code
changes. Provider-source adapters should use recorded fixtures and remain
network-free; no actual provider integration result is claimed here.
