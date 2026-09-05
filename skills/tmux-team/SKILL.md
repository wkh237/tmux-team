---
name: tmux-team
description: Communicate with other AI agents in tmux panes through the tmt CLI.
---

# tmux-team

Use `tmt` (the short alias for `tmux-team`) when the user asks you to communicate with another agent in a tmux pane.

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

`--wait` still extracts a best-effort terminal response. A completion marker
can coexist with cropped content; increasing `check` lines cannot recover text
that the agent never rendered. No durable structured response channel is
implied by this transport safety behavior.

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
retrying is safe. SQLite bookkeeping does not fix terminal response truncation.

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
tmt list
tmt name <global-name>               # bind the current pane globally
tmt this <global-name>               # exact supported alias for `name`
tmt add <pane-target> <global-name>  # bind an explicit pane by stable `%pane_id`
tmt whoami                            # show the current pane identity
tmt unbind                            # remove the current pane identity
tmt talk <target> "message"          # target a global name or pane
tmt check <target> [lines]
tmt list [target]                     # list identities or one pane
tmt install [claude|codex|gemini|all]
tmt upgrade
```

`name`, `this`, and `add` manage one global identity per pane. Names can be
undeclared identities; they do not need to match a configured role. `add`
accepts `%pane_id`, `window.pane`, or `session:window.pane` and stores the
resolved stable `%pane_id`. There is no daemon. A pane title update is only a
best-effort side effect and is not a separate command or API.

Global identities are independent of the current working directory. `talk`,
`check`, and `list` accept either a global name or a direct pane target. The
name `all` is an ordinary identity; it is not a special destination. The
current `add` order is `tmt add <pane-target> <global-name>`; the older
name-first order is rejected with a usage error.

Names are unique across servers sharing the same local TMT database, but
`list`, `talk`, and `check` discover and address only the current tmux server.
A `%pane_id` is stable within a server, not unique across servers. Routine
reads preserve bindings on other sockets. Binding a foreign live name fails
with `NAME_ALREADY_ACTIVE` (exit 5); an unverifiable foreign endpoint fails
with `RECONCILIATION_FAILED` (exit 1). Do not delete the binding to bypass an
uncertain check. Rebinding a proven stale endpoint retains its identity and
profile; no cross-server routing or daemon is provided.

Earlier name-only v5 pane markers are not automatically imported into durable
identities. Use `name`, `this`, or `add` explicitly to bind such a pane. Invalid
metadata is not active presence; do not delete durable data or old files to
repair it. Direct pane targeting remains separate from identity discovery.

V5 does not support `update`, `remove`/`rm`, or `migrate`. Use explicit binding
commands above; `unbind` only detaches the current pane and retains its durable
identity/profile. Do not delete old user files as a migration workaround.

`talk` sends text to another pane and can cause external input there. Only use
it when the user has requested that communication or the surrounding task
clearly authorizes it; do not infer permission for unrelated changes. Use
`--wait` to wait for a response, `--timeout <seconds>` to bound the wait, and
`--delay <seconds>` to delay sending.

Install integrations with `tmt install` (auto-detects supported agents) or `tmt install all --force` to refresh managed links. Upgrade the CLI with `tmt upgrade`; managed links automatically use the updated bundled skill. Run install when an integration is missing or has drifted.
