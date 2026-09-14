---
name: tmt-prop-create
description: Create and validate bounded data-only TMT Office prop-pack JSON files; use for custom local Office furniture or prop artwork, not executable extensions or remote assets.
---

# Create TMT Office props

Produce one UTF-8 `.tmtprop.json` document that follows
`contracts/office/prop-pack-v1.md` in the current tmux-team source tree. A prop
pack is ordinary indexed-pixel data. Never add scripts, markup, URLs, external
asset references, filesystem paths, prompts, tools, or executable behavior.

Keep the source within 128 KiB and the v1 limits: at most 16 props, a palette of
at most 16 lowercase `#rrggbbaa` colors whose first entry is transparent
`#00000000` and whose remaining entries are opaque, raster dimensions at most 64 by 64, and
footprint dimensions from 1 through 8. Use unique lowercase keys matching
`[a-z][a-z0-9-]{0,31}`. Each pixel row is a same-width lowercase hexadecimal
index string, and every index must exist in the palette.

Validate the completed file with the installed companion:

```sh
tmt office prop validate --file <pack.tmtprop.json> --json
```

Treat the returned digest as the identity of the exact bytes. Do not hand-edit
or predict it. Validation is read-only. Preview only when the user asks and the
local Office service is already running; do not start or restart it implicitly:

```sh
tmt office prop preview --file <pack.tmtprop.json> --json
```

Preview is temporary and does not install the pack. Installing or replacing
catalog content is a separate mutation requiring the user's authorization and
the current catalog revision. On a conflict, reread and reconcile instead of
advancing the revision automatically.
