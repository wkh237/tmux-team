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

Managed binary receipts and `upgrade`/`update` are implemented in the preview.
Shell bootstrap and public native releases remain separate publication gates;
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
