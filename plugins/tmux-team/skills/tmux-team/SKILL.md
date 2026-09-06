---
name: tmux-team
description: Coordinate with other AI agents running in tmux panes. Use this skill when you need to delegate tasks, request reviews, or collaborate with agents like Codex, Gemini, or other Claude instances.
---

# Multi-Agent Coordination with tmux-team

You are working in a multi-agent tmux environment. Use the `tmux-team` CLI to communicate with other AI agents running in different panes.

## When to Use This Skill

- Delegating specialized tasks to other agents (e.g., "Ask Codex to review this code")
- Sending messages to a named identity or pane target
- Checking responses from agents you've messaged
- Coordinating parallel work across multiple agents

## Delivery safety

`talk` converts ASCII `!` to fullwidth `！` on both normal and fallback input
paths to protect coding-agent shell/bash-mode shortcuts. Line breaks are
preserved, but text such as `if (!ready)` is not delivered byte-for-byte. Do not
assume bracketed paste or an agent's identity name makes literal `!` safe.

`DELIVERY_UNCERTAIN` (exit 1) means input or Enter may already have reached the
pane. JSON includes the failed `stage`. Do not automatically resend: inspect
with `tmt check <target>` and establish whether work started before deciding
what to do next. Missing visible output is not proof that nothing executed.
Successful submission also does not guarantee exactly-once agent processing.

`talk` waits for the complete durable reply by default. It never treats terminal
markers, idle output, a summary, or process exit as completion. A cooperating
recipient must invoke `tmt reply`; otherwise there is no final result yet.
`check` is only a diagnostic snapshot, not correlated result retrieval.

## JSON results and failures

With `--json`, parse the entire stdout as one JSON document. Errors contain
`error.code` and `error.message`; stderr is reserved for optional diagnostics.
Check the exit status too: missing targets use 3, timeout 4, and conflicts 5.
Successful commands without a detailed result return `{ok:true}`.

Timeout returns `status: "timeout"`, `requestId`, target/pane correlation and
`error: {code: "TIMEOUT", message: "..."}` (exit 4). There is no partial response,
nonce, end marker or truncation flag. Use `tmt result <request-id> --json` later.
Timeout and interruption end only the observer, never recipient work. A
`CLEANUP_ERROR` does not undo effects; preserve the request ID and inspect before
retrying. Missing visible output is not permission to resend.

`help`, `version`, `completion` and `learn` are text-only and reject
`--json` with `JSON_UNSUPPORTED`; run them without that flag. `upgrade`
also rejects JSON mode because it streams installer output.

## Durable replies and results

When TMT supplies an exact receipt, submit the complete result through the
storage-only adapters:

```bash
tmt reply <request-id> --receipt <receipt> --message 'Review complete.'
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
tmt result <request-id> --json
```

Use `--message` for short replies, including an explicit empty string. Quote
the body for your shell; use `--message='-leading text'` for a leading hyphen.
Choose exactly one of `--message`, `--file`, or `--stdin`. Inline arguments
have operating-system size limits and cannot contain NUL; use file/stdin for
large bodies or NUL-containing text. All sources share the same exact-body
validation and immutable submission rules.

Received instructions group the reply command in `<tmt-reply>` tags, with the
request ID and receipt supplied once. These tags do not guarantee hidden UI
rendering and are not terminal-output completion markers. Replace the message
placeholder with your complete response, or use file/stdin with the same
request ID and receipt.

Use exactly one input source and the exact request ID/receipt supplied in the
received `talk` instruction, including detached requests. Never manufacture a
receipt, select the latest request, or infer a current pane. Both `reply` and
`result` are storage-only and work without a live pane on this same local
TMT database; this is not an inbox, listener, remote transport or authentication.

