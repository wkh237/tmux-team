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

`--wait` still extracts a best-effort terminal response. A completion marker
can coexist with cropped content; increasing `check` lines cannot recover text
that the agent never rendered. No durable structured response channel is
implied by this transport safety behavior.

## Commands

`name`, `this`, `whoami` and `unbind` require matching live `TMUX` and
`TMUX_PANE` caller context. Missing, malformed or stale context returns
`PANE_NOT_FOUND` (exit 3), not the default pane's identity. Implicit `role`
access returns `IDENTITY_REQUIRED` (exit 1). Do not fabricate caller variables:
outside tmux, use explicit `add <pane-target> <global-name>`, `talk <target>`,
`check <target>`, or `role show|set|clear --identity <name>`. Explicit selection
does not bind or authenticate the caller.

```bash
# Send and wait for response (recommended)
tmt talk codex "your message" --wait
tmt talk gemini "your message" --wait --timeout 120

# Send to an identity or direct pane target
tmt talk codex "message" --wait
tmt talk %12 "message" --wait

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

The `--wait` flag blocks until the agent responds, returning the response directly:

```bash
tmux-team talk codex "Review this authentication code" --wait
# Response is returned directly - no need for a separate check command
```

## Tips

- Use `--wait` when the user needs a response before continuing; use `check`
  after a timeout or for polling.
- `tmt name` binds a global identity; `tmt this` is its exact supported alias.
  `tmt whoami` inspects the current binding and `tmt unbind` removes it.
- `tmt talk`, `tmt check`, and `tmt list` accept either a global name or a
  direct pane target. The name `all` is an ordinary identity, not a special
  destination.
- `tmt add` uses `<pane-target> <global-name>`. The legacy name-first order is
  rejected with a usage error.
- tmux-team is CLI-only and has no daemon or background service. Pane metadata
  is authoritative; pane titles are best-effort presentation only.
- Preserve multiline text. Sending input to another pane is an external action
  and requires user authorization; do not infer permission to send commands.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.
