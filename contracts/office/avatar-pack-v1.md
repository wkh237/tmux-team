# Office avatar pack v1

Status: implemented for strict local admission, catalog storage, preview, profile selection
and unavailable-selection fallback.

An avatar pack is one UTF-8 `.tmtavatar.json` regular file of at most 32 KiB. Readers
must not follow symbolic links and reject a UTF-8 BOM, invalid UTF-8, duplicate JSON
members, and members not named below.

The root has exactly `formatVersion`, `label`, `credit`, `license`, `palette`, and
`avatars`. `formatVersion` is `1`. `label` and avatar labels contain 1–80 UTF-8 bytes;
`credit` contains 1–120. Those strings reject control characters. `license` contains
1–64 ASCII letters, digits, `.`, `+`, or `-`.

`palette` contains 1–16 lowercase `#rrggbbaa` entries. Entry zero is exactly
`#00000000`; every later entry has alpha `ff`. Each of 1–16 avatars has exactly `key`,
`label`, and `pixels`. Keys are unique and match `[a-z][a-z0-9-]{0,31}`. `pixels` is
exactly 24 rows of 16 lowercase hexadecimal palette indices. Every index resolves and
each avatar has at least one nontransparent cell. A pack contains at most 6,144 cells.

The immutable pack digest is lowercase SHA-256 over these bytes in order:

1. `TMT-OFFICE-AVATAR-PACK-V1\0` as ASCII bytes;
2. the exact file byte length as an unsigned eight-byte big-endian integer;
3. the exact original file bytes.

The digest is written as `sha256:<64 lowercase hex>`. An avatar reference appends `/`
and its key. Avatar digests and catalog cursors use a namespace distinct from props.
Catalog capacity is 64 retained packs and 256 retained avatars. Corrupt retained rows
still consume capacity and may be explicitly removed. Catalog revisions, conditional
mutations, exact retry, pagination, and stale-cursor behavior follow the typed local
avatar protocol; they never change the prop catalog revision.

Preview requires an already-running authenticated loopback Office service, is bounded
and expiring, and does not install a pack or alter a profile. Raster data is validated
before reaching the inert indexed renderer; labels and credits remain untrusted text.

The optional profile `avatarRef` is exactly `<digest>/<key>`. Selecting a new reference
requires the installed catalog row and key in the same immediate transaction as the profile
write. Removing a pack never edits profiles. A retained missing or corrupt reference renders
the profile's stored default robot appearance, and exact reinstall restores the art without a
profile revision change. The browser receives one bounded authenticated catalog projection at
startup; animation, movement, arbitrary URLs and runtime plugins are outside this contract.

[`avatar-pack-vectors.json`](avatar-pack-vectors.json) contains shared projection
values. It does not claim to test duplicate-member, raw-byte, file-kind, or symlink
admission; those remain native raw-input tests.