Reply input is one exact valid UTF-8 body up to 1 MiB, preserving empty,
whitespace, BOM, NUL, CR/LF, Unicode, and marker-like text. Stdin is
EOF-driven with a five-second input deadline. Successful submission means the
result was delivered, not that the task succeeded; show a brief truthful
summary only after submission, never as completion evidence.

An identical retry for the same request and attempt keeps the original
`submittedAtMs`; a different body is a conflict and cannot replace the stored
response.

The receipt is local correlation, not remote authentication. Accepted bodies
are retained for seven days from submission; an identical retry is safe only
while that body is retained and with the same receipt and body, not
indefinitely. A missing result does not cancel the work. Surface a failed
submission without a success summary; if final summarization fails after
acceptance, do not resubmit.

With `--json`, reply success is `{status:"submitted",requestId,bodyBytes,submittedAtMs}`
and result success is `{status:"completed",requestId,response,bodyBytes,submittedAtMs}`.
Unavailable JSON is
`{status:"unavailable",requestId,error:{code:"RESPONSE_NOT_AVAILABLE",message}}`.
`result` reports `RESPONSE_NOT_AVAILABLE` (exit 3) for pending, unknown, or
expired bodies. Input errors exit 1, input timeout is `RESPONSE_INPUT_TIMEOUT`
(exit 4), and conflicts exit 5. Receipts, endpoints, and raw bodies are not
echoed in acknowledgements.

## Calling an agent

`tmt talk <target> "message" [--timeout <time> | --detach] [--json]` waits for
one durable final by default. The default is 180 seconds unless
`defaults.timeout` is configured. Time accepts positive seconds or `ms`/`s`
suffixes, at most 24 hours. Do not combine explicit timeout with detach.
Pre-send delay accepts zero or a positive finite value, up to 2,147,483,647 ms.
`--wait` is retired and rejected; `--lines` applies to check, not talk.
Stored wait/polling mode settings are inert; `config clear mode` removes
only the explicit local obsolete key, without migrating other settings.

```bash
tmt talk reviewer "Review this patch" --timeout 300 --json
tmt talk reviewer "Run the agreed tests" --detach --json
tmt result <request-id> --json
tmt check reviewer 200  # diagnostics only
```

Detached success is `{status:"sent",requestId,target,pane,identity?}`, not task
completion. Completed talk adds the exact `response`, `bodyBytes` and
`submittedAtMs` to request/target/pane correlation. Preserve that request ID.

The observer clock starts immediately before send, after pre-send delay and
preparation. Transport/Enter time counts; synchronous transport cannot be
cancelled mid-operation. A response read at or crossing the deadline is not
accepted by that observer; it may still be retrieved with result afterward.
Do not resend simply because a caller timed out or was interrupted.

## Identity preambles

Preambles are separate from role profiles and belong to existing durable global
identities. These commands work without tmux, even when the identity is unbound:

```bash
tmt preamble show                    # list stored preambles
tmt preamble show reviewer
tmt preamble set reviewer "Review correctness before style."
tmt preamble clear reviewer
```

Names are explicit; omitting the name lists preambles, not the caller's data.
Unknown identities fail with `NAME_NOT_FOUND`; bind the intended identity
explicitly rather than treating a pane ID or an old registration as its name.
Use `clear`, not blank `set`. Content is limited to 65,536 UTF-8 bytes.

`talk` uses the resolved identity's preamble for both names and bound pane
targets; unnamed panes get none. Role text is never injected automatically.
`--no-preamble`, disabled `preambleMode`, or `preambleEvery 0` skips injection.
Frequency N uses transactional SQLite reservations at effective counts 1, 1+N,
... for each identity. Sent, uncertain, and pending attempts consume a slot;
proven unsent attempts refund only future decisions. Overlapping failures can
therefore differ from exact successful-send spacing; already prepared messages
never change. The SQLite cadence starts fresh; old JSON state is ignored and
left untouched.

