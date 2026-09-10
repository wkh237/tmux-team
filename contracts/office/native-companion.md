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
supported handshake and a version matching the verified installation receipt.
The fixed header identifies this explicit child response, never terminal scrollback.

Only a verified active Office installation may be probed. The installer lock
holds the selected release current during bounded execution; no PATH lookup or
fallback to another executable is permitted. The existing subprocess owner
handles deadline, output limits and cleanup. Handshake success says nothing about
pairing, remote availability, granted capabilities or service startup.

`tmt-core::office_protocol` owns request encoding and response validation, with
literal positive/negative test vectors. The separate `tmt-office` executable has
no Firebase, SQLite or networking dependency. It is currently excluded from
public distribution. Synthetic archive process tests exercise the real compiled
companion but are not cargo-dist artifact or public installer acceptance.

Future operations require a reviewed typed contract before implementation.
Do not reuse this probe response as a generic payload or remote authentication.
