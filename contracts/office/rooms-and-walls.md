# User-built Office, rooms, wall objects and communication

Status: local visual and interaction refinement in progress; not a released feature.
World editing, wall authoring, scoped delivery and compact browser conversations
and room-scoped discussion, saved-notebook entry points and browser pixel-art
authoring are implemented locally. Earlier functional checks do not constitute
acceptance of the revised wall depth, starter layout or canvas-first editing experience.
Publishing and user-preview replacement remain separate actions.
The local room CLI, scoped direct delivery, inbox fan-out and listen behavior are
defined in [meeting rooms](meeting-room-v1.md). Local direct chat now projects
durable requests/replies and recovers unconfirmed sends.
This is the consolidated implementation goal. The target is an owner-built,
single-floor, modular Office centered on a Lobby. Fixed-size personal-office cells
extend cardinally; a separate meeting zone extends without repacking the office.
Identity creation never builds a room. The [visual reference index](../../docs/office/references/rooms-and-walls/README.md)
identifies the current modular design package. Illustrations
are not runtime evidence; this document overrides incidental generated details.
Do not publish or replace the user's running preview as part of this local stage.

## Shared ownership

- Separate world topology, area definitions, personal occupancy, object placement
  and communication membership. Identity creation does not generate floor or rooms.
- Reuse existing state/revision/resource owners; no second world, chat, notes or
  presence database. Remove superseded projection paths rather than maintaining two.
- This work is pre-launch: breaking API, command and module refactors are allowed.
  Do not preserve obsolete block interfaces through compatibility wrappers or
  dual writes merely to avoid changing callers. Update callers, tests and guidance
  together. This does not authorize discarding existing user layouts or resource
  contents; migrate retained data while replacing its old implementation owner.

- One identity may join many rooms. Reuse the existing durable room UUIDs and
  many-to-many membership; personal workspaces are not meeting rooms.
- Promote room membership and scoped delivery into transport-neutral core use
  cases. CLI and authenticated local HTTP are adapters, not separate services.
  Room CLI use must not require installing or starting the optional Office.
- Retain the current request/inbox/reply store and operation receipts. Room
  context belongs to canonical exchanges, not a second message/chat database.
- Wall objects reuse admitted artwork and placed-instance/resource definitions.
  Walls supply placement surfaces, not another decoration catalog.
- The world paints projections and emits object/identity/room IDs. It does not
  infer membership, execute shell strings, scrape terminals or own request state.

## Room semantics and CLI

The first version is communication scoping, not a security boundary.
The installation owner can inspect and manage all local rooms. Do not silently
implement member ACLs or claim that room filters protect secrets.

Use stable room UUIDs. Friendly names may resolve only when an exact name has
one match; duplicate existing names must produce an ambiguity error with IDs,
never route to the first result. Do not introduce a persistent ambient current
room because an agent may participate in several rooms simultaneously.

Room grammar shares the existing typed parser and dispatch owners:

```sh
tmt room create "Design"
tmt room ls
tmt room show <room>
tmt room join <room> --identity Alice
tmt room leave <room> --identity Alice
tmt room retire <room>
tmt ls --room <room>
tmt talk Alice "Review this change" --room <room>
tmt room send <room> "Review this change"
tmt room broadcast <room> "The review is ready"
tmt x listen --identity Alice --room <room>
```

Join/leave omit identity only when normal caller resolution proves it. Membership
edits are atomic set changes; concurrent joins cannot replace an unrelated member.
Joining twice or leaving an absent membership is a no-op. Offline saved agents
remain members; retirement removes them from effective membership, and same-name
replacement does not rejoin. Preserve existing conditional full-roster editing.

The agent Info panel offers Add to meeting. Choose a room and review the existing
roster plus the selected agent in the normal room editor; only Save room writes.
Already-joined and full-room states are explicit. Closing the panel retains the
draft, and switching agent/room cannot replace it without finishing or discarding
it. This entry never assigns a home, moves furniture or dispatches a message.

`ls --room` restricts the existing identity/presence result. A direct `talk` room
option scopes the target and records context; it never silently becomes fan-out.
`room send` explicitly queues one replyable request per effective member and
returns per-recipient receipts. `room broadcast` uses existing no-reply
announcements. Exact audience/revision fences and operation replay retain their
existing behavior; empty rooms fail before any request is written. General
identity routing without a room remains unchanged.

