use rusqlite::{Connection, TransactionBehavior, params};
use tmt_core::limits::MAX_JS_SAFE_INTEGER;

use super::errors::{StorageError, StorageErrorCode, classify, incompatible};

struct Migration {
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        name: "create durable identities and transient tmux bindings",
        sql: include_str!("schema/001.sql"),
    },
    Migration {
        name: "create optional identity role profiles",
        sql: include_str!("schema/002.sql"),
    },
    Migration {
        name: "create durable identity preambles",
        sql: include_str!("schema/003.sql"),
    },
    Migration {
        name: "create request attempts and preamble cadence counters",
        sql: include_str!("schema/004.sql"),
    },
    Migration {
        name: "create immutable request responses",
        sql: include_str!("schema/005.sql"),
    },
    Migration {
        name: "freeze exchange retention and response expiry horizons",
        sql: include_str!("schema/006_columns.sql"),
    },
    Migration {
        name: "retain request provenance and bounded original prompts",
        sql: include_str!("schema/007.sql"),
    },
    Migration {
        name: "add identity-scoped exchange attention revisions",
        sql: include_str!("schema/008.sql"),
    },
];

pub(super) fn apply(connection: &mut Connection) -> Result<(), StorageError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| classify(error, "Initialize migration history"))?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)")
        .map_err(|error| classify(error, "Initialize migration history"))?;
    validate_table(&transaction)?;
    transaction
        .commit()
        .map_err(|error| classify(error, "Commit migration history"))?;
    let current = validate_history(connection)?;
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(current) {
        let version = index as u32 + 1;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| classify(error, "Acquire migration lock"))?;
        let apply_one = (|| {
            // A concurrent opener may already have applied this version. The
            // authoritative history check is inside the immediate writer lock.
            if validate_history(&transaction)? >= version as usize {
                return Ok(());
            }
            transaction
                .execute_batch(migration.sql)
                .map_err(|error| classify(error, "Apply migration SQL"))?;
            if version == 6 {
                backfill_retention(&transaction)?;
            }
            transaction.execute(
                "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![version, migration.name],
            ).map_err(|error| classify(error, "Record migration"))?;
            Ok(())
        })();
        apply_one.map_err(|error| StorageError::migration(version, error))?;
        transaction
            .commit()
            .map_err(|error| classify(error, "Commit migration"))?;
    }
    Ok(())
}

