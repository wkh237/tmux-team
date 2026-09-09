# Planned Office command experience

Design for #174, implemented later by #177/#178. None of these commands is in
the current CLI grammar. These examples are contracts to implement, not install
instructions for a currently published extension.

| Command                                                    | Planned behavior                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tmt office`                                               | Open the selected world's web UI; never implicitly run a connector or publish agents                    |
| `tmt office install --yes`                                 | Explicitly acquire and verify the official extension; `--yes` consents to installation only             |
| `tmt office upgrade`                                       | Explicit verified extension update, with compatibility checks and rollback-safe activation              |
| `tmt office status --json`                                 | Local extension/pairing/connector status; no network or automatic update check                          |
| `tmt office pair --world <https-origin/world-id>`          | Explicit bounded pairing and capability confirmation with the selected deployment                       |
| `tmt office run`                                           | Run the connector in the foreground; Ctrl-C stops it without cancelling native work                     |
| `tmt office publish <identity> --capability review`        | Publish an explicitly selected identity UUID and allowed capability; no implicit all-agent publication  |
| `tmt office unpublish <identity>`                          | Reject new work for that published identity, without deleting local identity or retained exchanges      |
| `tmt office unpair`                                        | Revoke remotely, then remove local credentials; offline failure reports pending revocation, not success |
| `tmt office social <identity> --minutes 10 --max-turns 20` | Request a bounded, opt-in social session; participants may decline and workspace tools stay disabled    |

The core Clap grammar owns syntax, help and completions for the maintained Office
entrypoints. It produces typed invocations and dispatches to the verified extension;
handlers never slice argv again. A versioned internal invocation contract is
refined with #177 before the executable boundary exists. Do not create a generic
plugin platform or move all TMT commands into extensions.

## Missing extension

Interactive `tmt office` may show one prompt:

```text
Office is an optional extension and is not installed.
Install the verified Office extension? [y/N]
```

Declining exits without downloading, authenticating, pairing or changing config.
Noninteractive and `--json` calls never prompt or download. They fail promptly:

```json
{
  "error": {
    "code": "OFFICE_NOT_INSTALLED",
    "message": "Install Office with: tmt office install --yes"
  }
}
```

This uses the existing native `Failure::document` envelope; #177 must reuse that
formatter rather than introduce another JSON output contract. Use normal nonzero
failure exit status `1` for Office installation, compatibility, authentication,
permission and network errors; API HTTP numbers are not process exit codes.
Unsupported flags retain the native grammar's existing parse-error contract.
An installation success resumes only the original UI-opening action; it never
implies sign-in, background startup, pairing or sharing. Ordinary CLI commands
do not probe for updates or incur Office startup/network cost.

## Local and remote failure

- An incompatible extension reports `OFFICE_INCOMPATIBLE` with supported protocol
  versions and the explicit upgrade instruction; no unsafe dispatch or auto-update.
- `pair` rejects non-HTTPS remote origins. Local emulators use an explicit dev-only
  test configuration, not a production TLS bypass. Redirects cannot change the
  deployment trust target. Approval UI shows the real deployment and device.
- `run` without valid pairing reports `OFFICE_NOT_PAIRED`. A revoked device stops
  accepting work and reports `OFFICE_REVOKED`; it does not silently re-pair.
- Duplicate connector startup for one device is rejected through an owned local
  lock. Crash recovery inspects durable dispatch records before claiming work.
- `unpair` while offline can forget local credentials only through a separately
  explicit `--local-only` action that warns remote revocation is still required.
  Never report an unreachable remote device as revoked.
- `status --json` distinguishes installed compatibility, locally known pairing,
  process observation and the age of any last remote observation. It cannot claim
  current remote availability from a stale cache.

## Recipient experience

Social startup also requires an explicit owner-configured cost ceiling. If the
chosen provider cannot enforce the configured bounds or a tool-free context,
refuse startup rather than silently running an unbounded privileged conversation.
The provider/configuration seam is refined in #179 before this command ships.

The local agent receives the existing native TMT request/reply guidance, with
remote source attribution shown as untrusted presentation. The connector carries
verified remote ownership separately from that text. The native receipt stays
local and is never a bearer credential for cloud writes.

The agent replies through the existing durable native response channel, then may
show a short human-readable summary. Office displays the approved stored final,
not cropped terminal output. A completed local response with withheld export is
shown as withheld, not failed execution or an invitation to rerun the task.

Installed `skills/tmux-team/SKILL.md` must be updated in the same implementation
PR that exposes these commands. Do not advertise unimplemented syntax in the
installed skill or public README today.