Incoming room filters use stored request context, not the recipient's current
membership. Leaving a room cannot hide previously delivered work or prevent its
reply. Room retirement preserves history and references while excluding the room
from new selection/delivery. Define help, JSON, exit codes and rejection of
incompatible options together in the existing parser/dispatcher owners.

## User-built world and area lifecycle

Start a new layout with a furnished Lobby and four equal personal-office cells,
two above and two below a fixed 2×2-cell Lobby preset. Personal cells start
unassigned; illustrative named robots are not automatically created identities.
The owner extends the layout explicitly and rearranges its contents; the preset
is a starting point, never a recurring reset. Initial reads
must not overwrite existing data or materialize unrelated resources.

The enlarged Lobby is a furnished shared center, not an empty oversized cell:
compose a central sofa-and-table lounge, legible entry signage, discussion,
whiteboard and broadcast stations, with perimeter shelving, plants and warm
lights. Keep cardinal circulation and functional-object discovery clear. All
furnishings remain ordinary editable instances; this preset only initializes a
new world and never overwrites a saved layout.

Use fixed-size module slots along north/south/east/west directions. Add an office
by selecting an eligible adjacent slot, not by painting individual floor tiles
and subsequently zoning a rectangle. The Lobby is the layout origin; its wider
preset occupies four cells, not a variable brush region. Its horizontal and
vertical centerlines align with the gaps between office rows and columns.
Public corridors extend out along those centerlines; they do not require rooms
on both sides, and an empty neighboring cell remains empty space. Derive
circulation, shared edges, door openings and exterior boundaries from the same
module arrangement. Circulation is a continuous checkerboard corridor network
between module rows and columns, with connected junctions around the central
Lobby. Keep passage widths narrow and independent of the Lobby dimensions.
Short door-to-door bridges alone do not satisfy this layout: users must
be able to trace the common corridor without passing through a private office.
The corridor must remain visibly readable beneath the cutaway walls; rendering
and creation wireframes use the same real corridor geometry. Only offer slots
with valid access; additions must not
strand a room, sever circulation or block the meeting-zone connector. Keep one
connected, bounded floor: no diagonal-only attachment, stairs, multi-floor system
or simulated walking/pathfinding in this stage. The former Floor/Erase/Zone
workflow is replaced, not retained as a second editing mode.

Project module occupancy and generated circulation into one floor/area geometry;
derive exterior walls, partitions and access openings from it. Do not persist a
competing editable floor or wall graph. Rendering, picking and placement
validation share geometry, including door/window exclusions. Areas must be
non-overlapping, supported by the projected floor, with
usable access verified structurally rather than through agent movement.

Keep one primary Lobby as fallback. A saved identity may occupy at most one
personal area, with at most one resident per personal area; empty offices are
valid. Active unassigned saved identities appear in the Lobby. Offline identities
retain assignments but are not rendered as active workers. Temporary identities
are Contractors: no personal assignment, automatic room or persistent notebook
entitlement. They can use the Lobby, join meetings, communicate and report status.
Promotion preserves UUID and makes assignment eligible, without building a room.
Retirement removes active projections through the existing lifecycle and does
not erase retained content.

The editor provides Select, Add office, Remove, Style, Walls and Furniture tools,
whole-module preview, undo/redo, explicit Cancel and Save. A selected office's
anchored properties expose its label and optional saved resident. Changing its
purpose through arbitrary zoning is not part of this model. Meeting creation
and membership use their own contextual controls.
Walls and Furniture open the same admitted object catalog, grouped for discovery;
walls themselves remain derived geometry, not a separately painted object layer.
Gestures do not autosave. Undo only affects layout drafts, not messages or
independently saved resource contents.

The revised editing experience is canvas-first: select modules and their eligible
extension slots directly on the world. Preview the entire added module and its
derived connections before accepting it into the draft. Do not make a persistent HTML inspector or a large
configuration modal the primary creation path. Small anchored HTML controls may
serve text entry, accessible choices, resource selection and necessary safety
confirmation. They must preserve the same draft/Undo/Save owner and not resize
the world. Creation cards must use their measured size and the full hologram
bounds to avoid covering the selected module whenever the viewport permits;
keep the name field focused, location selection expandable, and Escape a
non-saving cancellation. Tight viewports retain scrollable, reachable actions.
Wall-height refinement must expose usable interior elevations on
partitions, not merely thicken floor-border lines.

