---
name: tmt-tui
description: Verify the internal TUI markup crate (`rust/crates/tmt-tui`) - XML admission, utilities, geometry, paint and components - and the Squad board parity baseline that depends on it. Load when changing tmt-tui or board output. Owner - the tmt-squad squad.
---

# Internal TUI markup (`tmt-tui`)

Architecture and the style guideline own roles and sizing; this skill holds the
commands, the admitted spellings and the parity gate.

```bash
(cd rust && cargo test --locked -p tmt-tui)
(cd rust && cargo +1.95.0 test --locked -p tmt-tui)
(cd rust && cargo test --locked -p tmt-cli --test architecture)   # component and dependency changes
(cd rust && cargo test --locked -p tmt-squad)                     # source adapter, board/list parity fixture
(cd rust && cargo test --locked -p tmt-squad board::composition)  # composition changes
```

## Admission rules

- Squad is the only reviewed consumer. A new consumer, a new dependency or any
  Squad term in the crate goes to tmt-lead first. The architecture guard permits
  XML parsing, borrowed JSON, shared style, private Taffy geometry and Ratatui
  buffer painting; never core, adapters, CLI or extension behavior.
- The leaf acquires nothing: no terminal, clock, settings persistence, markdown or
  provider data. Applications own data, effects, item cursors and terminal
  lifecycle.
