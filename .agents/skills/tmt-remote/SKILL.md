---
name: tmt-remote
description: Change or review the Remote extension (`tmt remote`, extensions/tmt-remote) with its module owners, authority and serve-lease rules.
---

# Remote extension

Remote is the foreground owner-device door run as `tmt remote`. Read
[Remote extension pilot](../../../ARCHITECTURE.md#remote-extension-pilot) for the
system-wide invariants and
[`contracts/remote-channel-v1.md`](../../../contracts/remote-channel-v1.md) for
wire, pairing, session and extension-API bytes; this file does not restate them.
The Rust crate is `extensions/tmt-remote/rust/tmt-remote`; the device SDK is
`extensions/tmt-remote/typescript/remote-client`.

## Architecture internals

Module owners (put a change in the existing owner; `canonical`, `crypto`, `wire`
and `transport` have no I/O, clock, storage or `CoreClient` access):

| Module                              | Owns                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `main`, `core`                      | Foreground composition and the two startup calls; `CoreClient` runs only fixed public `api`/`ls` via `TMT_EXECUTABLE` |
| `http`, `routes`, `site`, `limits`  | Loopback door framing and bounds, `/r/` binding routes, route dispatch; every bound is named in `limits`              |
| `wire`, `canonical`, `crypto`       | Strict JSON admission with exact payload bytes, framing/fingerprint codecs, signature and HMAC verification           |
| `session`, `admission`, `transport` | `session.open`, one normal message in flight per session, durable sequence consumption, envelope hand-off             |
| `journal`, `budgets`, `audit`       | Metadata streams and recovery ownership, persisted budgets, audit written in the owning transaction                   |
| `operations`, `approval`            | Dispatch/read operations over the public core API; local held-operation confirmation on the control socket            |
| `authority`, `store`, `state`       | Typed grants, `remote.db` and schema history, layout/machine key/serve lock                                           |
| `pairing`, `control`, `devices`     | One pairing offer per run, owner-only control socket, device list/revoke/rename                                       |
| `mount`, `pages`                    | Extension mounts (allowlisted extensions only) and the pairing page/SDK assets                                        |

Rules that are easy to get wrong:

- **One opener.** `store::Store` opens only with the `state::Serving` proof of the
  serve lock. Pairing and device commands reach state through serve's control
  socket; `tmt remote devices` without serve takes the lock itself.
- **Authority lives in the transaction.** An effect runs in `Store::effect`: it
  rereads the persisted grant (revision, liveness, scope, recipients, expiry)
  inside an IMMEDIATE transaction and performs the core call under that fence. A
  new check outside the transaction is a race with revocation.
- **Revoke waits for the fence.** SQLite authority writers wait
  `limits::AUTHORITY_WAIT` (40 s), longer than two `CORE_CALL` runs (15 s each)
  plus cleanup, so a revoke ordered after an in-flight effect succeeds once the
  call releases. Keep that ordering when changing either constant.
- **Uncertainty keeps identity.** The `dispatching` audit row commits after the
  core call; recovery uses the adopted frozen intent and core's idempotent
  operation ID (`dispatch.show` before any `dispatch.create`) and never infers
  "no effect" from a missing row. Reads never retry or send.
- **Serve lease.** `Serving::retain_for_invocations` clears close-on-exec on the
  lock file so invocation children inherit it; closing never unlocks. A restart
  refuses while an orphaned child lives; unconfirmed cleanup disables writes until
  a fresh lease-owning run. The lease test is a real-process SIGKILL probe in
  `core_tests.rs`.
- **Pre-auth stays generic.** Refusals before a verified signature or live
  session are one 404 with no inventory. The `tmt_door` cookie only identifies a
  session on mounted paths; `/r/` refuses cookies.
- **Mount trust.** Mounted extensions share one trust domain behind the door.
  The device context header is added only for a live owner session and is never
  copied from a client.
- **Embedded SDK asset.** The door embeds `assets/remote-v1.js` built from
  `remote-client/src`. After changing the SDK, rebuild and commit the asset (CI
  rebuilds it and fails on a difference); run commands are in DEVELOPMENT's
  Remote section.
- **Parked add-on.** `typescript/browser-addon` is a demo shell with no crypto,
  pairing or network; it is not a working channel (#1056).
