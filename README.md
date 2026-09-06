# tmux-team

Your coding agents, working together. Connect terminal agents in tmux:
delegate by name, collect complete replies, and recover outstanding work
without digging through terminal history. Local CLI, no daemon required.

## v5 preview installation

Install the tested `5.0.0-alpha.1` preview directly from this pinned revision.
Requires macOS or Linux, Node.js >=22.12 (Node 24 recommended), and tmux.

```bash
npm install -g https://github.com/wkh237/tmux-team/archive/47eaa363757583b1472b2fbc6bbd3559392afbf8.tar.gz
tmt install
```

No Git checkout, pnpm, or database setup needed. `tmt` is the short alias for
`tmux-team`. npm `latest` still provides v4, and `@alpha` is an older v3 preview;
neither installs v5. `tmt upgrade` does not update this preview: reinstall the
chosen pinned revision instead.

After `tmt install`, load or reload the installed `tmux-team` skill in each
agent before sending work. Provider-specific install notes are in
[`skills/README.md`](skills/README.md); the canonical bundled guidance is
[`skills/tmux-team/SKILL.md`](skills/tmux-team/SKILL.md).

Upgrading from an older version? Update the CLI, run `tmt install`, then restart
the agent or ask it to read `tmt learn --skill`. Installation never prompts;
conflicts are preserved until you explicitly choose `--force`.

## Quick start

Start a tmux session if you do not already have one:

```bash
tmux new -s tmt
```

Once the session opens, name the target pane from its shell before launching
the agent:

```bash
tmt name reviewer
gemini
```

From another terminal or tmux pane, send a request by name:

```bash
tmt talk reviewer "Review the current changes and report concrete risks."
```

The receiving agent's loaded skill explains how to use the request ID and
receipt supplied with the request. The default `talk` waits for that complete
reply; `--detach` returns a request ID so you can retrieve the result later
with `tmt result <request-id>`. A terminal marker, idle output, or process exit
is not a completed reply.

## Durable identity and recovery

Create a durable originator identity even when it is not currently bound to a
pane, then attribute requests explicitly:

```bash
tmt identity create coordinator
tmt talk reviewer "Run the agreed checks." --identity coordinator --detach --json
```

If a caller times out, detaches, or loses its pane, recover requests originated
by that identity from local storage:

```bash
tmt x --identity coordinator --json
tmt x show <request-id> --identity coordinator --json
tmt x ackall --identity coordinator --json
```

`x` lists retained attention metadata; `x show` reads the retained context and
final when available; `ackall` marks the current snapshot handled, while a
later final appears again. These commands do not cancel work or turn TMT into
an inbox.

## What tmux-team provides

- Global names that survive working-directory changes and optional durable role
  profiles for each identity.
- `talk`, `check`, and `list` by global name or direct tmux pane target.
- Complete final replies through `reply`/`result`, including late replies after
  a pane closes.
- Local SQLite state with no background service and no network transport.
- One skill for Claude Code, Codex, Gemini, agy, Pi and OpenCode, installed or
  repaired by `tmt install`.

Useful commands:

```bash
tmt list
tmt whoami
tmt add <pane-target> <global-name>
tmt check reviewer 100
tmt result <request-id> --json
tmt help
```

## Boundaries worth knowing

TMT routes to live panes on the current tmux server. It does not provide an
offline recipient queue, remote routing, shared memory, authentication, or MCP
connectivity. Durable identity records and retained request/reply data are
local to the configured SQLite database.

Messages preserve line breaks, but ASCII `!` is converted to fullwidth `！` to
protect coding-agent shell shortcuts. If delivery becomes uncertain, inspect
the pane before retrying; do not resend just because a caller timed out.

For workflows, recovery details, role profiles, preambles, configuration, and
failure semantics, see the [user guide](USER-GUIDE.md). The durable
request/response design is documented in
[`REQUEST-RESPONSE.md`](REQUEST-RESPONSE.md).

## One skill, no plugin

`tmt install` detects supported providers and installs the same canonical skill.
If none is detected, it installs the shared skill without requiring a provider.
Claude Code can invoke it as `/tmux-team`; no marketplace or separate `/team`
command is needed. See the [installation guide](skills/README.md) if you have
an older command or plugin installed.

## License

MIT
