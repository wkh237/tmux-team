//! Durable request policy and transaction-scoped ports. No live endpoint lookup,
//! configuration loading or external effects belong inside this boundary.

mod service;
pub use service::RequestService;

use crate::endpoint::ServerEvidence;
use std::{error::Error, fmt};

pub const CLEANUP_BATCH_SIZE: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestEndpoint {
    pub server: ServerEvidence,
    pub pane_id: String,
    pub pane_pid: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptStatus {
    Prepared,
    Sending,
    Sent,
    Uncertain,
    DefinitelyFailed,
}

impl AttemptStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Sending => "sending",
            Self::Sent => "sent",
            Self::Uncertain => "uncertain",
            Self::DefinitelyFailed => "definitely_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    Sent,
    Uncertain,
    DefinitelyFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Originator {
    Unknown,
    Explicit(String),
    Verified(String),
}

impl Originator {
    pub fn identity_id(&self) -> Option<&str> {
        match self {
            Self::Unknown => None,
            Self::Explicit(id) | Self::Verified(id) => Some(id),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Explicit(_) => "explicit",
            Self::Verified(_) => "verified",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestAttempt {
    pub attempt_id: String,
    pub request_id: String,
    pub originator: Originator,
    pub recipient_identity_id: Option<String>,
    pub nonce: Option<String>,
    pub identity_id: Option<String>,
    pub endpoint: RequestEndpoint,
    pub wait_active: bool,
    pub status: AttemptStatus,
    pub preamble_every: Option<u64>,
    pub inject_preamble: bool,
    pub cadence_reserved: bool,
    pub prepared_at_ms: u64,
    pub sending_at_ms: Option<u64>,
    pub settled_at_ms: Option<u64>,
    pub wait_released_at_ms: Option<u64>,
    pub response_submitted_at_ms: Option<u64>,
    pub expires_at_ms: u64,
    pub retention_days: u64,
    pub retention_expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalResponse {
    pub request_id: String,
    pub attempt_id: String,
    pub endpoint: RequestEndpoint,
    pub body: String,
    pub body_bytes: u64,
    pub submitted_at_ms: u64,
    pub response_expires_at_ms: u64,
}

pub struct PreambleReservation {
    pub identity_id: String,
    pub every: u64,
}

pub struct PrepareRequest {
    pub request_id: String,
    pub message: String,
    pub endpoint: RequestEndpoint,
    pub wait: bool,
    pub expires_at_ms: u64,
    pub originator: Originator,
    pub recipient_identity_id: Option<String>,
    pub preamble: Option<PreambleReservation>,
}

#[derive(Debug)]
pub struct PreparedRequest {
    pub attempt_id: String,
    pub request_id: String,
    pub inject_preamble: bool,
    pub previous_request_id: Option<String>,
}

pub struct SubmitResponse {
    pub request_id: String,
    pub attempt_id: String,
    pub endpoint: RequestEndpoint,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPrompt {
    pub message: String,
    pub message_bytes: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRequestContext {
    pub attempt: RequestAttempt,
    pub message: Option<String>,
    pub message_bytes: Option<u64>,
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestPrompt {
    Retained(StoredPrompt),
    Expired { expires_at_ms: u64 },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestContext {
    pub attempt: RequestAttempt,
    pub prompt: RequestPrompt,
}

/// These methods are exposed only while the invocation's immediate transaction
/// is held. Domain decisions remain in RequestService, not in SQL adapters.
pub trait RequestRecords {
    type Error;
    fn find_attempt(&self, attempt_id: &str) -> Result<Option<RequestAttempt>, Self::Error>;
    fn find_request(&self, request_id: &str) -> Result<Option<RequestAttempt>, Self::Error>;
    fn find_context(&self, request_id: &str) -> Result<Option<RawRequestContext>, Self::Error>;
    fn find_response(&self, request_id: &str) -> Result<Option<FinalResponse>, Self::Error>;
    fn find_active_request(
        &self,
        endpoint: &RequestEndpoint,
    ) -> Result<Option<String>, Self::Error>;
    fn create_attempt(
        &mut self,
        attempt: &RequestAttempt,
        prompt: &StoredPrompt,
        revision: u64,
    ) -> Result<(), Self::Error>;
    /// Inserts final and completion marker atomically; fails if exactly one
    /// matching previously-uncompleted attempt cannot be marked.
    fn create_response(&mut self, response: &FinalResponse) -> Result<(), Self::Error>;
    fn update_state(
        &mut self,
        attempt: &RequestAttempt,
        status: AttemptStatus,
        reserved: bool,
        now_ms: u64,
        horizon: Option<u64>,
    ) -> Result<bool, Self::Error>;
    fn release_wait(&mut self, attempt_id: &str, now_ms: u64) -> Result<bool, Self::Error>;
    fn preamble_count(&self, identity_id: &str) -> Result<u64, Self::Error>;
    fn set_preamble_count(
        &mut self,
        identity_id: &str,
        count: u64,
        now_ms: u64,
    ) -> Result<(), Self::Error>;
    fn attention_counter(&self, identity_id: &str) -> Result<Option<u64>, Self::Error>;
    /// Preserves the acknowledged-through watermark; must reject a changed
    /// expected counter rather than overwriting concurrent ownership.
    fn set_attention_counter(
        &mut self,
        identity_id: &str,
        expected: Option<u64>,
        next: u64,
    ) -> Result<(), Self::Error>;
    fn set_attention_revision(
        &mut self,
        request_id: &str,
        revision: u64,
    ) -> Result<(), Self::Error>;
    fn expired_attempts(&self, now_ms: u64, limit: u64)
    -> Result<Vec<RequestAttempt>, Self::Error>;
    fn clear_expired_prompts(&mut self, now_ms: u64, limit: u64) -> Result<(), Self::Error>;
    fn delete_expired_responses(&mut self, now_ms: u64, limit: u64) -> Result<(), Self::Error>;
    fn delete_retained(
        &mut self,
        now_ms: u64,
        settled_cutoff_ms: u64,
        limit: u64,
    ) -> Result<(), Self::Error>;
}

pub trait RequestRepository {
    type Error;
    fn with_request_transaction<T, E: From<Self::Error>>(
        &mut self,
        operation: impl FnOnce(&mut dyn RequestRecords<Error = Self::Error>) -> Result<T, E>,
    ) -> Result<T, E>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseRejection {
    InputInvalid,
    InputTooLarge,
    RequestNotFound,
    AttemptMismatch,
    RecipientMismatch,
    StateInvalid,
    Conflict,
    Expired,
}

impl ResponseRejection {
    pub fn code(self) -> &'static str {
        match self {
            Self::InputInvalid => "RESPONSE_INPUT_INVALID",
            Self::InputTooLarge => "RESPONSE_INPUT_TOO_LARGE",
            Self::RequestNotFound => "RESPONSE_REQUEST_NOT_FOUND",
            Self::AttemptMismatch => "RESPONSE_ATTEMPT_MISMATCH",
            Self::RecipientMismatch => "RESPONSE_RECIPIENT_MISMATCH",
            Self::StateInvalid => "RESPONSE_STATE_INVALID",
            Self::Conflict => "RESPONSE_CONFLICT",
            Self::Expired => "RESPONSE_EXPIRED",
        }
    }
}

#[derive(Debug)]
pub enum RequestError<E> {
    Invalid(&'static str),
    InputTooLarge,
    Expired,
    NotFound,
    StateInvalid,
    AlreadyExists,
    CounterExhausted,
    RevisionExhausted,
    Response(ResponseRejection),
    Repository(E),
}

impl<E> From<E> for RequestError<E> {
    fn from(error: E) -> Self {
        Self::Repository(error)
    }
}
impl<E> fmt::Display for RequestError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::InputTooLarge => f.write_str("Original request exceeds the UTF-8 byte limit."),
            Self::Expired => f.write_str("Request attempt has expired."),
            Self::NotFound => f.write_str("Request attempt was not found."),
            Self::StateInvalid => f.write_str("Request attempt cannot make this transition."),
            Self::AlreadyExists => f.write_str("Request ID already has a retained final."),
            Self::CounterExhausted => f.write_str("Preamble cadence counter is exhausted."),
            Self::RevisionExhausted => {
                f.write_str("Exchange attention revision counter is exhausted.")
            }
            Self::Response(reason) => f.write_str(reason.code()),
            Self::Repository(_) => f.write_str("Could not access request state."),
        }
    }
}
impl<E: Error + 'static> Error for RequestError<E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Repository(e) => Some(e),
            _ => None,
        }
    }
}
