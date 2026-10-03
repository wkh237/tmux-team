---
name: tmt-tui
description: Change or review `rust/crates/tmt-tui`, the application-neutral internal TUI component leaf, and its admission, geometry, paint and component rules.
---

# tmt-tui

`rust/crates/tmt-tui` is an internal, unpublished presentation leaf for TMT
terminal UIs. [ARCHITECTURE](../../../ARCHITECTURE.md#runtime-layers) owns its
place in the dependency graph; this skill is the maintained reference for its
modules. The crate has no release and no Squad vocabulary. Its inherited version
and lock entry follow the workspace, and product notices include only the real
dependency graph.

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

## Application layer and components

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

## Verification

Commands and the focused matrix live in DEVELOPMENT's
[internal TUI admission section](../../../DEVELOPMENT.md#internal-tui-markup-admission).
From `rust/`: `cargo test --locked -p tmt-tui` and
`cargo +1.95.0 test --locked -p tmt-tui` (MSRV). Run the native architecture test
(`cargo test --locked -p tmt-cli --test architecture`) for any manifest change.
Squad-side parity and composition checks are in the
[Squad developer skill](../tmt-squad-dev/SKILL.md#verification).