Creation previews are cyan holographic module wireframes, not flat dashed floor
rectangles: show the projected wall height, corner posts, translucent floor grid
and access connection. Keep the preview visible behind its anchored name form.
The same visual language applies to office expansion and the first/next meeting
slot. The deep-space background must have visibly distinct star brightness and
depth; neither stars nor preview glow may require a continuous idle render loop.
One short connecting passage reads as one portal assembly, not two stacked full
door frames. Both logical openings remain available to topology and placement
validation; presentation must not remove physical access edges.

Define one revision-aware commit boundary for topology, dependent placements and
personal assignments. Validate the whole candidate state before atomic commit;
stale revisions fail without overwriting concurrent changes. Keep drafts after
failure and do not silently rebase. Preserve existing room/furniture data through
an explicit tested migration or compatibility projection. Missing world-map data
is not permission to erase old layouts.

For existing v2/v3 module layouts, **Preview modular layout** creates one undoable
v4 draft. The Lobby expands to 2×2 cells; southern office rows and their interior
contents shift one row south. Meeting slots stay fixed. Preserve area IDs,
resident assignments, materials, object IDs and resource attachments. South-wall
Lobby mounts follow the enlarged boundary. Objects without an unambiguous room
interior owner block the preview with their ID; do not guess a new location or
discard them. Save performs normal full placement admission and revision checks.
For free-form v1 layouts, the preview reuses existing eligible module slots to
place personal areas near their former positions relative to the primary Lobby.
Meeting areas enter the separate wing in stable spatial order. Terrain shapes
and corridors become generated module geometry; area IDs, names, assignments and
contents remain. The user reviews this arrangement before Save. Empty areas,
additional Lobbies, ambiguous object ownership and contents too large for their
destination block conversion rather than being discarded. This is not a reset
to the new-install preset and does not create extra identities or offices.

The browser no longer offers free-form floor painting, zoning, new area
designations or manual door editing. Retained layouts can still be inspected,
have objects moved or explicitly removed, and have redundant area designations
removed before conversion. An empty area must be removed explicitly, not silently
dropped. Native Save remains the authority for valid placements. Conversion and
repair share the whole-world history; no map-only history or alternate write
path is retained.

### Module removal is not identity or resource deletion

Show affected area, occupants and objects before confirmation.

- Removing a personal module explicitly unassigns its resident to Lobby, preserving
  identity, notes, appearance, status and exchanges. There is no intermediate
  unzoned-floor editing step. Preview the affected placements and require them to
  be moved or explicitly removed before removing their supporting module; do not
  create a second inventory or silently lose furniture.
- Removing a meeting area detaches its spatial projection, not its canonical room,
  membership, whiteboard, discussion or requests. A future area may bind the same
  room UUID. Core room retirement remains a separate explicitly named operation.
- Removing a module or its derived partition can
  invalidate furniture, windows or doors. Block invalid changes and identify the
  affected instances until the user explicitly moves/removes their placements.
  Never silently crop, discard, relocate or erase contents.
- Removing a placement deletes only that instance, not artwork packs or linked
  resources, and never activates links.
- The primary Lobby cannot be removed without a valid replacement in the same
  draft. Its furnishings and material style are editable. Reject removal that
  disconnects other modules or their meeting-zone connector; keep a valid
  connected floor. The standard preset keeps its Lobby at the center.
- Cancellation changes nothing durable. Invalid or stale drafts cannot partially
  apply assignments, floor or placements.

Large populations use bounded avatar previews, an accessible searchable roster
and jump-to-agent/area controls. Existing positions do not repack as identities
change. Visible-world rendering and bounded caches support expansion; do not
promise unlimited storage or draw all rooms at once.

## Spatial meeting rooms

