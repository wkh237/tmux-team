# Modular Office visual package v1

Status: historical high-wall design package and retained generated art sources.
The current [platform contract](../../../../../contracts/office/rooms-and-walls.md)
supersedes its wall geometry, doorway, mounted-authoring and wall-HUD requirements.
The assembly and acceptance sections below describe the historical package, not
the current platform target. This is not a shipped skin system or a pixel-perfect
implementation claim. Generated images were visually inspected and PNG
dimensions checked. Architecture alpha spans 0–255; reviewed frame bounds are
now used by the local renderer. Seam, scale and occlusion acceptance is pending.
The remaining sheets still require extraction-time validation and admission.

The local workstation derivative now admits a desk, terminal, bookcase and four authored
chair views through the existing v2 prop catalog. It does not replace the old
packs or certify unimported views. Its
[import manifest](workstation-import.json) owns reviewed crop bounds and source
hash. `scripts/art/encode-props.py` reproduces the contract JSON; install its
optional authoring dependencies from `scripts/art/requirements.txt`, then pass
the manifest path to check exact bytes (add `--write` only to regenerate).
`scripts/art/test_encode_props.py` checks source fences and reproducibility.
Native/browser validators remain the admission authority.

The [mounted-object import](mounted-import.json) uses the same encoder for a
front-facing celestial window, brass sconce, picture frame and planted shelf.
They enter the existing Walls library and mounted-instance validation. The sconce
uses the existing bounded static glow; its source glow is not baked into a room.
Side-facing window extraction and mounted-art projection remain under review.

The [lounge import](lounge-import.json) admits the source sofa, armchair, coffee
table and tall plant as ordinary editable props. The native new-world preset
combines them with existing resource-bound facilities, leaving both Lobby
centerline passages clear. Existing saved layouts are never refurnished by reads.

The [reception import](reception-import.json) provides larger armchair and coffee
table variants for the new Lobby. It preserves the original lounge pack and its
digest, so retained furniture stays resolvable. Both variants use the same source
crops and ordinary v2 admission; no per-instance scale or special renderer exists.

The [facilities import](facilities-import.json) admits the source whiteboard,
cork discussion board and broadcast radio through the same prop validator and
built-in catalog. The new-world preset stores these appearances on the existing
three resource-bound objects, preserving their canonical host bindings. An art
pack alone grants no capability: placing a decorative copy does not create a
board or broadcast endpoint. Existing worlds and extension default appearances
remain unchanged. Compare the larger whiteboard and its transparent frame in the
actual world, not only in the source sheet.

The [robot import](robot-import.json) uses the same encoder for four static front
portraits in the existing 32×48 avatar v2 format. It does not claim directional
animation. The derivative passes native/browser admission,
profile selection and restart persistence; GPU fixtures cover all four variants
and missing-pack fallback. The local native catalog now supplies all four as
built-in choices without installation or SQLite seeding. Existing default and
explicitly selected appearances remain unchanged until the user saves a choice.
The [avatar-pack contract](../../../../../contracts/office/avatar-pack-v2.md)
owns installation and selection. Side and rear source views remain unimported.

Prop derivatives use 8 pixels per tile within guarded square frames; avatars use
the fixed 32×48 portrait frame. Both preserve aspect ratio, quantize to 255 opaque
colors plus transparency, and apply an alpha-128
cutoff. Original PNGs remain unchanged. This is explicitly not lossless alpha
admission. Lounge furniture and desk/terminal/bookcase are static billboards; only the rolling chair has four authored
views. Compare actual rendering before expanding this policy to other assets.

[The product contract](../../../../../contracts/office/rooms-and-walls.md) owns
behavior. [The manifest](assets.json) owns dimensions and the row-major component
inventory. [Generation prompts](generation.json) record built-in tool inputs and
corrections, not additional product requirements.

## Main views

| View                                          | Purpose                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Overview](01-office-overview.png)            | Lobby, four equal personal modules and an independently extensible meeting wing.    |
| [Material skins](06-material-skins.png)       | Workshop, Moonlight and Copper over the same geometry.                              |
| [Office operations](07-office-build-flow.png) | Add a whole office, inspect removal blockers, switch material, place a wall object. |
| [Meeting operations](08-meeting-flow.png)     | Empty-state ghost, required name, participants and safe spatial removal.            |

The [approved style input](00-approved-style.jpg) is preserved for material and
mood comparison only. Its Zone/6×4 workflow is obsolete. Named actors and two
meetings in the overview are a populated demonstration, not default identities
or rooms. The real starter has four unassigned offices and no meetings until
explicit creation.

## Reusable art

Four transparent source sheets contain 64 illustrated components or directional
variants. Grid positions identify artwork, **not** verified crop rectangles:
each source is 1254×1254, not the requested 2048×2048. Do not divide them into a
guessed runtime atlas or silently resize them to fit the current 32×48 avatar
contract. Admit reviewed derivatives through the owning art pipeline.

