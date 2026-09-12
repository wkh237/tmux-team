# Native pairing v1

Implementation contract for #222 and renewal slice #227. Source builds implement deployment discovery,
pairing and protected credential use; no public Office release is published.
[Approval and claim](pairing-v1.md) owns remote proof/consent semantics.

## Deployment discovery

The caller selects a canonical world URL:
`https://office.example/worlds/abcdefghijklmnopqrst`. Discovery reads only that
origin's `/.well-known/tmt-office.json`, without redirects or credentials.
The descriptor is JSON, at most 4096 UTF-8 bytes, with exactly these fields:

```json
{
  "version": 1,
  "mode": "cloud",
  "projectId": "example-office",
  "apiKey": "public-web-api-key",
  "pairingUrl": "https://issuer.example/officePairing"
}
```

The SPA derives this allowlisted projection from its existing validated Firebase
and pairing configuration, not a second settings file. Preview and cloud without
an issuer publish no usable descriptor. Invalid configured deployments fail the
build. Publishing metadata does not activate the issuer or grant world authority.
No private environment values, credentials or identity data are included.

Project IDs use the existing Firebase format and exclude `demo-` in cloud mode.
API keys are 1..256 ASCII alphanumeric, hyphen or underscore characters. URLs are
canonical absolute HTTPS, at most 2048 bytes, with no user information, query or
fragment. The browser's configured URL may have one trailing slash; its descriptor
and operation base omit that slash. The literal corpus includes an origin-only
issuer to pin this projection. Native URL interpretation uses
the URL Standard, matching the browser; normalization cannot change a target.
Auth and Firestore endpoints come from the fixed Firebase API contract, never
arbitrary descriptor fields. Unknown and duplicate JSON fields reject.

Explicit emulator selection accepts only a canonical `http://127.0.0.1:<port>`
world origin, `demo-tmt-office` project/key, and the fixed issuer
`http://127.0.0.1:5001/demo-tmt-office/us-central1/officePairing`. Auth and Firestore
remain fixed loopback demo services. Cloud and emulator descriptors cannot be
interchanged. This is not a general insecure-HTTP switch.

The website origin and complete descriptor become part of the credential scope.
Local status and credential reuse do not rediscover endpoints. A changed
deployment cannot retarget an existing proof or credential. Discovery has a
10-second budget within the command deadline; reject redirects, non-JSON responses
and oversized headers/bodies before use.

## Command and credential contract

```sh
tmt office pair --world <url> [--identity <name>] [--read-only] [--timeout <seconds>]
tmt office status --world <url> [--identity <name>]
tmt office inspect --world <url> [--identity <name>]
```

These retain existing Office prefix/output conventions. Names resolve through the
existing active identity UUID owner; omission requires a verified bound pane.
No folder guessing, same-name inheritance or temporary-identity promotion.
Explicit `--emulator` selects the fixed local environment on each operation.
Pair requests layout read/write unless `--read-only`. Timeout is integer seconds
1..300, default 300; retries retain the original proof/deadline and five-second
poll floor. Human mode prints the public approval URL before polling. JSON mode
puts that URL on stderr and one final object on stdout. No secret enters output
or argv. Unqualified status retains installation-only behavior; world-qualified
status is local-only and returns `unpaired`, `pending`, `credential` or `expired`,
with `serverAuthorizationChecked: false`. Inspect performs a server-authorized
read of the assigned block, not a world-wide index. Its result is
`blockExists: true|false` with `serverAuthorizationChecked: true`; it does not
return or interpret layout contents. Missing pairing fails `OFFICE_NOT_PAIRED`.

A stable installation UUID is independent of release receipts and binary prefixes:
one logical installation per ConfigPaths root. Only that public UUID and scope
locks live in its `office/` directory; there is no disk binding index or second
identity registry. Missing or corrupt metadata is not automatically regenerated
inside an existing installation. One protected record per origin/world/mode/
installation/identity UUID pins the complete descriptor, immutable approval and
pending proof/deadline/cadence or paired credential/resource lease, validated
on every read. Store the pending proof before exposing an approval link. No token
belongs in config, SQLite or logs. Missing/locked storage fails closed; no sample
or plaintext fallback. Linux uses Secret Service on the session bus; macOS uses
the user Keychain. Each write requires exact readback before reporting success.
The per-scope lock serializes mutation; local status reads one protected snapshot
without creating locks. OS storage and metadata are not one atomic transaction.
Uncertain claim or publication retains the original scope for retry. Expired
pending approvals fail closed without silently requesting another grant;
paired resource access can renew its existing lease as described below. Do not delete local state as a
substitute for server revocation.

Auth exchange and refresh use fixed Firebase endpoints. ID-token payload checks
detect inconsistent scope but are not signature verification or authorization;
Firestore Rules enforce every resource request. Token refresh alone preserves the
original resource assignment and grant expiry. Identity names resolve once to an
active UUID and are rechecked before protected publication and resource use.

Office failures use the existing envelope and exit 1:
`OFFICE_DEPLOYMENT_INVALID`,
`OFFICE_CREDENTIALS_UNAVAILABLE`, `OFFICE_CREDENTIALS_INVALID`,
`OFFICE_NOT_PAIRED`, `OFFICE_PAIRING_PENDING`, `OFFICE_PAIRING_EXPIRED`,
`OFFICE_REMOTE_DENIED`, `OFFICE_REMOTE_UNCERTAIN`. Interruption uses
`OFFICE_INTERRUPTED`, exit 130. Existing identity/grammar errors retain their
owners. An unavailable claim cannot distinguish absent from denied approval.

Reassignment, lost-credential recovery and temporary retirement/offline
revocation remain #209 requirements. Token refresh never extends a grant lease.
Actual native/browser/isolated-vault evidence is required by the
[local-first acceptance contract](../../DEVELOPMENT.md#personal-office-milestone-acceptance).

## Invocation-owned renewal

`inspect` refreshes Auth when necessary, then renews a paired lease with five
minutes or less remaining (including expiry) through the authenticated issuer
operation in [pairing v1](pairing-v1.md#lease-renewal). There is no scheduler,
new approval link or daily browser prompt. Local `status` never renews or makes
a network request. `pair` retains its existing acquisition behavior.

The native request supplies the protected record's exact last grant expiry.
Readback must match version, pairing, world, installation, identity, principal,
block and capabilities, and cannot roll the expiry backward. Unknown/duplicate
fields reject. The service owns lease bounds; native never computes a new expiry.
Only the validated server value is written back through the existing protected
record and readback owner. A lost response retains the old lease for retry;
another caller's newer lease is recovered without extending it again. If that
recovered lease has itself expired, resource use still fails expired; a later
invocation can renew using the recovered expiry. Each invocation is bounded,
not an automatic retry loop. Denied, malformed or uncertain renewal never
authorizes resource use or creates a replacement pairing.
