---
name: tmux-team
description: Communicate with other AI agents in tmux panes through the tmt CLI.
---

# tmux-team

Use `tmt` (the short alias for `tmux-team`) when the user asks you to communicate with another agent in a tmux pane.

## Commands

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

`talk` sends text to another pane and can cause external input there. Only use
it when the user has requested that communication or the surrounding task
clearly authorizes it; do not infer permission for unrelated changes. Use
`--wait` to wait for a response, `--timeout <seconds>` to bound the wait, and
`--delay <seconds>` to delay sending.

Install integrations with `tmt install` (auto-detects supported agents) or `tmt install all --force` to refresh managed links. Upgrade the CLI with `tmt upgrade`; managed links automatically use the updated bundled skill. Run install when an integration is missing or has drifted.
