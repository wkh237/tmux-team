use super::*;
use crate::test_support::TestDirectory;
use tmt_core::{
    identity::{Lifetime, create_or_resolve},
    identity_status::{self, StatusError},
};

#[test]
fn status_round_trip_renewal_clear_and_promotion_preserve_identity_ownership() {
    let directory = TestDirectory::new();
    let path = directory.path.join("status.db");
    let mut storage = Storage::open(&path).unwrap();
    let identity = create_or_resolve(&mut storage, "Alice", Lifetime::Temporary)
        .unwrap()
        .identity;
    assert_eq!(
        identity_status::show_identity_status(&storage, &identity.id).unwrap(),
        None
    );
    let status = identity_status::set_identity_status(
        &mut storage,
        &identity.id,
        "Reviewing".into(),
        Some("focused".into()),
        100,
        1000,
    )
    .unwrap();
    assert_eq!(
        storage.find_active_identity_by_id(&identity.id).unwrap(),
        Some(identity.clone())
    );
    storage.close().unwrap();
    let mut storage = Storage::open(&path).unwrap();
    assert_eq!(
        identity_status::show_identity_status(&storage, &identity.id).unwrap(),
        Some(status.clone())
    );
    let promoted = create_or_resolve(&mut storage, "Alice", Lifetime::Saved)
        .unwrap()
        .identity;
    assert_eq!(promoted.id, identity.id);
    assert_eq!(promoted.lifetime, Lifetime::Saved);
    assert_eq!(
        identity_status::show_identity_status(&storage, &identity.id).unwrap(),
        Some(status)
    );
    let renewed = identity_status::set_identity_status(
        &mut storage,
        &identity.id,
        "Reviewing".into(),
        None,
        200,
        1000,
    )
    .unwrap();
    assert_eq!(renewed.expires_at_ms, 1200);
    assert_eq!(renewed.mood, None);
    assert_eq!(
        identity_status::show_identity_status(&storage, &identity.id).unwrap(),
        Some(renewed)
    );
    assert!(identity_status::clear_identity_status(&mut storage, &identity.id).unwrap());
    assert!(!identity_status::clear_identity_status(&mut storage, &identity.id).unwrap());
    assert_eq!(
        identity_status::show_identity_status(&storage, &identity.id).unwrap(),
        None
    );
    storage.close().unwrap();
}

#[test]
fn invalid_or_failed_writes_leave_the_complete_previous_record_untouched() {
    let directory = TestDirectory::new();
    let mut storage = Storage::open(directory.path.join("status.db")).unwrap();
    let id = create_or_resolve(&mut storage, "Alice", Lifetime::Saved)
        .unwrap()
        .identity
        .id;
    let original = identity_status::set_identity_status(
        &mut storage,
        &id,
        "Review".into(),
        Some("focused".into()),
        100,
        1000,
    )
    .unwrap();
    assert!(matches!(
        identity_status::set_identity_status(
            &mut storage,
            &id,
            "invalid\ntext".into(),
            None,
            200,
            1000
        ),
        Err(StatusError::Invalid(_))
    ));
    storage.connection().unwrap().execute_batch("CREATE TRIGGER fail_status BEFORE UPDATE ON identity_status BEGIN SELECT RAISE(ABORT, 'test write failure'); END;").unwrap();
    assert!(matches!(
        identity_status::set_identity_status(&mut storage, &id, "New".into(), None, 200, 1000),
        Err(StatusError::Repository(_))
    ));
    assert_eq!(
        identity_status::show_identity_status(&storage, &id).unwrap(),
        Some(original)
    );
    storage.close().unwrap();
}

#[test]
fn retirement_hides_but_preserves_the_old_record_and_reused_names_do_not_inherit_it() {
    let directory = TestDirectory::new();
    let mut storage = Storage::open(directory.path.join("status.db")).unwrap();
    let original = create_or_resolve(&mut storage, "Alice", Lifetime::Temporary)
        .unwrap()
        .identity;
    identity_status::set_identity_status(
        &mut storage,
        &original.id,
        "Review".into(),
        None,
        100,
        1000,
    )
    .unwrap();
    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE identities SET retired_at_ms = 200 WHERE id = ?",
            [&original.id],
        )
        .unwrap();
    assert!(matches!(
        identity_status::show_identity_status(&storage, &original.id),
        Err(StatusError::IdentityInactive)
    ));
    assert!(matches!(
        identity_status::set_identity_status(
            &mut storage,
            &original.id,
            "New".into(),
            None,
            200,
            1000
        ),
        Err(StatusError::IdentityInactive)
    ));
    assert!(matches!(
        identity_status::clear_identity_status(&mut storage, &original.id),
        Err(StatusError::IdentityInactive)
    ));
    let replacement = create_or_resolve(&mut storage, "Alice", Lifetime::Saved)
        .unwrap()
        .identity;
    assert_ne!(replacement.id, original.id);
    assert_eq!(
        identity_status::show_identity_status(&storage, &replacement.id).unwrap(),
        None
    );
    let old: String = storage
        .connection()
        .unwrap()
        .query_row(
            "SELECT activity FROM identity_status WHERE identity_id = ?",
            [&original.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old, "Review");
    assert!(storage.list_active_identity_statuses().unwrap().is_empty());
    storage.close().unwrap();
}

#[test]
fn directory_returns_the_same_validated_records_without_filtering_expiry_or_requiring_profiles() {
    let directory = TestDirectory::new();
    let mut storage = Storage::open(directory.path.join("status.db")).unwrap();
    let alice = create_or_resolve(&mut storage, "Alice", Lifetime::Saved)
        .unwrap()
        .identity;
    let bob = create_or_resolve(&mut storage, "Bob", Lifetime::Temporary)
        .unwrap()
        .identity;
    create_or_resolve(&mut storage, "NoStatus", Lifetime::Saved).unwrap();
    let first = identity_status::set_identity_status(
        &mut storage,
        &alice.id,
        "Review".into(),
        None,
        100,
        1000,
    )
    .unwrap();
    let second = identity_status::set_identity_status(
        &mut storage,
        &bob.id,
        "Testing".into(),
        Some("calm".into()),
        100,
        2000,
    )
    .unwrap();
    assert_eq!(
        storage.list_active_identity_statuses().unwrap(),
        HashMap::from([(alice.id.clone(), first), (bob.id.clone(), second)])
    );
    assert_eq!(
        storage
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM office_local_profiles", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    // SQL constraints allow nonblank/control checks to remain core-owned. Both
    // read paths must reject a corrupted record through the same decoder.
    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE identity_status SET activity = char(10) WHERE identity_id = ?",
            [&bob.id],
        )
        .unwrap();
    assert!(storage.read_identity_status(&bob.id).is_err());
    assert!(storage.list_active_identity_statuses().is_err());
    storage.close().unwrap();
}
