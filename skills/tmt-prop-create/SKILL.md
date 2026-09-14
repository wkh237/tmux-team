---
name: tmt-prop-create
description: Create and validate bounded data-only TMT Office prop-pack JSON files; use for custom local Office furniture or prop artwork, not executable extensions or remote assets.
---

# Create TMT Office props

Produce one UTF-8 `.tmtprop.json` document. A prop pack is ordinary indexed-pixel
data. Never add scripts, markup, URLs, external asset references, filesystem
paths, prompts, tools, or executable behavior. Use exactly these fields:

```json
{
  "formatVersion": 1,
  "label": "Signal set",
  "credit": "Example artist",
  "license": "CC0-1.0",
  "palette": ["#00000000", "#ff5533ff"],
  "props": [
    {
      "key": "signal-lamp",
      "label": "Signal lamp",
      "footprint": { "width": 2, "height": 2 },
      "pixels": ["010", "111", "010"]
    }
  ]
}
```

Keep the source within 128 KiB and the v1 limits: 1–16 props; a palette of 1–16
lowercase `#rrggbbaa` colors whose first entry is transparent `#00000000` and
whose remaining entries are opaque; raster width and height from 1 through 64;
no more than 65,536 total raster cells; and footprint width and height from 1
through 8. Root `label`, prop `label`, and `credit` are non-control UTF-8 text;
labels are 1–80 bytes and credit is 1–120 bytes. `license` is 1–64 ASCII letters,
digits, `.`, `+`, or `-`. Use unique lowercase keys matching
`[a-z][a-z0-9-]{0,31}`. Each pixel row is a same-width lowercase hexadecimal
index string, and every index must exist in the palette. Unknown or duplicate
fields reject at every level.

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

Preview is temporary and writes neither the catalog nor a block. Discover the
current catalog revision, install with authorization, and confirm the immutable
digest:

```sh
tmt office prop list --local --limit 20 --json
tmt office prop install --local --file <pack.tmtprop.json> --if-revision <catalogRevision> --json
tmt office prop show --local <sha256:digest> --json
```

To place a validated prop, first read the identity's block. Copy only its exact
`.layout` object into `layout.json`, add a v2 object using the returned immutable
`<digest>/<key>` reference and the definition's exact footprint, then apply with
the block revision:

```json
{
  "version": 2,
  "objects": [
    {
      "prop": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/signal-lamp",
      "footprint": { "width": 2, "height": 2 },
      "x": 4,
      "y": 6,
      "rotation": 0
    }
  ]
}
```

```sh
tmt office block show --local --identity <name> --json
tmt office block apply --local --identity <name> --file layout.json --if-revision <blockRevision> --json
```

On a revision conflict, reread and reconcile; never advance a revision
automatically. Removing a pack is another authorized catalog mutation:

```sh
tmt office prop remove --local <sha256:digest> --if-revision <catalogRevision> --json
```

Removal never rewrites saved layouts. Existing references render bounded
unavailable placeholders; reinstalling the exact original bytes restores them.
