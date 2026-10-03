---
name: tmt-squad-dev
description: Build and verify the Squad extension (`tmt-squad`, `tmt-sq`, the board, notebook, cron library, embedded lead skill and playbooks). Load when changing extensions/tmt-squad or running its native and E2E checks. Owner - the tmt-squad squad. Not the shipped lead skill `tmt-squad`.
---

# Squad development

The shipped lead skill is `extensions/tmt-squad/skills/tmt-squad/SKILL.md`; this skill
is for developing the extension. Shared gates are in
[DEVELOPMENT.md](../../../DEVELOPMENT.md). Board rendering uses the internal TUI
markup: see [tmt-tui](../tmt-tui/SKILL.md).

## Reference files

| Topic                                                                                   | File                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Membership, leadership marker, `me`, field providers, staleness, reminders, cron        | [data-and-state.md](references/data-and-state.md)         |
| `squad.toml` layering and writes, themes, views, settings, link and action effects      | [config-and-effects.md](references/config-and-effects.md) |
| Row grid, composition, tab line, home, panes, notes, requests, scrolling, pickers, help | [board.md](references/board.md)                           |
| Refresh worker, change detection, token meter, shutdown                                 | [refresh-and-meter.md](references/refresh-and-meter.md)   |

## Invariants

- Core reachability: public `--json` commands and `tmt api` only, through
  `TMT_EXECUTABLE` (or `tmt` on PATH). `runner` maps results and errors onto
  `tmt-invoke` for bounded capture. No TMT crate depends on Squad; the
  architecture guard enforces both directions for Cargo dependencies and source
  references. Runtime TMT dependencies are the neutral leaves `tmt-cli-style`,
  `tmt-invoke` and `tmt-tui`.
- A squad is the core room `squad-<name>`. Member fields are identity metadata
  `squad.<name>.<field>`; Squad has no membership store of its own.
- Squad-owned data lives under `<dataRoot>/squad` (`storage.root` from `tmt api`),
  plus disposable caches under `$XDG_CACHE_HOME/tmt-squad/`. `squad.toml` is the
  user's file; agents never write it, and no cron data goes into it or the core
  database.
- Squad never writes `config.json`, a provider directory or tmux state except
  through core commands; `jump` and `back` use `tmt focus`.
- Board-only data (the home model and token-rate meter state, including any
  `usage.*` observation) never enters public `ls --json` or the other public
  documents. Public documents carry display-ready strings; consumers must not
  format them again.
- Paint and input perform no core reads; refresh, providers and notebook reads run
  on workers (see [refresh-and-meter.md](references/refresh-and-meter.md)).
- Command grammar, help and human output go through `tmt-cli-style`
  (`CommandSpec`, `Interaction`); `board` runs only when `Interaction::view()` is
  `Interactive`, decided once in `main`, otherwise it is `ls`. `tmt squad` with no
  command is `board`. Consent for hotkeys and playbooks is a `Consent` decided in
  `main` from `--yes` and `prompt()`.
- Squad's dependencies must not change the CLI product: prove it package-scoped
  (`cargo ... -p tmt-cli` alone), because combined workspace builds can unify
  shared-dependency features.
- Squad is versioned and released independently (`tmt-squad-v<version>` tags). Its
  archive also carries `skills/tmt-squad/`, the same source as the embedded lead
  skill; playbooks under `extensions/tmt-squad/playbooks/` are deliberately outside
  `skills/` (see [config-and-effects.md](references/config-and-effects.md#playbooks)).

## Checks

```bash
(cd rust && cargo build --locked)                       # default tmt-squad for the native test
(cd rust && cargo test --locked -p tmt-squad)
(cd rust && cargo test --locked -p tmt-squad --lib cron)
(cd rust && cargo test --locked -p tmt-squad cli_style)
```

- `typescript/test/native/squad.test.ts` runs `rust/target/debug/tmt-squad` (or an
  absolute path in `TMT_TEST_SQUAD`) through real `tmt` dispatch, with a sandbox
  `PATH` holding the `tmt-squad` and `tmt-sq` links and no installed-copy fallback.
  It reads rooms and metadata through an independent SQLite reader.
- Squad-scoped CI runs `squad.test.ts`, `extension-install.test.ts`,
  `extension-upgrade-proof.test.ts` and the `squad` E2E files listed under
  `scopedChecks` in `.github/components.json`.
- The Docker Squad lifecycle test kills temporary and saved panes before the first
  list read, then checks the roster and SQLite retirement/binding state; run it
  twice for cleanup.
- Dependency changes: compare `cargo tree -p tmt-cli -e normal,build -f '{p} {f}'`
  with `main` and the package-scoped release `tmt` to prove the CLI is unchanged.
- Cron tests use disposable roots and must not touch the core database or
  `squad.toml`.
- Tab parity: `built_in_board_documents_equal_ls_tab_documents` and
  `user_board_and_ls_share_members_sections_bindings_and_failed_reads` require board
  views and `ls --tab` to project identical documents, including hidden squads/tabs
  and partial-read recovery. `board::home::tests` checks the retained board model
  against that aggregate. Use an isolated `XDG_CACHE_HOME` when testing board
  observation.
- Settings editor changes: cover live preview, focus and age-evidence restoration on cancel,
  invalid input, read-only command entries and stale-file refusal (native edits verify shared
  staleness after reload, including the disabled no-publication path); capture normal and
  narrow states from isolated HOME/`TMUX_TEAM_HOME` and a private tmux socket. The
  [settings editing reference](references/config-and-effects.md#settings-inspection-and-editing)
  owns the preview and writer contracts.
- UI changes: verify real private-tmux captures in `tmt`, `tmt-light` and `NO_COLOR`,
  at top and end of scroll, with isolated HOME, `TMUX_TEAM_HOME` and XDG cache, and
  the help modal at 160/100/80 columns. Meter CPU measurements (matched 60-second
  idle off/on/reduced-motion; budget below 0.5 percentage point of one core) are
  local evidence, never a CI threshold.

## Embedded skills

The squad executable embeds the lead skill and the playbooks
(`extensions/tmt-squad/playbooks/<name>/SKILL.md`), outside the core skill bundle.
`playbook.rs` tests pin the catalog to the source files; `squad.test.ts` covers
install and removal against isolated provider roots and checks the documented
status row shape against real output. Every command a playbook tells an agent to run
is executed once in a disposable tmux server and git repository before it is
written down. A row JSON or SKILL.md row-doc change also runs the native
`squad.test.ts`; give an optional row key its own bullet.

Squad archive build and verification are in
[tmt-release](../tmt-release/references/native-release.md#squad-archives).
