//! Retry identities shared by explicit durable mutations.

pub fn new_operation_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
