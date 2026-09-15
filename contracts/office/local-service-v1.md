# Local Office service v1

This source-candidate contract owns the optional installed companion's offline browser
boundary. It requires a coordinated compatible CLI/Office release before public use.
It is installation-local and does not authorize Firebase, remote publication, pairing,
agent execution or filesystem browsing.

## Process lifecycle

`tmt office start` serializes startup and launches only the verified active
`tmt-office` executable with the internal `__tmt-office-service 1 serve` vector. The
child binds IPv4 `127.0.0.1`, writes a private bounded receipt, and emits readiness only
after the listener and receipt exist. Parent readiness succeeds only after an
authenticated control health request. Reuse preserves the receipt and browser token;
restart generates new independent browser, control and nonce secrets.

The receipt schema is version 1 and contains PID, port, running companion version,
nonce, browser token and control token. It is private coordination state, never public
status. Stale absent processes may be replaced under the startup lock. A live PID
without authenticated health is uncertain and must never be signalled. Stop requires
the control bearer and nonce, waits boundedly for the authenticated process to exit,
and removes only a still-matching receipt.

## HTTP boundary

Every request is HTTP/1.1 on the bound listener and has exactly one Host equal to
`127.0.0.1:<bound-port>`. Request headers are limited to 16 KiB, bodies to 64 KiB,
transfer encoding and ambiguous content lengths are rejected, and every connection
handles one request before closing. There is no CORS response.

- `GET /`, `/index.html`, `/local`, `/local/*` and exact embedded `/assets/*` serve
  only compiled SPA bytes. The static shell is unauthenticated and contains no state.
- `GET /api/v1/local/blocks` requires the browser bearer and returns active existing
  block projections only.
- `GET /api/v1/local/identities/<uuid>/block` requires the browser bearer and an
  active identity UUID. An absent block returns `exists:false`, `blockId:null`,
  revision/timestamp zero and an empty layout without creating a row.
- `PUT /api/v1/local/identities/<uuid>/block` additionally requires exact loopback
  Origin and JSON content type. Its body is `{expectedRevision,layout}`, where
  `layout` is the canonical version-2 layout. Revision zero creates the first block
  through the shared SQLite conditional-apply operation. The former private
  `/api/v1/local/blocks/<block-uuid>` detail route is not supported.
- `POST /control/v1/health` and `/control/v1/stop` require the distinct control bearer,
  receipt nonce and an empty body.

All responses set `Cache-Control: no-store`, a self-only CSP, no-referrer, nosniff,
frame denial and same-origin resource policy. Paths do not map to the filesystem.
Missing, malformed, unauthorized, conflicting and unavailable results use only the
bounded status/error allowlist implemented by the service.

## Browser session

The session URL is `http://127.0.0.1:<port>/local#token=<browser-token>`. The offline
SPA validates the token, moves it to memory and removes the fragment with
`history.replaceState`. Reload therefore needs the URL printed by a later `office
start`. Data requests carry the bearer. Block watches have one request in flight, poll
from two seconds with bounded backoff, abort on disposal, and stop after authorization
failure. The existing block draft/conflict state remains the only editor state.

`/local` observes active identity profiles and persisted blocks for the office
overview. `/local/agents/<identity-uuid>` selects an editable room; route selection
does not create or authorize an identity. A mounted-view snapshot loader owns
loading, retry and stale-completion fencing. Returning to the overview or explicit
refresh rereads state. Prop resolution deduplicates across rooms and batches at
most 16 unique digests per request; overview rooms do not each start a listener.

## Persistence

Migration 011 owns the singleton local-world metadata and identity-UUID block rows.
Canonical `BlockLayout` tokens, revisions and timestamps live in the existing SQLite
database. CLI local block invocations and HTTP handlers call the same repository. A
missing block read does not create it; first apply creates UUID/revision 1 atomically.
Exact retries preserve the committed revision. Mutations recheck active identity in an
immediate transaction. Retirement retains but hides content, and a same-name new UUID
does not inherit it.