| Source                                              | Contents                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Architecture](02-architecture-source.png)          | Tall wall, low sill, side faces, corners/junctions, open portals, floor, corridors and bridges.                        |
| [Furniture](03-furniture-source.png)                | Desk, monitor, bookcase, lamp, four chair orientations, sofa, armchair, two tables, plant and three rugs.              |
| [Mounted objects](04-mounted-functional-source.png) | Three window views, sconce, poster, signs, shelf, whiteboard, discussion board, radio, notebooks, mug, plant and glow. |
| [Robots](05-robots-source.png)                      | Four accent colors × four static orientations. No movement or seating animation is implied.                            |

Plain wall sources have no baked windows or sconces. Bridge-edge lights are
structural styling, not selectable lamp instances. Windows, lamps and functional
objects stay separate. Editable text and resource contents are not supplied by
decorative pixels. Whiteboard art is not a document; radio art is not live state.

## Assembly and materials

- Fixed module slots own topology. One derived edge owns its wall/door/connector;
  do not overlay independent full-room backgrounds to hide broken seams.
- Lobby spans two office-slot widths and two office-slot heights. Its centerlines
  connect to the horizontal and vertical public corridors; empty neighboring
  cells do not need a room to support the corridor. This confirmed topology
  supersedes the earlier illustrations' shallower Lobby proportions, not their
  approved materials, wall depth, lighting or HUD treatment. Private offices share one footprint.
  Meeting modules use a stable independent slot lane connected to Lobby
  circulation; adding/removing one does not repack existing modules.
- Use one orthographic projection: equal-height front/back faces and substantial
  side returns. Exact metrics are locked by a real assembled
  module, not inferred from varying perspective in generated illustrations.
- Front and rear use the same authored wall face, crown and base. Foreground
  walls retain full height, not stretch a detached cap into a different wall.
  Independent terminal posts follow side-wall endpoints;
  openings retain their own jambs. Every room wall must read as a solid face with
  depth, not a floor trim line. Only public-corridor guardrails use a lower rise.
  Verify both at normal Fit scale as well as close up.
- Initially share Workshop structural material at cross-module connectors;
  per-room finishes stop at the owned interior face. This prevents competing
  shared-wall skins. Theme changes never alter occupied bounds or bindings.
- Keep the quiet space backdrop code-rendered and static. Use the glow image as
  reference for bounded local light, not a full-screen blur filter.

## HUD components

Use existing UI primitives and geometry anchors, not cropped screenshot text.
State stays with the existing draft, membership and resource owners.

| Component          | Target                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Build dock         | Select / Add office / Remove / Style / Walls / Furniture. No freeform floor/Zone tools.               |
| Draft actions      | Undo / Redo / Cancel / Save; disabled, saving, saved and retained-error states.                       |
| Anchored card      | Dark navy, thin teal border, cream text; viewport-clamped without resizing the world.                 |
| Inputs and roster  | Real inputs, keyboard focus, IME, required-name errors, searchable members and explicit Save members. |
| Placement feedback | Cyan ghost for allowed placement; amber outline plus explanatory text for protected removal.          |
| Functional cue     | One consistent keyboard-accessible activation cue; decoration has none.                               |
| Name and status    | Real identity and room names, honest presence, bounded display with accessible full text.             |

CSS targets: controls at least 44×44 px, body text 14–16 px, card radius 12 px,
internal padding 16 px, gaps 8 px. Colors: background `#071523`, panel `#091e2c`,
text `#f3ead7`, muted `#a7bbc0`, focus `#5ce7ee`, selected `#9af4d4`,
warning `#efb35a`, danger `#ec8b80`. Use the existing system UI font; generated
bitmap lettering is not an approved font asset. World pixels and HUD text may
use different sampling rules.

## Acceptance before pixel-perfect sign-off

1. Assemble a real module, open doorway, side mount, corner and neighbor. Check
   alpha on dark/light backgrounds, directional views, scale and palette bounds.
   Correct seams/occlusion before multiplying rooms; never bake a full-room
   background to conceal them.
2. Compare the assembly with the overview/material board for wall height, depth,
   material contrast, prop density and robot proportions. Sheets are source art,
   not proof that arbitrary crops meet runtime limits.
3. Capture 1536×1024 at DPR 1, fixed camera, seeded names/layout. Freeze the approved
   real screenshot, exact assets, projection and UI state as the pixel baseline.
   Use overlays/diffs; any raster tolerance must be explicit.
4. Verify Cancel, removal blockers, stale Save, and room creation followed by
   placement failure. Layout Undo does not undo independent membership/history.
5. Check DPR 2, narrow viewports, large rosters, missing art, culling, texture
   disposal and idle rendering. Responsive views need their own baselines.

Illustrated cutaways/operation panels are not dimensioned blueprints or evidence
of valid passages. Remaining runtime admission work is directional extraction,
scale/palette validation, seam/occlusion assembly, real HUD states and fixed-camera
baselines. No runtime source, installed preview, release or user layout is replaced
by this package.
