---
name: tmt-squad-dev
description: Change or review the Squad extension (`extensions/tmt-squad`, the `tmt squad`/`tmt sq` executable): its core seam, data ownership, board internals, configuration and verification.
---

# Squad development

Squad is an optional extension, built from `extensions/tmt-squad/rust/tmt-squad`
into `tmt-squad` and reached as `tmt squad` and, through a `tmt-sq` link to the
same file, `tmt sq`. The command name is fixed, never taken from argv[0], so both
spellings share one help text, error set and completion. It is a workspace member
for the shared lockfile and toolchain only.

[ARCHITECTURE](../../../ARCHITECTURE.md#squad-extension) owns the seam, dependency
direction and public-contract index. The user-facing row/config reference is the
embedded lead skill, `extensions/tmt-squad/skills/tmt-squad/SKILL.md`; do not copy
its field lists, state-pattern grammar or key tables here. This skill holds what a
maintainer needs that the lead skill does not.

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

## Row-shape contract

The row JSON documented in the lead skill is checked against real output by
`typescript/test/native/squad.test.ts`. A change to row JSON or its lead-skill
documentation runs that native test; each optional key gets its own bullet in the
lead skill.

## Verification

From `rust/`: `cargo test --locked -p tmt-squad` (unit tests, the in-memory source
adapter and the frozen board/list parity fixture) and the architecture guard
`cargo test --locked -p tmt-cli --test architecture` on every Rust push.
Squad-scoped native scenarios are in DEVELOPMENT's
[Squad extension section](../../../DEVELOPMENT.md#squad-extension).

- Cron: `cargo test --locked -p tmt-squad --lib cron`.
- Composition: `cargo test --locked -p tmt-squad board::composition`.
- Parity: the harness captures the explicit presets and the team default at several
  widths, including each cell's style, hits, row starts and list text/JSON. A board
  PR that intentionally changes captured output regenerates the baseline in a
  separate commit with
  `cargo test --locked -p tmt-squad regenerate_markup_parity_fixture -- --ignored`,
  and attributes every decoded cell/style, hit and list-byte change to approved
  behavior. Normal tests never write the fixture. DEVELOPMENT's
  [internal TUI markup admission section](../../../DEVELOPMENT.md#internal-tui-markup-admission)
  owns the full procedure until it moves here.
- Shared `tmt-tui` changes also follow the [tmt-tui skill](../tmt-tui/SKILL.md).
