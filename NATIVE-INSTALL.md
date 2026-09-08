# TMT native alpha installation

This archive contains the standalone Rust native alpha runtime. It needs no
Node.js, Rust toolchain or source checkout to run. tmux is still required for
pane operations. Use the installer asset from a published release; the README
supplies the verified version URL when one is available.

Native schema 9 is forward-only: the TypeScript runtime cannot reopen it.
Installing or replacing a native binary does not migrate, delete or downgrade
application data. Stop older TMT writers before switching, and do not run the
native runtime against a database that the TypeScript runtime still uses.

After extracting a verified archive into a chosen directory:

```sh
tmt_preview_root=$(mktemp -d)
./tmt --version
TMUX_TEAM_HOME="$tmt_preview_root" ./tmt learn --skill
TMUX_TEAM_HOME="$tmt_preview_root" ./tmt install --dir "$tmt_preview_root/skills" --json
```

Skill installation is non-interactive and does not install agent applications.
The example keeps its managed files in a temporary directory; for normal use,
choose a directory your provider discovers and reload its skills. Native pane
bindings are temporary by default: use `-s`/`--save` with `name` or `add` to
preserve one, and use `rm <name>` to retire a temporary identity (`--force` is
required for a saved identity). Retain the included LICENSE and
THIRD-PARTY-NOTICES.txt with redistributed binaries.

Managed binary receipts, `upgrade`/`update`, and release-generated shell bootstrap
are implemented by the native runtime. Do not overwrite an npm, pnpm, Homebrew
or manual installation.
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
For a published immutable release, `gh release verify <tag> --repo
wkh237/tmux-team` verifies GitHub's release attestation; `gh release verify-asset
<tag> <downloaded-file> --repo wkh237/tmux-team` also checks a local asset.
This optional independent check requires GitHub CLI, not the installed TMT
runtime. Do not describe locally generated checksums as signatures.

Release targets are macOS x64/arm64 (build deployment target 11.0) and Linux
x64/arm64 with a static musl runtime. Refer to the release's verification evidence
for tested host OS versions; a deployment target is not testing on every OS.

## Curl bootstrap

Use the exact `tmt-installer.sh` asset URL from a published release. The README
supplies the verified version URL when one is available. Set that URL as
`TMT_INSTALLER_URL` after checking the release asset before running:

```sh
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --output tmt-installer.sh "$TMT_INSTALLER_URL" &&
sh tmt-installer.sh
```

The script fixes the initial version and channel, not a mutable alpha tag.
Later native `tmt upgrade` follows that channel. Inspect the downloaded file
before running it; a failed or truncated download is not installation success.
Check the installed absolute command afterwards.

Default prefix: `$HOME/.local`, with commands in `~/.local/bin`. Options after
`sh -s --` (or the downloaded script):

- `--prefix /absolute/directory`: another prefix, including paths with spaces.
- `--pin`: pin this release; `tmt upgrade --unpin` resumes channel updates.
- `--no-skill`: binary only. Otherwise the new absolute command runs the native
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