The starter's main office contains a Lobby and four personal offices. Meeting
rooms belong to a visibly separate, independently extensible meeting zone, not
one fixed room embedded in that office footprint. Group meeting rooms together
and allow further rooms to extend that zone without consuming personal offices
or repacking the main office. Existing meeting modules retain their slot positions
when another is removed. With no meeting modules, show an in-world Add meeting
room affordance; with existing modules, retain an extension affordance. Clicking
it opens an anchored name field. Cancel creates nothing. Canonical creation and
spatial placement are coordinated explicitly: preserve an accepted room UUID if
placement/save fails and retry without creating another room. Never imply that
layout Undo also undoes separately committed room membership or creation.
Show extension/placement in the world rather than
requiring a large configuration modal. This is owner-driven expansion, not
unbounded storage or automatic identity-count growth.

Meeting areas remain parts of the same canonical world with shared circulation;
visual independence does not create a second world database. Position and extent
come from explicit layout, not room-list order. Bind the canonical room UUID and
display its name; core rooms remain usable without a spatial area. The six-room
concept with one central meeting room is superseded and must not drive the preset.
Offer table, chairs, room whiteboard/discussion and broadcast entry as a reusable
starter preset through existing catalogs/bindings. Defaults are presentation until
explicit Save; merely opening a room creates no resources.

Member avatars are projections of the same identity appearance. Showing Alice in
two rooms does not clone her identity, online state, inbox or private notes.
Online/offline is real identity presence; membership is not physical position.
Both an agent's anchored panel and a meeting's member panel offer membership
changes through the same canonical membership owner. Closing/retiring a room and
removing its spatial module are visibly distinct actions; explain retained
history and affected members before a retirement confirmation.
Empty rooms, large rosters, offline members and unavailable artwork need honest,
bounded views and accessible member lists. No walking or proximity listening.

Room whiteboards use the existing document service with a room-bound identifier.
Room discussions extend the existing board scope and storage; do not copy threads
into a new room board store. Default facilities resolve through registered host
bindings like the lobby. Room removal does not delete shared content implicitly.

Discussion scope is an explicit category: general, repository or canonical room
UUID. A room-bound object opens that room's category; moving or rebinding an area
does not retarget the object. Post/list CLI selection uses `--room <uuid-or-name>`
instead of `--general` or `--repo`, with the same unambiguous room resolver as
other commands. Replies inherit their thread's category. New room threads require
an existing room, not membership; unknown room categories cannot silently fall
back to General. Existing content and exact receipts remain retained after room
removal. Switching board scopes must not lose an unsent or unconfirmed operation.

## Background, windows and lights

### Modular material skins

Use a common architectural kit for straight walls, front elevations, left/right
side faces, convex/concave corners, junctions, open door portals and circulation
connectors. A module arrangement owns geometry once; its skin selects surface
art and material parameters only. Shared edges have one deterministic owner,
not two overlapping room sprites. Rendered bounds, occlusion, picking, mounts,
door clearances and native admission derive from that same arrangement.

The default Workshop skin uses teal structural trim, ivory plaster, oak and brass.
Moonlight and Copper are alternate visual targets, not newly installed packs or
shipped settings. Their material changes cannot alter footprints, opening sizes,
assignments, identity UUIDs, room membership or extension bindings. Adjacent
different skins need a deterministic shared crown/connector treatment, not
independently conflicting wall geometry. No executable theme/plugin loader is
introduced by this design.

Use authored wall faces, caps, bevels, contact shadows and bounded local glows;
not just thicker floor outlines. Front and rear walls share the same height;
thick side returns connect them continuously. A foreground wall
has a substantial structural cap, visible vertical face, base shadow and connected
corner posts; a thin floor edging is not an acceptable substitute. Front and rear
are the same wall construction, not different material styles. Foreground
visibility must not be implemented by permanently halving the wall height;
view direction may affect lighting, not introduce a different architectural kit.
While the layout editor is open, the selected area's walls become translucent and corner
posts remain discernible so furniture can be selected and moved behind them.
Leaving the editor restores opacity. This is presentation only: wall height,
support, collision, placement validation and persisted layout remain unchanged.
Door holes must be
physically and visually open. Separately placed windows, lamps, signs and
functional objects remain independently editable across a skin switch.
Names, board contents, live status and action cues are rendered from their
existing owners, never inferred from or baked into decorative pixels.

