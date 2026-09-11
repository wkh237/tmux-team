# Pairing approval and claim v1

Implementation target for #218. Native commands, browser assignment UI and
production activation are separate gates; no currently installed command is
promised by this contract.

## Proof and consent

The originating native installation generates 32 cryptographically random bytes.
The claim secret is their canonical unpadded base64url encoding (43 characters).
`pairingId` is the lowercase hexadecimal SHA-256 digest of those original bytes.
Only the public pairing ID and bounded requested binding appear in the browser
link fragment. Never put the secret, an ID token or a refresh token in a URL,
ordinary output, log or browser request for owner approval.

There is no unauthenticated durable "begin" write. The admitted human owner must
approve the exact installation/identity/world and layout capability selection
before the service creates a pairing record. Display labels are untrusted
presentation, not evidence of local identity or authority. The native client must
also compare the claimed binding with its own expected values before storing
credentials. A comparison code or copied link alone does not prove possession.

## HTTP operations

The service accepts JSON POST operations under its explicitly configured base
URL. Bodies are bounded to 4 KiB, reject unknown fields and use `version: 1`.
Application responses are JSON with `Cache-Control: no-store`; errors contain a stable code,
not raw Firebase errors, secrets or paths. Requests never accept an actor UID as
authentication. Browser cross-origin access requires an exact operator-approved
origin; it never authorizes a caller. Non-browser requests may omit `Origin`;
bearer authentication and live ownership checks still apply. Malformed HTTP/JSON
rejected by the Functions platform before the handler follows platform responses.

| Operation  | Input                                                                                                        | Authority and result                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `/approve` | `pairingId`, `worldId`, `installationId`, `identityId`, `installationLabel`, `identityLabel`, `capabilities` | Verified Google bearer ID token, current tester admission and world ownership; returns approved binding and five-minute expiry  |
| `/claim`   | `secret`                                                                                                     | Original proof; returns the same logical principal, resource grant and a Firebase custom token while the approval remains valid |
| `/revoke`  | `pairingId`                                                                                                  | Verified admitted owner; atomically disables the approval and any issued grant, retaining resources                             |

UUIDs use the grant v1 lowercase hyphenated format; world IDs are 20
alphanumeric characters. Labels are 1..80 Unicode scalar values, nonblank,
without control characters. Capabilities are exactly the ordered layout lists
in [agent grant v1](agent-grant-v1.md). No arbitrary paths or additional resource
permissions are accepted.

Missing/invalid human authentication is `401 UNAUTHENTICATED`; invalid input is
`400 INVALID_ARGUMENT`; unauthorized approval/revocation is `403 PERMISSION_DENIED`.
Claims with wrong/unknown proof, expired/disabled approval or lost owner/grant
authority return `404 PAIRING_UNAVAILABLE`, without disclosing world details.
Approval retries return the same unavailable error for expired/disabled records
or an invalid issued grant, after human admission/ownership is checked. Changed input for an
existing authorized pairing is `409 PAIRING_CONFLICT`. Known-proof claims are
limited to one reservation per five seconds (`429 RETRY_LATER`). Failed external
credential minting is `503 UNAVAILABLE`, not a success or permission to allocate
another identity. Unsupported method is `405 METHOD_NOT_ALLOWED`; oversize input
is `413 INPUT_TOO_LARGE`.

## Durable ownership and recovery

`officePairings/{pairingId}` is service-only; Rules deny all client access. Its
versioned record owns approved immutable input, human owner, generated principal
UID and independent block UUID, creation/expiry timestamps, `enabled`, `claimed`
and `nextClaimAt`. Clients cannot select the generated principal/block IDs.

Approval retries return the existing record only for the same owner and exact
input before expiry. They never extend the deadline or re-enable a record.
Revocation is deliberately idempotent for an admitted owner, even after approval
expiry: the longer-lived resource grant must remain revocable. Unknown/malformed
records, another owner and lost admission all return permission denied.
The first claim transaction creates exactly one [agent grant](agent-grant-v1.md)
and marks the approval claimed. Later authorized retries reuse that grant and
its original expiry; missing or disabled grants are never reconstructed.
"One-time" means one logical approval/assignment, not an unrecoverable one-shot
HTTP response. A holder of the original secret can retry during the same short
claim window after a lost response. No automatic retry after that window.

All ownership, admission, expiry and grant checks participate in the Firestore
transaction. IDs are selected once outside transaction retries; time is sampled
within each attempt. Custom-token signing is outside the transaction. After
signing, recheck current approval/grant authority before responding. Revocation
can still race the final response, but live Rules deny use of a revoked grant;
do not claim to recall issued bytes or cancel prior writes.

An issuer error may leave a reserved grant with no delivered credential. Retry
uses the same principal and resource rather than manufacturing a second grant.
The service keeps expired/disabled records as tombstones in this slice: no TTL
or cleanup silently permits reuse of a pairing ID. Bounded retention and public
endpoint abuse controls must be reviewed before production activation.

## Deployment and verification boundary

This slice is locally verified against Auth/Firestore emulators. Functions are
disabled for non-emulator use unless the operator explicitly enables the service;
enabling production, billing, IAM, ingress limits and deployment are not authorized
by an emulator test. Validate emulator configuration against the demo project and
loopback endpoints, never accept unsigned emulator credentials in a real project.

The [local-first M1 acceptance contract](../../DEVELOPMENT.md#personal-office-milestone-acceptance)
owns verification/cost requirements. Issuer tests must exercise actual emulator
tokens, transactions, concurrent claims, injected signer failure and downstream
Rules. They are not evidence of protected native credential storage, usable
pairing UI, native retirement or the full CLI-to-browser milestone flow.
