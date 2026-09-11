# Native companion handshake v1

This internal local protocol is separate from the proposed remote work-handoff
schema. It grants no Office access and does not replace pairing.

The core-owned `OfficeInvocation` currently has one operation: `Probe`. Its exact
argument vector is `__tmt-office`, `1`, `probe`. Unknown versions, operations,
extra arguments and non-UTF-8 arguments fail with exit 1, empty stdout and a brief
stderr diagnostic. There is no arbitrary argv forwarding or shell evaluation.

Successful output is exactly two LF-terminated UTF-8 lines:

```text
TMT-OFFICE/1
0.1.0-alpha.1
```

The second line is the companion's canonical package version, independent of
the CLI version. The adapter allows at most 1024 bytes per output stream and a
five-second execution deadline. Success requires exit 0, empty stderr, an exact
supported handshake and a version matching the verified receipt or candidate
artifact during pre-activation validation.
The fixed header identifies this explicit child response, never terminal scrollback.

Only a verified owned release or staged candidate may be probed. The installer
lock protects active-release verification and child launch, not the subsequent
wait. The result describes the version selected at launch; concurrent upgrade
or deactivation may change the current installation before completion. A staged
candidate's pre-activation probe retains the publisher's existing lock scope.
No PATH lookup or fallback to another executable is permitted. The existing
subprocess owner handles deadline, output limits and cleanup. Handshake success says nothing about
pairing, remote availability, granted capabilities or service startup.

`tmt-core::office_protocol` owns request encoding and response validation, with
literal positive/negative test vectors. The separate `tmt-office` executable has
no Firebase, SQLite or networking dependency. Local cargo-dist packaging is
available; no public release has been published. Synthetic archive process tests
exercise the real compiled companion. The independent native artifact verifier
separately checks actual Office archives; neither constitutes public publication.

Future operations require a reviewed typed contract before implementation.
Do not reuse this probe response as a generic payload or remote authentication.