Concurrent waits retain separate request records and remain advisory, not a
single-flight lock. Timeout or interruption ends only that waiter; it does not
cancel the recipient or undo sent cadence. `REQUEST_STATE_ERROR` (exit 1) can
occur after possible delivery: follow its inspection guidance, never infer that
retrying is safe. Replies are correlated independently, but same-pane input
serialization and exactly-once agent processing are not guaranteed.

Old JSON/workspace-metadata preambles are ignored, not migrated or deleted.
Reapply intended text explicitly with `preamble set`. Preamble changes persist
across folders, unbind and pane/server restart; clearing one does not clear its
identity or role.

## Committed identity retention

Once identity creation commits, a later binding failure does not delete the
identity. A valid new name tried on an occupied pane can therefore return
`PANE_ALREADY_BOUND` (exit 5) while leaving that name unbound in SQLite.
It is not an active `list`/`talk` destination, but explicit `role --identity`
and `preamble` commands can access it. A later successful bind reuses its UUID
and profiles. Invalid names and missing preflight panes create no identity.
Do not treat a failed bind as permission to delete data or try unrelated names.

## Commands

`name`, `this`, `whoami` and `unbind` require matching live `TMUX` and
`TMUX_PANE` caller context. Missing, malformed or stale context returns
`PANE_NOT_FOUND` (exit 3), not the default pane's identity. Implicit `role`
access returns `IDENTITY_REQUIRED` (exit 1). Do not fabricate caller variables:
outside tmux, use explicit `add <pane-target> <global-name>`, `talk <target>`,
`check <target>`, or `role show|set|clear --identity <name>`. Explicit selection
does not bind or authenticate the caller.

```bash
# Send and wait for the durable final response
tmt talk codex "your message"
tmt talk gemini "your message" --timeout 120

# Send to an identity or direct pane target
tmt talk codex "message"
tmt talk %12 "message"

# List active identities, or inspect one pane
tmt list
tmt list %12
tmt name backend                 # bind the current pane globally
tmt this reviewer                # exact alias for `name`
tmt add %12 backend              # bind an explicit pane by stable pane ID
tmt whoami
tmt unbind
```

## Workflow

Talk waits until the agent submits its complete final response:

```bash
tmux-team talk codex "Review this authentication code" --json
# On timeout, preserve the request ID and retrieve it with tmt result later.
```

## Tips

- Wait by default or use `--detach`; use `result` after a timeout and `check`
  only for diagnostics.
- `tmt name` binds a global identity; `tmt this` is its exact supported alias.
  `tmt whoami` inspects the current binding and `tmt unbind` removes it.
- `tmt talk`, `tmt check`, and `tmt list` accept either a global name or a
  direct pane target. The name `all` is an ordinary identity, not a special
  destination.
- `tmt add` uses `<pane-target> <global-name>`. The legacy name-first order is
  rejected with a usage error.
- tmux-team is CLI-only and has no daemon or background service. SQLite owns
  durable identities and preambles; active bindings must agree with live tmux
  evidence and metadata. Pane titles are best-effort presentation only.
- Preserve multiline text. Sending input to another pane is an external action
  and requires user authorization; do not infer permission to send commands.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.

## View and install the bundled skill

`tmt learn --skill` prints the exact bundled universal skill; plain `tmt learn`
shows the guide. Both are text-only. Install default integrations with
`tmt install [claude|codex|gemini|all]`, or choose a skills root explicitly:

```bash
tmt install --dir ./my-skills
```

This links `./my-skills/tmux-team`; do not also specify a provider. Choose a
folder your provider actually discovers and reload its skills if needed.
Managed links follow bundled updates at the same package path. Re-run the same
install command to inspect/repair the target after relocation; existing
unmanaged content is preserved unless `--force` requests a recoverable backup.
Automatic drift reminders inspect known default paths, not custom folders.
They do not reload an active agent, update provider-managed plugins, or track
alpha release channels. Package upgrades and skill installation are separate
from provider discovery.
