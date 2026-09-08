# TMT native artifact preview

This archive contains a standalone Rust development preview, not a published
replacement for the npm runtime. It needs no Node.js, Rust toolchain or source
checkout to run. tmux is still required for pane operations.

Use isolated test state until native cutover. Native schema 9 is forward-only:
the TypeScript runtime cannot reopen it. Replacing a binary is not a database
downgrade. Do not run this preview against an existing user database.

After extracting a verified archive into a chosen test directory:

```sh
tmt_preview_root=$(mktemp -d)
./tmt --version
TMUX_TEAM_HOME="$tmt_preview_root" ./tmt learn --skill
TMUX_TEAM_HOME="$tmt_preview_root" ./tmt install --dir "$tmt_preview_root/skills" --json
```

Skill installation is non-interactive and does not install agent applications.
This example deliberately keeps its managed files in the temporary preview root.
Choose a directory your provider discovers and reload its skills. Retain the
included LICENSE and THIRD-PARTY-NOTICES.txt with redistributed binaries.

Managed binary receipts, `upgrade`/`update`, and release-generated shell bootstrap
are implemented in the preview. Public native releases remain a publication gate;
do not assume a downloadable native release exists yet. Do not overwrite an
npm, pnpm, Homebrew or manual installation.
The selected executable's help is the capability authority; the shared alpha
version number alone does not distinguish native and TypeScript runtimes.

For a verified managed native installation, `tmt upgrade` retains its channel;
`tmt upgrade --channel alpha` selects alpha, `--to 5.0.0-alpha.2` pins an exact
version, and `--unpin` resumes channel updates. `tmt update` is the same command.
Downgrades are rejected. An ordinary pinned invocation does not access the
network. Use `--json` for a single structured result. The update refreshes only
previously managed skills through the new binary; missing integrations stay
missing and user modifications are preserved. Reload the agent after changes.
A skill failure can occur after binary activation and is reported as partial
completion, not rollback; resolve reported conflicts and repeat the original
selection, including `--to <version>` when pinned. Ordinary pinned updates do
not retry skill work.

The distribution manifest supplies archive names, target triples and SHA-256
checksums. Checksums detect corruption, not compromise of the download origin.
No local test artifact is authenticated by a published GitHub attestation.
Public immutable-release provenance and verification instructions remain a
separate release gate; do not describe locally generated checksums as signatures.

Target candidates are macOS x64/arm64 (deployment target 11.0) and Linux x64/arm64
with a static musl runtime. Actual target execution and linkage must pass before
release support is claimed; cross-compilation alone is not acceptance evidence.

## Curl bootstrap

Public native publication is still pending. Once published, use the release's
exact `tmt-installer.sh` asset URL (replace `<VERSION>` with its version):

```sh
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  'https://github.com/wkh237/tmux-team/releases/download/v<VERSION>/tmt-installer.sh' | sh
```

The script fixes the initial version/channel, not a mutable alpha tag. Later
`tmt upgrade` follows that channel. To inspect first, download the same URL to
a file, read it, then run `sh tmt-installer.sh`. A failed/truncated download is
not installation success; check the installed absolute command afterwards.

Default prefix: `$HOME/.local`, with commands in `~/.local/bin`. Options after
`sh -s --` (or the downloaded script):

- `--prefix /absolute/directory`: another prefix, including paths with spaces.
- `--pin`: pin this release; `tmt upgrade --unpin` resumes channel updates.
- `--no-skill`: binary only. Otherwise the new absolute command runs the existing
  non-interactive `tmt install`; no provider application is installed.

Requires POSIX shell, curl, tar/gzip, standard filesystem utilities and
`sha256sum` or `shasum`. No Node, Rust, jq or sudo. The script verifies manifest
and archive sizes/digests before executing the temporary binary, then delegates
permanent writes to the native installer. It does not edit shell profiles or
touch SQLite. Initial receipts record local-archive verification, not independent
attestation provenance. HTTPS and hashes do not protect a compromised origin.

## Replacing npm or pnpm

This is a fresh installation, not a data-transfer or compatibility tool. Stop old
TMT commands/agents before switching. Installation neither migrates nor deletes
old configuration/databases or uninstalls another manager's files.

For an npm installation, use `npm uninstall -g tmux-team`; for pnpm, use
`pnpm remove -g tmux-team`. Do not run both blindly. A collision in the selected
prefix is refused: choose another prefix or remove the old package through its
actual owner. Homebrew/manual installations likewise retain their own lifecycle.

Put the new prefix's `bin` first in PATH, then run `hash -r` or open a new shell.
Check `command -v tmt`, `command -v tmux-team` and the new absolute `tmt --help`.
The installer warns about PATH shadowing and never runs the old command. An
installed binary is not proof your shell selects it; aliases/functions and other
open shells may need separate correction.

Old npm-linked skills may conflict. Inspect them, then explicitly run the new
absolute `tmt install --force` if replacement is intended. The shared installer
makes recoverable backups; bootstrap never silently forces. Skill failure returns
nonzero after binary installation, without claiming rollback. Reload the agent
or ask it to read the complete `tmt learn --skill`. No historical-session
continuity or SQLite downgrade is promised; never use the old TypeScript writer
on a schema-9 database.
