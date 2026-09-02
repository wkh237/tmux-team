---
name: tmux-team
description: Communicate with other AI agents in tmux panes. Use when you need to talk to codex, claude, gemini, or other agents.
---

When invoked, execute the `tmt` (short for `tmux-team`) command with the provided arguments.

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

Registrations live in tmux pane metadata: current workspace by default, or an
explicit cross-folder team with `--team <name>`.

## Commands

```bash
# Send message to an agent
tmt talk codex "your message"
tmt talk gemini "your message"
tmt talk all "broadcast message"

# Send with delay (useful for rate limiting)
tmt talk codex "message" --delay 5

# Send and wait for response (blocks until agent replies)
tmt talk codex "message" --wait --timeout 120

# Read agent response (default: 100 lines)
tmt check codex
tmt check gemini 200

# List all configured agents
tmt list
tmt name backend                 # bind the current pane globally
tmt this reviewer                # exact alias for `name`
tmt add %12 backend              # bind an explicit pane by stable pane ID
tmt whoami
tmt unbind
tmt team panes
```

Global identities are independent of the current folder. Names may be
undeclared; they do not need a configured role. `tmt add` resolves `%pane_id`,
`window.pane`, or `session:window.pane` targets before storing the stable pane
ID. Pane-title updates are best-effort presentation side effects only; there is
no panel-title command or daemon.

## Workflow

1. Send and wait: `tmt talk codex "Review this code" --wait`
2. If the request times out, read the pane later with `tmt check codex`.
3. If the response is cut off, increase the capture with `tmt check codex 200`.

## Notes

- `talk` sends via tmux buffer paste, then waits briefly before Enter; multiline
  messages preserve their line breaks.
- Control the delay with `pasteEnterDelayMs` in config (default: 500)
- Use `--delay` instead of sleep (safer for tool whitelists)
- Use `--wait` for synchronous request-response patterns; use `check` after a
  timeout or when polling.
- Sending text or commands to another pane is an external action. Do it only
  with user authorization; do not send secrets or unrelated commands.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.