fn validate_table(connection: &Connection) -> Result<(), StorageError> {
    let mut query = connection
        .prepare("PRAGMA table_info(_migrations)")
        .map_err(|error| classify(error, "Inspect migration schema"))?;
    let columns = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| classify(error, "Inspect migration schema"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Read migration schema"))?;
    let expected = [
        ("version", "INTEGER", 0, 1),
        ("name", "TEXT", 1, 0),
        ("applied_at", "TEXT", 1, 0),
    ];
    if columns.len() != expected.len()
        || columns.iter().zip(expected).any(|(actual, expected)| {
            actual.0 != expected.0
                || actual.1.to_ascii_uppercase() != expected.1
                || actual.2 != expected.2
                || actual.3 != expected.3
        })
    {
        return Err(incompatible(
            "The _migrations table does not match the supported schema",
        ));
    }
    Ok(())
}

fn validate_history(connection: &Connection) -> Result<usize, StorageError> {
    let mut statement = connection
        .prepare("SELECT version, name FROM _migrations ORDER BY version")
        .map_err(|error| classify(error, "Read migration history"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| classify(error, "Read migration history"))?;
    let mut count = 0;
    for row in rows {
        let (version, name) = row.map_err(|error| {
            incompatible("Migration history contains invalid values").caused_by(error)
        })?;
        if version != count as i64 + 1 {
            return Err(incompatible(format!(
                "Migration history is not contiguous at version {version}"
            )));
        }
        let Some(definition) = MIGRATIONS.get(count) else {
            return Err(incompatible(format!(
                "Database requires unsupported migration version {version}"
            )));
        };
        if definition.name != name {
            return Err(incompatible(format!(
                "Migration {version} has changed from {name} to {}",
                definition.name
            )));
        }
        count += 1;
    }
    Ok(count)
}

// Historical migration policy is frozen independently of today's settings.
const LEGACY_RETENTION_MS: i64 = 7 * 86_400_000;
const SETTLEMENT_FLOOR_MS: i64 = 86_400_000;

fn saturating_deadline(value: i64, delta: i64) -> Result<i64, StorageError> {
    let maximum = MAX_JS_SAFE_INTEGER as i64;
    if !(1..=maximum).contains(&value) || !(0..=maximum).contains(&delta) {
        return Err(StorageError::new(
            StorageErrorCode::Unknown,
            "Historical timestamp is outside the supported range",
        ));
    }
    Ok(value.saturating_add(delta).min(maximum))
}

fn backfill_retention(connection: &Connection) -> Result<(), StorageError> {
    let mut first = connection.prepare("SELECT attempt_id, prepared_at_ms, expires_at_ms, settled_at_ms FROM request_attempts ORDER BY attempt_id LIMIT 100")
        .map_err(|error| classify(error, "Prepare retention migration"))?;
    let mut next = connection.prepare("SELECT attempt_id, prepared_at_ms, expires_at_ms, settled_at_ms FROM request_attempts WHERE attempt_id > ? ORDER BY attempt_id LIMIT 100")
        .map_err(|error| classify(error, "Prepare retention migration"))?;
    let mut update = connection
        .prepare("UPDATE request_attempts SET retention_expires_at_ms = ? WHERE attempt_id = ?")
        .map_err(|error| classify(error, "Prepare retention migration"))?;
    let mut previous: Option<String> = None;
    loop {
        let read = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        };
        let rows = match &previous {
            Some(previous) => next.query_map([previous], read),
            None => first.query_map([], read),
        }
        .map_err(|error| classify(error, "Read historical attempts"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Decode historical attempts"))?;
        if rows.is_empty() {
            break;
        }
        for (id, prepared, expires, settled) in rows {
            // The historical reply-acceptance window is also seven days.
            let horizon = saturating_deadline(prepared, LEGACY_RETENTION_MS)?
                .max(saturating_deadline(expires, SETTLEMENT_FLOOR_MS)?)
                .max(
                    settled
                        .map(|time| saturating_deadline(time, SETTLEMENT_FLOOR_MS))
                        .transpose()?
                        .unwrap_or(0),
                );
            update
                .execute(params![horizon, id])
                .map_err(|error| classify(error, "Backfill attempt horizon"))?;
            previous = Some(id);
        }
    }

    let mut first = connection.prepare("SELECT request_id, submitted_at_ms FROM request_responses ORDER BY request_id LIMIT 100")
        .map_err(|error| classify(error, "Prepare response migration"))?;
    let mut next = connection.prepare("SELECT request_id, submitted_at_ms FROM request_responses WHERE request_id > ? ORDER BY request_id LIMIT 100")
        .map_err(|error| classify(error, "Prepare response migration"))?;
    let mut update = connection
        .prepare("UPDATE request_responses SET response_expires_at_ms = ? WHERE request_id = ?")
        .map_err(|error| classify(error, "Prepare response migration"))?;
    let mut previous: Option<String> = None;
    loop {
        let read = |row: &rusqlite::Row<'_>| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?));
        let rows = match &previous {
            Some(previous) => next.query_map([previous], read),
            None => first.query_map([], read),
        }
        .map_err(|error| classify(error, "Read historical responses"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Decode historical responses"))?;
        if rows.is_empty() {
            break;
        }
        for (id, submitted) in rows {
            update
                .execute(params![
                    saturating_deadline(submitted, LEGACY_RETENTION_MS)?,
                    id
                ])
                .map_err(|error| classify(error, "Backfill response horizon"))?;
            previous = Some(id);
        }
    }
    connection.execute_batch("UPDATE request_attempts SET retention_expires_at_ms = MAX(retention_expires_at_ms, COALESCE((SELECT response_expires_at_ms FROM request_responses WHERE request_responses.request_id = request_attempts.request_id AND request_responses.attempt_id = request_attempts.attempt_id), retention_expires_at_ms))")
        .map_err(|error| classify(error, "Extend matching response horizons"))?;
    connection
        .execute_batch(include_str!("schema/006_indexes.sql"))
        .map_err(|error| classify(error, "Index retention horizons"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_deadlines_saturate_but_do_not_accept_invalid_anchors() {
        assert_eq!(
            saturating_deadline(1, LEGACY_RETENTION_MS).unwrap(),
            604_800_001
        );
        assert_eq!(
            saturating_deadline(MAX_JS_SAFE_INTEGER as i64 - 1, LEGACY_RETENTION_MS).unwrap(),
            MAX_JS_SAFE_INTEGER as i64
        );
        for value in [i64::MIN, -1, 0, MAX_JS_SAFE_INTEGER as i64 + 1, i64::MAX] {
            assert_eq!(
                saturating_deadline(value, 1).unwrap_err().code,
                StorageErrorCode::Unknown
            );
        }
    }
}