The [modular visual package](../../docs/office/references/rooms-and-walls/modular-v1/README.md)
owns the art inventory and visual acceptance details. Generated sheets are source
art, not admitted sprite atlases; verify alpha, extraction, authored scale,
directional views, palette bounds and seam alignment before runtime integration.
No source sheet may bypass the existing data-only custom-art boundary.

### Backdrop and mounted objects

Use a quiet dark-space backdrop: sparse stars, low-contrast nebula, prominent warm
interiors and readable cream HUD. Default to static rendering, without continuous
star animation, parallax or live lighting/shadow simulation. Background is
presentation, not terrain or authority; changing it never changes floor data.

Show construction grid/handles only in edit mode. Use visible-world projection,
bounded reusable textures, local baked lamp glows and invalidation-driven painting.
A Motion selector in a concept is not a requirement to ship animation or a theme
marketplace. Decorative celestial scenery is not another simulated world.

Windows and wall lamps are admitted mounted objects, not baked into every room.
Windows require an outward-facing exterior segment and a bounded scene matching
the Office backdrop. Lamps have independent placement and limited glow. Validate
overlap and door/window clearance. Turning an exterior wall into a partition
must not silently retain an invalid window.

## Wall workshop

Add a versioned placement surface discriminator and wall-local coordinates to
the existing layout contract. Share geometry for painting, picking, bounds,
door/window exclusions and editing. Keep floor coordinates unchanged. Start with
the visible interior back/side wall surfaces; present an explicit unsupported
surface error rather than flattening an object onto the floor.

Separate baked architectural windows/lights from editable mounted objects before
offering them as individually editable. Preserve existing room appearance and
saved layouts during migration. Initial items include posters, signs and small
indexed-pixel artwork; mounted boards retain the same functional resource binding
as freestanding boards. Art authoring uses the admitted pack/palette pipeline,
including a bounded browser pixel editor, preview, validation and explicit Save.
Do not create an unrestricted remote-image or HTML/SVG upload path.

An optional link is an explicit data-only action, separate from image pixels and
resource contents. Admit absolute HTTP(S) URLs only; reject credentials, control
characters and executable/file/data schemes. Show destination origin and an
external-link cue before activation. Only a deliberate user click opens a new
tab with no opener; rendering/importing never fetches or follows the link.
Agent-visible descriptions cannot grant tool execution. Link handling joins the
existing guarded interaction path rather than a renderer-owned click handler.

Offer bundled poster, text-sign and external-link objects. Existing whiteboard,
discussion, broadcast and saved-notebook entry points use admitted host bindings,
not shell commands. A notebook view reuses the saved-identity notes owner through
an explicit bounded interface, never arbitrary file access or another notes
database. Contractor objects cannot bypass eligibility. Functional objects use
consistent action cues; decorative text/pixels confer no executable capability.
Keep custom artwork validation and safe missing-art fallback.

## Agent status and mood

Expose one identity-owned typed projection shared by CLI and Office: short
self-reported activity, optional mood, update time and stale/expiry behavior.
The [identity status contract](../identity-status-v1.md) defines its commands,
atomic record and expiry rules. Do not copy status
into rooms or another scene registry. Observed endpoint presence stays separate
and never implies execution. Self-reported availability is not dispatch authority.

Saved and active temporary identities can report status. Omitted identity uses
existing verified caller resolution; non-tmux callers select explicitly. Define
bounded set/show/clear operations in the existing grammar and output contract,
then update help/skills. Do not advertise speculative command syntax as shipped.

Display name, small presence indicator and one short activity/mood bubble; stale
activity must not appear current. Details include update time. Reply-ready
attention takes priority rather than stacking bubbles. Unknown and offline states
remain honest; enqueue acceptance never creates fake typing/working signals.

## Direct communication from Office

Selecting an agent offers Message; a room offers Message room. Use the same
typed submission, result, timeout and error models as CLI adapters. Keep direct
and room destinations explicit, and display the exact fan-out audience before
send. Queue acceptance, read/ack, reply, timeout and unavailable are distinct.
Direct messaging is an ordinary chat input with message/reply bubbles: Send or
Enter submits, Shift+Enter adds a newline, and no second review screen is needed.
The compact agent-anchored HUD has Chat and Info. An absent/offscreen actor uses
a viewport fallback. Minimize submitted interaction to a truthful waiting/reply
cue; reopen on deliberate click. Overlays never resize the world.
Operation receipts remain internal; room fan-out retains explicit audience
confirmation. The local Message room entry uses the shared request composer;
these reference images are not implementation evidence. Overall visual and
end-to-end acceptance remains a separate gate.

