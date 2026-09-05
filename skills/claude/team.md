---
allowed-tools: Bash(tmt:*), Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

Execute this command: `tmt $ARGUMENTS` (`tmt` is the short alias for `tmux-team`).

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

Identities are durable SQLite records, independent of the working directory.
Active presence also requires matching live tmux binding metadata.

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
Frequency N applies on eligible attempts 1, 1+N, ...; counters are still
best-effort JSON, not a concurrent delivery guarantee. The SQLite cutover starts
a new identity-ID cadence; old name-keyed counters are not imported.

Old JSON/workspace-metadata preambles are ignored, not migrated or deleted.
Reapply intended text explicitly with `preamble set`. Preamble changes persist
across folders, unbind and pane/server restart; clearing one does not clear its
identity or role.

## Commands

`name`, `this`, `whoami` and `unbind` require matching live `TMUX` and
`TMUX_PANE` caller context. Missing, malformed or stale context returns
`PANE_NOT_FOUND` (exit 3), not the default pane's identity. Implicit `role`
access returns `IDENTITY_REQUIRED` (exit 1). Do not fabricate caller variables:
outside tmux, use explicit `add <pane-target> <global-name>`, `talk <target>`,
`check <target>`, or `role show|set|clear --identity <name>`. Explicit selection
does not bind or authenticate the caller.

```bash
# Send a message to a global identity or direct pane target
tmt talk codex "your message"
tmt talk gemini "your message"
tmt talk %12 "your message"

# Send with delay (useful for rate limiting)
tmt talk codex "message" --delay 5

# Send and wait for response (blocks until agent replies)
tmt talk codex "message" --wait --timeout 120

# Read response (default: 100 lines); names and pane targets are both valid
tmt check codex
tmt check %12 200

# List all active identities, or inspect one pane
tmt list
tmt list %12
tmt name backend                 # bind the current pane globally
tmt this reviewer                # exact alias for `name`
tmt add %12 backend              # bind an explicit pane by stable pane ID
tmt whoami
tmt unbind
```

Global identities are independent of the current folder. Names may be
undeclared; they do not need a configured role. `tmt add` resolves `%pane_id`,
`window.pane`, or `session:window.pane` targets before storing the stable pane
ID. Pane-title updates are best-effort presentation side effects only; there is
no panel-title command or daemon.

The `add` argument order is `tmt add <pane-target> <global-name>`. The legacy
name-first order is rejected with a usage error. The name `all` is an ordinary
identity, not a special destination.

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

## Workflow

1. Send message: `tmt talk codex "Review this code" --wait`
2. Wait 5-15 seconds (or use `--wait` flag)
3. Read response: `tmux-team check codex`
4. If response is cut off: `tmux-team check codex 200`

## Notes

- `talk` sends via tmux buffer paste, then waits briefly before Enter and
  preserves multiline text.
- Control the delay with `pasteEnterDelayMs` in config (default: 500)
- Use `--delay` instead of sleep (safer for tool whitelists)
- Use `--wait` for synchronous request-response patterns; use `check` after a
  timeout or when polling.
- Sending pane input is an external action requiring user authorization.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.
