# Local presentation profile v1

Implemented for local Office in #212. Local SQLite is authoritative. Remote
publication and authorization remain M2 (#242).

## Commands and identity

```sh
tmt office profile show --local --identity Alice --json
tmt office profile apply --local --identity Alice --file profile.json --if-revision 0 --json
```

Use the existing verified caller resolver when `--identity` is omitted. Missing
or ambiguous context fails rather than guessing. Both commands require an active
existing identity. They work while the browser service is stopped. `--local` is
explicit; no implicit pairing, publication or fallback to a remote world.

## Input

Apply replaces this complete exact object; unknown or missing fields reject:

```json
{
  "displayLabel": "",
  "description": "Architecture review",
  "appearance": {
    "hairStyle": "short",
    "hairColor": "ink",
    "skinTone": "medium",
    "shirtColor": "blue",
    "shirtMark": "AI"
  }
}
```

`displayLabel` is at most 80 UTF-8 bytes; empty means the current identity name.
`description` is at most 1024 UTF-8 bytes and may contain LF and TAB. `shirtMark`
is at most 16 UTF-8 bytes, including an empty string, short text or emoji.
Other control characters reject; label and mark also reject LF and TAB. Never
truncate, interpret markup or load resources from these strings. Render them as
plain text with a bounded visual area and accessible full text. No image, URL,
path, SVG, executable content or arbitrary color field exists. File input is
bounded to 8 KiB before parsing.

Catalog identifiers are case-sensitive:

- Hair styles: `short`, `bob`, `curls`, `tied`, `bald`.
- Hair colors: `ink`, `brown`, `gold`, `silver`.
- Skin tones: `light`, `warm`, `medium`, `deep`.
- Shirt colors: `blue`, `green`, `clay`, `plum`, `gold`, `ink`.

Rendering uses curated repository primitives. The catalog definition and literal
conformance vectors are shared boundaries, not independently invented adapter
inventories. A read returns allowed values so agents can discover valid options.

## Resource and defaults

Persist one independent profile row per immutable identity UUID, with revision,
canonical profile and update time. Do not embed it in layout JSON, identity
metadata, role instructions or the Markdown notebook.

Without a stored override, show returns `exists:false`, revision 0 and a
deterministic default without writing. Defaults use the UUID's first three
decoded bytes modulo the ordered hair-style, skin-tone and shirt-color catalogs;
hair color is `ink`, label/description/mark are empty. The same UUID always yields
the same default. No randomness, model call or clock is involved.

Read output contains identity ID/name, `exists`, `revision`, `profile`,
`updatedAtMs` (null for an implicit default), and the bounded `catalog`.
Human output identifies the identity, revision/default status and profile fields.
Apply adds `changed` to that canonical snapshot. Display labels never become
lookup keys; show the actual identity name alongside a customized label.

## Writes and lifetime

Reuse the existing immediate transaction and active-identity check. Revisions
are JavaScript-safe positive integers for stored rows. Revision 0 creates the
first explicit override at 1, including an explicit save of the default.
At the expected revision, identical canonical content is a no-op. At expected+1,
identical content is an exact retry, preserving revision and timestamp. All other
stale writes conflict. Never automatically advance the caller's expected revision.

An uncertain write may have committed: retain the original file/draft and
revision, reread and compare. Missing/retired identities, invalid data and revision
conflicts are distinct failures using the existing Office error conventions.
No profile edit changes identity, role, permissions, layout, notes or position.
Retirement retains the row but excludes it from active projection. A replacement
with the same name receives neither the old override nor its ownership.

## Browser and verification

Add a typed profile port to the existing local runtime, sharing authentication,
origin checks and cancellation. Native and browser mutations invoke the same
domain service. Preserve block response compatibility and independent revisions.

Active identities without layouts appear in a read-only avatar preview/selector;
do not create a persisted block on discovery. Reuse a curated avatar renderer for
preview and scene. Hair/clothing/mark differences and the name above the avatar
must be visibly legible. Offline saved identities are not presented as online.
Draft edits do not write until Save and survive refresh/conflict/uncertainty.
Furniture selection remains independent. Movement and social sessions are #179.

Verify literal valid/invalid vectors in native and browser layers; default
read-without-write, CAS/no-op/retry, retirement/replacement, protected local HTTP
access, safe text and unchanged unrelated resources. Integrated proof uses real
CLI -> SQLite inspection -> browser display -> restart, without cloud accounts
or paid agents. Include desktop and narrow screenshots before visual acceptance.
