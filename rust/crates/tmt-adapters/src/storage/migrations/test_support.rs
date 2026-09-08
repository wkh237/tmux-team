//! Historical schema fixture shared by migration rollback and receipt handoff tests.
use super::*;

pub(super) fn seed_history(connection: &mut Connection) {
    connection
        .pragma_update(None, "foreign_keys", true)
        .unwrap();
    connection.execute_batch("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)").unwrap();
    for (index, migration) in MIGRATIONS[..8].iter().enumerate() {
        apply_version(connection, index as u32 + 1, migration).unwrap();
    }
    connection
        .execute_batch(
            "INSERT INTO identities VALUES ('old-id', 'Alice', 'alice', 'created', 'updated');
         INSERT INTO role_profiles VALUES ('old-id', 'original role', 'role-time');
         INSERT INTO identity_preambles VALUES ('old-id', 'original preamble', 'preamble-time');
         INSERT INTO preamble_counters VALUES ('old-id', 12, 123);
         INSERT INTO request_attention_identities VALUES ('old-id', 9, 4);",
        )
        .unwrap();
}
