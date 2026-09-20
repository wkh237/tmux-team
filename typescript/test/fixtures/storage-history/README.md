# Historical SQLite fixtures

These immutable, gzip-compressed databases preserve the independent TypeScript
migration oracle after native test infrastructure stops importing the old product.
They contain synthetic test data only. Do not regenerate them with the native
implementation under test or replace them merely to make a failing migration pass.

CI verifies the complete archive inventory, database/snapshot integrity and row
counts. Source revision and producer hashes are audit provenance, reviewed against
Git when these fixtures change; tests do not fetch history or require a non-shallow
checkout to validate the current artifacts.

`manifest.json` records the source revision, producer hashes, decompressed database
hashes, normalized SQL snapshot hashes and table row counts. The original producer
is `test/native/storage-fixture.ts` at that revision. The storage adapter and locked
dependencies from the same revision produced these files; no Rust executable was used.

- `prefix-0` through `prefix-8`: call the historical `seedStoragePrefix(file, version)`
  and close every handle before archiving the database.
- `reference-0` through `reference-8`: open the corresponding populated prefix with
  the historical `openStorage`, let TypeScript upgrade it to schema 8, close it and
  archive the result. The number denotes the original prefix, not the final schema.
- `empty-8`: open and close a new database with historical `openStorage`. The native
  public reply test must migrate this real stopped schema 8 database, not a freshly
  created native schema 9 substitute.

Prefixes preserve the existing scenarios: identity/binding/role/preamble data,
205 request rows across states, 205 responses where supported, missing identity
provenance, saturated deadlines, retention and attention revisions. Schema 0 is
intentionally only migration history. The read-only SQL snapshot oracle compares
tables, columns, indexes, foreign keys and ordered rows, ignoring only migration
application timestamps. Native tests separately verify timestamp preservation,
schema 9 changes, rollback, contention, invalid history and retained exchanges.

To reproduce for an audit, use a separate checkout at the manifest revision with
its lockfile, follow the steps above, and compare normalized snapshot hashes and
row counts. Fresh migration timestamps change raw database hashes, so raw byte
equality is required only for these checked-in fixtures, not a fresh reproduction.
Do not retain a second executable copy of the historical migration implementation.
