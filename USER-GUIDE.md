# tmux-team user guide

This guide covers the common v5 preview workflows. Start with the
[README](README.md) for the tested preview installation, then use
[`skills/README.md`](skills/README.md) for provider-specific installation and
[`skills/tmux-team/SKILL.md`](skills/tmux-team/SKILL.md) for canonical agent
guidance.

## Install and load the skill

Use the pinned preview commands in the [README installation section](README.md#v5-preview-installation),
then let TMT detect the supported agents with `tmt install`.

The preview requires macOS or Linux, tmux, and Node.js `>=22.12`; Node 24 LTS
is preferred. This archive path needs neither Git nor pnpm. Do not use
`tmt upgrade` with this preview: it follows npm `latest` rather than the v5
archive. Re-run the pinned install when you need to refresh this revision.

After installation, load or reload the `tmux-team` skill in every agent that
will send or receive TMT work. Installation places the provider integration;
it does not reload an already running agent session.

## Name panes and inspect presence

Give each live agent pane a global name from that pane's shell, before
launching the agent:

```bash
tmt name reviewer
# Or bind another pane from a shell that can address it:
tmt add %12 gemini
```

Use these commands to inspect the current tmux server:

```bash
tmt list
tmt list reviewer
tmt whoami
```

`name` and `whoami` need a live caller pane. `add` accepts `%pane_id`,
`window.pane`, or `session:window.pane`; the current order is pane target first,
global name second. `tmt unbind` removes only the current pane's binding and
keeps the durable identity record.

Global names are independent of the working directory. A durable identity can
exist without an active pane:

```bash
tmt identity create coordinator --json
tmt identity show coordinator --json
tmt identity list --json
```

Creation is idempotent for a canonical-equivalent name. It does not bind a
pane, authenticate a caller, or create an offline receiving queue.

## Talk and receive a complete reply

Send a request by global name or direct pane target:

```bash
tmt talk reviewer "Review this patch and report concrete risks."
tmt talk %12 "Run the focused checks." --timeout 300
```

The receiver must have the skill loaded. TMT gives it a request ID and receipt
inside the delivered instructions; the receiver submits one complete final
reply with that receipt. `talk` waits for the durable final by default.

For work that should continue after the caller returns:

```bash
tmt talk reviewer "Run the agreed checks." --detach --json
tmt result <request-id> --json
```

Use exactly the request ID and receipt supplied by TMT. Do not invent a receipt,
select the latest request, or infer a pane. A successful submission means a
body was stored; it does not prove that the requested work succeeded.

Agents can submit a final explicitly when TMT supplies the receipt:

```bash
tmt reply <request-id> --receipt <receipt> --message 'Review complete.'
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
```

Choose exactly one input source. Identical retries are safe while the body is
retained; a different body conflicts and cannot replace the stored final.

## Attribute and recover requests

When the caller is not in a verified bound pane, select an existing durable
identity explicitly. The option belongs after `talk`:

```bash
tmt talk reviewer "Review the release notes." --identity coordinator --detach --json
```

This is local attribution, not authentication. The recipient still needs a
live bound pane. To recover requests after timeout, detach, process restart, or
pane loss:

```bash
tmt x --identity coordinator --json
tmt x show <request-id> --identity coordinator --json
tmt x ack <request-id> --revision <revision> --identity coordinator --json
tmt x ackall --identity coordinator --json
```

Bare `x` means `x list`: it returns unacknowledged retained metadata. `x show`
reads the retained original prompt and final when available. `ack` requires the
revision observed by list/show; `ackall` acknowledges the current transaction
snapshot without enumerating or claiming that every body was read. Reads and
acknowledgements do not cancel work or renew retention.

## Roles and preambles

An optional role profile is stored with an identity and is not automatically
injected into messages:

```bash
tmt role set "Review correctness before style." --identity reviewer
tmt role show --identity reviewer
tmt role clear --identity reviewer
```

Preambles are separate and are included in messages for the selected identity:

```bash
tmt preamble set reviewer "Be concise and cite concrete evidence."
tmt preamble show reviewer
tmt preamble clear reviewer
```

Use `role` for durable profile data and `preamble` for message context. Both
survive pane loss and rebinding. Explicit names work outside tmux; unknown names
are not created implicitly.

## Important delivery behavior

TMT is CLI-only. Each command exits after its operation; there is no daemon,
listener, remote service, MCP transport, or offline recipient inbox. Active
routing is limited to live panes on the current tmux server. Durable identities
and retained request/reply bodies stay in local SQLite.

Line breaks are preserved. ASCII `!` is converted to fullwidth `！` to protect
coding-agent shell/bash shortcuts, so code such as `if (!ready)` is not delivered
byte-for-byte. If tmux input may have reached the pane and TMT reports
`DELIVERY_UNCERTAIN`, inspect the pane before deciding whether to retry; a
timeout or missing visible output is not proof that nothing ran.

For command grammar and edge cases, use `tmt help`. For the complete durable
request/response contract, see
[`REQUEST-RESPONSE.md`](REQUEST-RESPONSE.md). For provider-specific skill
installation, custom skill roots, and retiring an older Claude integration, see
[`skills/README.md`](skills/README.md).

## Configuration and troubleshooting

Inspect resolved settings before changing them:

```bash
tmt config show --json
tmt config set pasteEnterDelayMs 500
tmt config set preambleEvery 3
tmt config set exchange.retentionDays 90 --global
```

If npm reports a permissions error, use a user-owned Node installation or
version manager and avoid adding `sudo` blindly. If `tmt` is not found after
installation, check the npm global prefix and that its `bin` directory is on
`PATH`. If an integration path conflicts with unmanaged files, inspect the
target first; `tmt install <provider> --force` creates a recoverable backup
outside the skills root and reports its path.
After changing skills or provider setup, reload or restart the agent session.
