# Office command experience

## Implemented local installation

The CLI exposes `office install`, `upgrade`, `status` and `uninstall`. Office is
optional and independently versioned; no public Office release is available yet.
Source builds and explicit local archives can exercise this boundary. Do not
confuse successful local installation with pairing or a running connector.

```sh
tmt office install --yes
tmt office status --json
tmt office upgrade
tmt office uninstall --yes
```

All accept `--prefix <folder>` inside the Office subtree; omission selects
`~/.local`. Use the same prefix for subsequent operations. First installation
defaults to alpha; install/upgrade retain the recorded channel unless explicitly
given `--channel stable|alpha`. Office uses immutable `tmt-office-v<version>` releases
and the shared native archive verifier. Explicit offline installation uses
`office install --yes --archive <file> --manifest <file>` with both inputs.
Without a published candidate, online installation fails rather than claiming
success. `tmt upgrade` continues to update only the CLI and its managed skills.

`status --json` returns `installed`, `version`, `protocolVersion` and `executable`
after local ownership/integrity and handshake verification. It never checks cloud
availability. Plain `tmt office` currently reports `OFFICE_NOT_PAIRED` after a
successful probe; automatic world opening is not implemented. Uninstall
requires explicit consent and removes verified activation links only. Release
files and unrelated data remain. A partial removal reports an invalid
installation; repeat explicit uninstall to finish before reinstalling.

## Native pairing (source builds)

Pairing requires an installed compatible companion and an unlocked OS credential
store (macOS Keychain or Linux Secret Service). No public Office release is
published yet. Select a world and an existing identity explicitly outside tmux:

```sh
tmt office pair --world https://office.example/worlds/abcdefghijklmnopqrst --identity Alice
tmt office status --world https://office.example/worlds/abcdefghijklmnopqrst --identity Alice --json
tmt office inspect --world https://office.example/worlds/abcdefghijklmnopqrst --identity Alice --json
```

Open the printed approval link, sign in as the admitted world owner, recognize
the identity/installation and approve. `pair` waits up to 300 seconds; use
`--timeout 30` for a shorter observer and repeat the same command to resume the
original pending request. `--read-only` requests only layout read access. Omit
`--identity` only with verified pane context. Temporary identities are accepted
without promoting them to saved identities.

World-qualified `status` reports local retained state, not live authority.
`inspect` checks server access and reports only whether the assigned block exists;
it does not expose layouts or list other agents. Revocation can therefore leave
local status `credential` while inspect fails `OFFICE_REMOTE_DENIED`. A same-name
replacement has a different UUID and cannot inherit the pairing. `inspect`
renews a near-expiry or expired lease through the issuer, preserving the same
resource and permissions without daily browser approval. Local status does not
renew. Revoked or missing grants cannot be renewed; expired pending approvals
and lost credentials still need recovery work. Unpair remains planned.
The [native pairing contract](../../contracts/office/native-pairing.md) owns exact
scope, output, errors and emulator restrictions.

## Planned connected commands

The following connected behaviors are proposals, not installed instructions.
The [native pairing contract](../../contracts/office/native-pairing.md) refines
the in-progress pair/status/inspect inputs, outputs and deployment trust boundary.

| Command                                                    | Planned behavior                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tmt office`                                               | Open the selected world's web UI; never implicitly run a connector or publish agents                    |
| `tmt office install --yes`                                 | Explicitly acquire and verify the official extension; `--yes` consents to installation only             |
| `tmt office upgrade`                                       | Explicit verified extension update, with compatibility checks and rollback-safe activation              |
| `tmt office status --json`                                 | Local extension/pairing/connector status; no network or automatic update check                          |
| `tmt office run`                                           | Run the connector in the foreground; Ctrl-C stops it without cancelling native work                     |
| `tmt office publish <identity> --capability review`        | Publish an explicitly selected identity UUID and allowed capability; no implicit all-agent publication  |
| `tmt office unpublish <identity>`                          | Reject new work for that published identity, without deleting local identity or retained exchanges      |
| `tmt office unpair`                                        | Revoke remotely, then remove local credentials; offline failure reports pending revocation, not success |
| `tmt office social <identity> --minutes 10 --max-turns 20` | Request a bounded, opt-in social session; participants may decline and workspace tools stay disabled    |

## Decoration and discovery

The following syntax is proposed, not part of the shipped grammar. `status`
remains local; remote discovery reports only permitted resources. Installation,
human approval of pairing and block assignment are separate from remote work
publication. Visitors need only a browser. Installing the extension does not
provision a Firebase project or deploy a website.

| Proposed command                                                                         | Result                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `tmt office --help`                                                                      | Core-owned help, available without an installed extension                           |
| `tmt office map --json`                                                                  | Bounded permitted spatial projection, not unrestricted world enumeration            |
| `tmt office block ls --json`                                                             | Allowed blocks and assignments, without guessing IDs                                |
| `tmt office block show <block-id> --json`                                                | Canonical layout and revision                                                       |
| `tmt office block apply <block-id> --file <layout.json> --if-revision <revision> --json` | Conditional complete-layout edit, confirmed by the server; stale revisions conflict |
| `tmt office props ls --json`                                                             | The world's admitted prop catalog                                                   |
| `tmt office props show <prop-id> --json`                                                 | Pinned version, geometry and supported data, never executable instructions          |

`props` is the catalog namespace; block operations consume that catalog.
Authoring syntax is intentionally undecided until its bounded schema exists.
No current Rules enumeration or custom-asset support is implied by this table.
The [sandbox design](sandbox.md) owns prop admission, identity/assignment lifetime,
untrusted content and optional contextual notices.

One-shot discovery/edits should use valid scoped credentials without requiring
`run`; continuous event/work reception requires the foreground connector.
Grant renewal and offline expiry require a defined scoped authorization contract.
Non-tmux agents use the same commands. Missing or ambiguous context fails before
mutation, never inferred from folder, pane or display name. Agent usage is:
discover permission/catalog, read layout/revision, apply once, then summarize.
After uncertain writes reread before retrying; never silently advance the expected
revision to overwrite another editor. Final envelopes, byte/query bounds and
error mappings must be fixed in the implementation ticket before adding grammar.

## Typed dispatch

The core Clap grammar owns syntax, help and completions for the maintained Office
entrypoints. It produces typed invocations and dispatches to the verified extension;
handlers never slice argv again. The versioned
[internal handshake](../../contracts/office/native-companion.md) defines the
current executable boundary. Do not create a generic
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

Office errors use the existing native `Failure::document` envelope, not another
JSON output contract. Use normal nonzero
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
Provider capability and cost enforcement must be verified before enabling social startup.

The local agent receives the existing native TMT request/reply guidance, with
remote source attribution shown as untrusted presentation. The connector carries
verified remote ownership separately from that text. The native receipt stays
local and is never a bearer credential for cloud writes.

The agent replies through the existing durable native response channel, then may
show a short human-readable summary. Office displays the approved stored final,
not cropped terminal output. A completed local response with withheld export is
shown as withheld, not failed execution or an invitation to rerun the task.

Installed `skills/tmux-team/SKILL.md` and public help must match executable
commands. Proposed syntax is not installed-agent guidance.