The Message room entry opens a room-scoped request composer, not the announcement
station. Read the canonical roster, explicitly adopt it, then review the room,
revision, exact message and recipients before sending. Offline members remain
eligible; absent rooms and empty rosters cannot silently fall back to global agents.
Roster changes require rereading and re-preview, never automatic audience expansion.
Closing retains the room draft. Changing room protects a draft and blocks abandoning
an unresolved send until recovery or explicit discard. Reuse the pending-intent
journal with separate direct/roster scopes; a reload checks the same operation's
receipt rather than dispatching again. Removing the spatial area does not remove
the canonical room, its accepted requests or their replies.

The conversation view projects canonical request/reply records, not mirrored
chat messages. Browser result observation is bounded, cancellable and paused
when hidden or closed; minimizing retains bounded observation. Directory browsing
and layout editing suspend the retained HUD, and overview refresh preserves its
unsent draft. Never infer completion from terminal output or fake typing.
Reload/reopen must recover accepted requests and replies from durable storage.
An uncertain submission retries its original operation, never silently duplicates.
Existing loopback bearer/Origin/input limits remain in force; no generic command
executor is exposed. Remote HTTP/MCP deployment is not part of this local stage.

## Delivery and verification

1. Use the current modular visual package for composition, materials and operation
   states. This document controls semantics; freeform floor painting and zoning,
   independent room islands and identity-generated expansion are superseded.
2. Inspect current owners and tests; preserve verified room/context CLI, direct
   history, retry and fan-out work rather than replacing them with UI-only state.
3. Implement world topology/areas/occupancy and existing-layout migration. Integrate
   the editor and renderer through one geometry/revision owner.
4. Add wall placement, windows, lamps, pixel-poster authoring and safe link actions
   with native/browser conformance and existing artwork/extension bindings.
5. Integrate canonical meeting resources, default facilities, status/mood, compact
   direct chat and explicit room audiences. Verify CLI/browser interoperability.
6. Refine real desktop/narrow renders against the reference hierarchy; update
   architecture, canonical installed skills and help to actual behavior.

Acceptance must include:

- Default Lobby plus four unassigned offices versus saved layouts; module-slot
  cardinal expansion/connectivity; empty and
  overlapping areas; no automatic growth; save/reload/restart and old-data migration.
- Saved assignment, Contractor rejection, unassigned/offline views, promotion and
  retirement, multiple meeting memberships and UUID-preserving projections.
- Module removal versus resource retention; last-Lobby protection; affected
  furniture/wall/window handling; undo/cancel; invalid/stale-save atomicity.
- Wall/art/link admission and custom-art fallback; explicit user-click-only
  HTTP(S) links; saved-only notes; no arbitrary file or executable plugin access.
- Status update/expiry, honest presence, reply bubble priority, direct-only sends,
  explicit room audience, exact operation retry and no duplicate requests.
- Real browser send to inbox, real CLI reply, browser result/reopen and durable
  recovery, plus scoped room CLI and real-tmux regression where relevant.
- Keyboard/pointer and narrow screens, long names, crowded Lobby, missing art,
  visible-area culling/cache disposal and no unnecessary idle render loop.

Use isolated native/browser fixtures, deterministic mock agents and local checks,
not paid AI calls. Keep test evidence and per-run logs outside user manuals.
Update existing canonical skills for core room creation/membership, Office layout,
wall/prop authoring, status and passive inbox use; avoid duplicate provider copies.
Remove obsolete visual instructions from the active reference set; preserve any
unique retained functional requirements in their owning contract.

Complete the full consolidated outcome, not just one slice or attractive mockup.
No new remote transport/MCP, cross-office networking, multi-floor construction,
autonomous movement/proximity chat, arbitrary executable plugins or separate
memory/search engine belongs to this local scope. Do not replace the user's
running preview, commit, push, release or reinstall globally under this design task.
