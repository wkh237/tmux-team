# Native pairing v1

Implementation contract for #222. Deployment discovery is implemented;
public pairing and protected credential use are not yet shipped.
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

## Planned command and credential contract

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
status is local-only. Inspect reads the assigned block, not a world-wide index.

A stable installation UUID is independent of release receipts. Nonsecret binding
metadata lives under ConfigPaths, not a second identity registry. Protected
records bind origin, descriptor, world, installation and identity UUID, validated
on every read. Store the pending proof before exposing an approval link. No token
belongs in config, SQLite or logs. Missing/locked storage fails closed; no sample
or plaintext fallback. OS storage and metadata are not one atomic transaction.

Office failures use the existing envelope and exit 1:
`OFFICE_DEPLOYMENT_INVALID`, `OFFICE_DEPLOYMENT_CHANGED`,
`OFFICE_CREDENTIALS_UNAVAILABLE`, `OFFICE_CREDENTIALS_INVALID`,
`OFFICE_NOT_PAIRED`, `OFFICE_PAIRING_PENDING`, `OFFICE_PAIRING_EXPIRED`,
`OFFICE_REMOTE_DENIED`, `OFFICE_REMOTE_UNCERTAIN`. Interruption uses
`OFFICE_INTERRUPTED`, exit 130. Existing identity/grammar errors retain their
owners. An unavailable claim cannot distinguish absent from denied approval.

Renewal preserving resources, reassignment and temporary retirement/offline
revocation remain #209 requirements. Token refresh never extends a grant lease.
Actual native/browser/isolated-vault evidence is required by the
[local-first acceptance contract](../../DEVELOPMENT.md#personal-office-milestone-acceptance).
