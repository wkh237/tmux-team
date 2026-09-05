---
name: tmux-team
description: Communicate with other AI agents in tmux panes through the tmt CLI.
---

# tmux-team

Use `tmt` (the short alias for `tmux-team`) when the user asks you to communicate with another agent in a tmux pane.

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
