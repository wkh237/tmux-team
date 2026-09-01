---
name: tmux-team
description: Communicate with other AI agents in tmux panes through the tmt CLI.
---

# tmux-team

Use `tmt` (the short alias for `tmux-team`) when the user asks you to communicate with another agent in a tmux pane.

## Commands

```bash
tmt list
tmt name <pane-name> [pane]          # label a pane
tmt this <agent-name> [remark]       # register the current pane
tmt add <agent-name> <pane> [remark]
tmt talk <agent> "message"           # `all` broadcasts
tmt check <agent> [lines]
tmt team add <team> <agent> [pane]
tmt team panes
tmt install [claude|codex|gemini|all]
tmt upgrade
```

`talk` sends text to another pane and can cause external input there. Only use it when the user has requested that communication or the surrounding task clearly authorizes it; do not infer permission for unrelated changes. Use `--wait` to wait for a response, `--timeout <seconds>` to bound the wait, and `--delay <seconds>` to delay sending.

Install integrations with `tmt install` (auto-detects supported agents) or `tmt install all --force` to refresh managed links. Upgrade the CLI with `tmt upgrade`; managed links automatically use the updated bundled skill. Run install when an integration is missing or has drifted.
