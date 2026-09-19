# Workshop visual reference

These retained interaction concepts are not product screenshots or proof that a
feature exists. The [modular reference](../rooms-and-walls/modular-v1/README.md)
owns current building geometry, materials and HUD styling. The
[functional-extension contract](../../../../contracts/office/functional-props.md)
owns behavior; this reference set owns visual intent.

| Reference                                                 | Required visual relationship                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Furniture customization](02-furniture-customization.png) | Contextual tools, art thumbnails, positioning/direction, rug tint/text, explicit Save                     |
| [Whiteboard review](03-whiteboard-review.png)             | Floating drawing surface, selection/annotation, explicit agent-or-room request, versioned reference       |
| [Discussion board](04-discussion-board.png)               | Physical lobby entry, floating list/detail, General/repository categories, posting distinct from dispatch |

Preserve honey-oak floors, deep teal structure, cream panels, moss textiles,
terracotta seating and rich readable pixel-art furniture. Uniform room shells
and simplified/static lighting are acceptable. A flat dashboard or geometric
placeholder artwork is not visual alignment.
Walls must read as cutaway building fabric: visible thickness, top/end faces,
recessed doorways and foreground occlusion, with material detail matching the
pixel furniture. Thickening a flat outline alone does not meet this reference.
Keep side-wall crowns distinct from inward-facing reveals. Front and rear walls
retain equal height; obstructing faces fade during arrangement without moving
floor coordinates or the camera. Do not derive wall height from the older
interaction illustrations.

Interactive objects deliberately stand out from decoration: contrasting sci-fi
teal docking outlines and high-contrast action markers are welcome against
the warm room. They remain visible before hover; focus reveals a clear action
label. Keep pixel edges crisp and the idle scene still. The
[interaction contract](../../../../contracts/office/functional-props.md#interaction-affordance)
owns availability and input behavior; this is not permission to imply unsupported
actions with decorative lights or badges.

HUD overlays never shrink or refit the world. Selection opens one contextual
inspector; closing restores the office. Desktop/narrow layouts retain keyboard
access and readable controls. Incidental mock labels, counts, character limits,
decorative rooms and sample conversations are not domain requirements.
Recipient modes are exclusive; unread indicators require real read-state support.
Room browsing keeps furniture tools closed until Arrange is chosen. Appearance
uses that same inspector position, not a second simultaneous sidebar. Dirty layout
actions remain visible when the inspector closes. Functional props work in browse
mode; a compact Objects disclosure provides the equivalent keyboard/fallback entry.

Generated with the built-in imagegen tool. These are documentation assets, not
runtime scene textures. Superseded overview artwork and generation transcripts
are not part of the current reference set.

## Whiteboard artwork

The [generated whiteboard source](whiteboard-source-v1.png) supplies the textured
oak frame, metal joints, marker tray and four upright views. The runtime uses the
[indexed v2 pack](../../../../contracts/office/whiteboard-props-v2.tmtprop.json),
not a geometric placeholder or the source image. Its resource binding, footprint
and host-drawn interaction cues remain separate from the art. See the
[prompt and mechanical compilation notes](whiteboard-art-prompt.md).

## Broadcaster artwork

[Generated source](broadcaster-sprite-source-v1.png) supplies four directional
views of an oak-and-teal microphone station. It was generated with the built-in
imagegen tool, then mechanically downsampled and palette-indexed into the runtime
[v2 pack](../../../../contracts/office/broadcaster-props-v2.tmtprop.json), four
64×64 frames. The image contains appearance only; the host adds action cues.
The prompt requested: "A transparent four-view pixel-art sprite sheet for a warm
office broadcast station: oak cabinet, dark teal control panel, mint display,
speaker grille, brass knobs and gooseneck microphone. South, west, north, east
views; consistent scale; no text, UI, people or room background."

## Study furniture artwork

The [study pack](../../../../contracts/office/study-furniture-v2.tmtprop.json)
adds a bookcase, reading lamp and desktop terminal without changing earlier
immutable packs. Each has four upright South/West/North/East frames at eight
source pixels per tile. The sources were generated with the built-in imagegen
tool, then mechanically downsampled and palette-indexed together; runtime uses
247 palette entries and 141,789 source bytes, not the original large images.

- [Bookcase source](bookcase-source-v1.png): honey oak, three shelves of warm
  colored books, bottom cupboard and trailing plant; 96 × 96 pixels per view.
- [Reading lamp source](reading-lamp-source-v1.png): moss enamel shade, brass
  stand and dark teal base; 64 × 64 pixels per view. Its light is baked artwork,
  not a dynamic lighting effect or an interactive capability.
- [Desktop terminal source](desktop-terminal-source-v1.png): teal monitor,
  cream keyboard and mouse; 48 × 48 pixels per view. It is decoration, not a
  terminal executor. Like other furniture, it receives no functional action badge.

The [generation prompts](study-art-prompts.md) retain the final prompt set.
The local furniture palette composes these admitted packs; the empty-room starter
uses the same placement records as individual Add actions. It is an editable
suggestion, never an automatic replacement for an existing room.

## Detailed robot artwork

The [generated source](robot-source-v2.png) is mechanically reduced to the
[32×48 v2 robot pack](../../../../contracts/office/workshop-robot-v2.tmtavatar.json).
The runtime consumes its 133-entry indexed palette, not the large PNG. Native
pack validation and browser admission accept the same file. Source alpha is
normalized to the format's transparent/opaque cells without a backdrop.

Stored appearance choices tint named shell/body palette slots; accessory
silhouettes are composited on their existing two-pixel grid. Fixed visor, eyes,
brass joints and chest label remain separate. These defaults do not override
installed custom avatar references. See [source prompts](robot-art-prompts.md).