- Components implement the
  [full-screen interaction guideline](../../../design/cli-style.md#full-screen-interaction);
  application-owned descriptions and effective bindings supply their text.
- Tokens use `tmt-cli-style::theme::Role`. No palette is resolved or copied here.

## Pipeline

1. **Structural admission** (`lib`, `style`): bounded XML (`MAX_BYTES` 256 KiB,
   `MAX_DEPTH` 32, `MAX_NODES` 20,000) becomes a template with source locations,
   not a renderable scene. Declarations and excessive depth are refused before
   tree allocation. Static classes, wrap and literal tokens
   compile into `style::CellStyle`, including every repeat template.
2. **Binding** (`binding::compile`, `materialize`): `compile` checks an explicit
   application schema, lexical dotted paths (root `$` and repeat aliases), stable
   IDs and application-owned source/format handles, including empty repeat
   bodies. `materialize` borrows `serde_json::Value` data and checks referenced
   value kinds. Missing required paths are errors; null scalar text is absent.
   Direct binds retain display text; only the application's source adapter applies
   formats. Expansion is bounded to 20,000 nodes, 20,000 repeat iterations and
   8 MiB of aggregate text/ID bytes (including the duplicate-ID registry).
   Borrowed text is charged before copying. Stable IDs are nonempty, nonnumeric
   strings of at most 256 bytes and use scoped components, never collection
   positions; semantic row IDs stay separate.
3. **Geometry** (`geometry::layout`): materialized styles map into one private Taffy
   flex/grid computation. It borrows node identity/style, takes scalar intrinsic
   and wrap metrics, and returns whole-cell rectangles, content, ancestor clips
   and overflow/cut intent. Fractional spare cells are styled blanks inside hits.
   A cut grid cell keeps its logical width/height, shows at least four cells or
   hides whole. Percentages are CSS content-box shares with gaps added; CLI lists
   keep their own after-gap base and rounding in `tmt-cli-style::grid`, and no
   adapter joins the two policies.
4. **Text and paint** (`text`, `paint`): `text` owns grapheme measurement and fitting
   for markup; `paint` consumes geometry in preorder into a caller-owned Ratatui
   buffer. Both use `Cell::text_width`, never the rounded spare cell. Cuts
   ellipsize already measured lines without rewrapping (end or middle); a wide
   grapheme crossing a clip edge leaves styled blanks. Theme and Depth are
   injected; roles inherit and resolve through the shared screen adapter. The
   caller supplies the complete selected-role style, so selection policy stays
   with the application.
5. **Hits**: hits borrow scoped IDs and semantic row IDs, inherit identity,
   intersect visible buffer clips, omit zero areas and resolve in reverse paint
   order.

## Utility spellings

One spelling per value kind; anything else fails admission with a located error:

- Cells, weights, counts: `w-N`, `h-N`, `basis-N`, `min-w-N`, `max-w-N`, `grow-N`,
  `shrink-N`, `gap-N`, `gap-x-N`, `gap-y-N`, `p-N`, `px-N`, `py-N`, `col-span-N`,
  `line-clamp-N`; also `grow`, `shrink`, `w-full`, `h-full`. `N` is ASCII decimal
  0..4096 terminal cells (`w-4` is four cells, not a rem scale); spans and clamps
  are positive.
- Percentages and tracks: `w-[N%]`, `h-[N%]`, `basis-[N%]`, `grid-cols-[tracks]`.
  Percentages are integers 0..100; tracks are underscore-separated cells,
  percentages, integer `Nfr`, `auto`, or `minmax(a,b)` (no fr minimum; `auto` only
  as the minimum). Bracket integers fail with a bare-form hint.
- Layout: `flex`, `flex-row`, `flex-col`, `grid` (grid conflicts with an explicit flex
  direction). Text: `truncate`, `truncate-middle`, `line-clamp-N`; leaf
  `wrap="true"|"false"` conflicts with all text-flow utilities.
- Unknown or malformed utilities, duplicate/overlapping properties, variants,
  fractional numbers and arbitrary CSS values fail admission. Padding is symmetric.
  View and col default to column, other elements to row; sizes default to auto,
  gaps/padding/grow to zero, shrink to one, text to clipping. `token` names a shared
  `Role`; omission inherits.

## Components

- `components::surface::compile` lowers `tmt-modal`, `tmt-scroll` and `tmt-key-help`
  into primitive templates and checks depth/node budgets and schemas eagerly. A
  surface has one literal-ID modal, one literal-ID scroll body and optional
  `tmt-text slot="footer"|"status"`; components cannot occur in repeats.
- `tmt-list`/`tmt-table` bind a root collection whose rows declare
  `id: StableId`, `disabled: Boolean` and display fields, and contain exactly one
  `tmt-row` template (`as` alias, default `row`); one list or table per scroll
  surface. `tmt-picker` supplies its own modal and scroll body.
- Callers perform effects: route input through `app::route` before base handlers,
  discard row maps on resize or model replacement, and call `Picker::reconcile`
  after `QueryChanged`. Rendering never runs effects.
- `text::measure` is a capped upper bound, not the widest wrapped line; measurement
  and fitting share the recorded text width, and paint reuses it.

## Application layer and component behavior

- `app` owns base focus, one replaceable modal and top-first event routing:
  unhandled modal keys and mouse are captured, closing events never replay into the
  base, and Ctrl-C returns a quit effect.
- `components` owns opaque square-border modal chrome, fixed footer/status/position
  slots, visual-line scroll/clamp/reveal and typed key-help sections. Its surface
  compiler lowers component markup into the same bounded binding and geometry
  pipeline, so generated templates obey the same depth/node limits. Component IDs
  are static scoped IDs outside repeats. One list or table is supported per scroll
  surface.
- Key help measures one display-cell label column across all sections and stacks
  descriptions when fewer than 20 cells remain. Heading and spacing properties let
  a caller choose bold headings and one blank line between sections.
- `ListState` reconciles stable row identity across refresh and reorder, picks the
  nearest enabled survivor after removal and reveals the whole wrapped row.
  List/table admission requires a row template and typed `id: StableId` and
  `disabled: Boolean` fields; table cells use existing grid tracks. Disabled and
  empty rows cannot activate. Ordinary panes use `collection::compile/render`;
  modal lists and picker slots use `surface::compile/render_list`. Clipped row
  maps retain the painted model and scroll offset, so stale mouse geometry cannot
  activate. Ordinary panes reserve a dim `N more ↓` line while content overflows.
- `Picker` owns bounded grapheme query editing and returns query changes,
  selection changes, confirmation or cancellation. The application filters
  projected data, routes focused fields and owns previews, saves and rollback.
- Rendering injects Theme/Depth and the selection policy, keeps semantic roles
  under caller-owned selection styling (reverse/bold fallback) and returns
  current-frame clipped hits.

## Board parity baseline

The parity harness captures the three explicit presets and the team default at
120×30, 80×30 and 120×30 again, including every cell's style and state, hits, row
starts and list text/JSON. A board PR that intentionally changes captured output
regenerates the baseline in that PR, in a separate commit:

```bash
cargo test --locked -p tmt-squad regenerate_markup_parity_fixture -- --ignored
```

Decode the cell/style diff, attribute every change to the PR's approved behavior and
review hit identities and list bytes; unexplained changes block handoff. Normal
tests never write the fixture. `board::composition` keeps frozen board/list parity
unchanged; any other rectangle difference stops review.
