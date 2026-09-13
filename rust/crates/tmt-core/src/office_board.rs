//! Typed local Office discussion-board values, policy, and repository operations.

use std::{error::Error, fmt};

use uuid::Uuid;

pub const TITLE_MAX_BYTES: usize = 160;
pub const ROOT_BODY_MAX_BYTES: usize = 16_384;
pub const REPLY_BODY_MAX_BYTES: usize = 8_192;
pub const REPLY_LIMIT: u64 = 1_000;
pub const DEFAULT_PAGE_SIZE: u32 = 20;
pub const MAX_PAGE_SIZE: u32 = 50;
pub const CURSOR_MAX_BYTES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Category {
    General,
    Repository(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    Owner { world_id: String },
    Identity { identity_id: String, name: String },
}

impl Actor {
    pub fn identity_id(&self) -> Option<&str> {
        match self {
            Self::Identity { identity_id, .. } => Some(identity_id),
            Self::Owner { .. } => None,
        }
    }

    pub fn key(&self) -> String {
        match self {
            Self::Owner { world_id } => format!("owner:{world_id}"),
            Self::Identity { identity_id, .. } => format!("identity:{identity_id}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListView {
    Recent,
    Updated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorFilter {
    Owner,
    Identity(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub thread_id: String,
    pub category: Category,
    pub author: Actor,
    pub revision: u64,
    pub deleted: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub title: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadSummary {
    pub entry: Entry,
    pub reply_count: u64,
    pub activity_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateReceipt {
    pub entry_id: String,
    pub thread_id: String,
    pub revision: u64,
    pub created: bool,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditReceipt {
    pub entry_id: String,
    pub revision: u64,
    pub changed: bool,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteReceipt {
    pub entry_id: String,
    pub revision: u64,
    pub deleted: bool,
    pub changed: bool,
    pub moderated: bool,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListResult {
    pub threads: Vec<ThreadSummary>,
    pub next_cursor: Option<String>,
    pub board_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShowResult {
    pub thread: Entry,
    pub replies: Vec<Entry>,
    pub next_cursor: Option<String>,
    pub board_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostRequest {
    pub category: Category,
    pub actor: Actor,
    pub title: String,
    pub body: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyRequest {
    pub thread_id: String,
    pub actor: Actor,
    pub body: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditRequest {
    pub entry_id: String,
    pub actor: Actor,
    pub title: Option<String>,
    pub body: Option<String>,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeleteRequest {
    pub entry_id: String,
    pub actor: Actor,
    pub moderate: bool,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListRequest {
    pub category: Category,
    pub view: ListView,
    pub author: Option<AuthorFilter>,
    pub since_ms: Option<u64>,
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShowRequest {
    pub thread_id: String,
    pub reply_limit: u32,
    pub reply_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryListRequest {
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryListResult {
    pub categories: Vec<Category>,
    pub next_cursor: Option<String>,
    pub board_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub operation: String,
    pub board_revision: u64,
    pub page_size: u32,
    pub binding: String,
    pub sequence: u64,
    pub key: String,
}

impl Cursor {
    pub fn encode(&self) -> String {
        format!(
            "1.{}.{}.{}.{}.{}.{}",
            hex(&self.operation),
            self.board_revision,
            self.page_size,
            hex(&self.binding),
            self.sequence,
            hex(&self.key)
        )
    }

    pub fn parse(value: &str) -> Result<Self, BoardError<std::convert::Infallible>> {
        if value.is_empty() || value.len() > CURSOR_MAX_BYTES {
            return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
        }
        let parts = value.split('.').collect::<Vec<_>>();
        if parts.len() != 7 || parts[0] != "1" {
            return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
        }
        let operation = unhex(parts[1])?;
        let board_revision = parts[2]
            .parse()
            .map_err(|_| BoardError::policy(BoardErrorCode::CursorInvalid))?;
        let page_size = parts[3]
            .parse()
            .map_err(|_| BoardError::policy(BoardErrorCode::CursorInvalid))?;
        let binding = unhex(parts[4])?;
        let sequence = parts[5]
            .parse()
            .map_err(|_| BoardError::policy(BoardErrorCode::CursorInvalid))?;
        let key = unhex(parts[6])?;
        Ok(Self {
            operation,
            board_revision,
            page_size,
            binding,
            sequence,
            key,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardErrorCode {
    Invalid,
    ThreadNotFound,
    EntryNotFound,
    RevisionConflict,
    Forbidden,
    IdempotencyConflict,
    CursorInvalid,
    CursorStale,
    Storage,
}

impl BoardErrorCode {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid => "BOARD_INVALID",
            Self::ThreadNotFound => "BOARD_THREAD_NOT_FOUND",
            Self::EntryNotFound => "BOARD_ENTRY_NOT_FOUND",
            Self::RevisionConflict => "BOARD_REVISION_CONFLICT",
            Self::Forbidden => "BOARD_FORBIDDEN",
            Self::IdempotencyConflict => "BOARD_IDEMPOTENCY_CONFLICT",
            Self::CursorInvalid => "BOARD_CURSOR_INVALID",
            Self::CursorStale => "BOARD_CURSOR_STALE",
            Self::Storage => "STORAGE_ERROR",
        }
    }
}

#[derive(Debug)]
pub struct BoardError<E> {
    pub code: BoardErrorCode,
    pub source: Option<E>,
}

impl<E> BoardError<E> {
    pub fn policy(code: BoardErrorCode) -> Self {
        Self { code, source: None }
    }
    pub fn storage(source: E) -> Self {
        Self {
            code: BoardErrorCode::Storage,
            source: Some(source),
        }
    }
}

impl<E: fmt::Display> fmt::Display for BoardError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code.code())
    }
}
impl<E: Error + 'static> Error for BoardError<E> {}

pub trait OfficeBoardRepository {
    type Error;
    fn post(&mut self, request: &PostRequest) -> Result<CreateReceipt, BoardError<Self::Error>>;
    fn reply(&mut self, request: &ReplyRequest) -> Result<CreateReceipt, BoardError<Self::Error>>;
    fn edit(&mut self, request: &EditRequest) -> Result<EditReceipt, BoardError<Self::Error>>;
    fn delete(&mut self, request: &DeleteRequest)
    -> Result<DeleteReceipt, BoardError<Self::Error>>;
    fn list(&self, request: &ListRequest) -> Result<ListResult, BoardError<Self::Error>>;
    fn show(&self, request: &ShowRequest) -> Result<ShowResult, BoardError<Self::Error>>;
    fn categories(
        &self,
        request: &CategoryListRequest,
    ) -> Result<CategoryListResult, BoardError<Self::Error>>;
}

pub fn create_thread<R: OfficeBoardRepository>(
    repository: &mut R,
    request: &PostRequest,
) -> Result<CreateReceipt, BoardError<R::Error>> {
    validate_post(request)?;
    repository.post(request)
}
pub fn reply<R: OfficeBoardRepository>(
    repository: &mut R,
    request: &ReplyRequest,
) -> Result<CreateReceipt, BoardError<R::Error>> {
    validate_reply(request)?;
    repository.reply(request)
}
pub fn edit<R: OfficeBoardRepository>(
    repository: &mut R,
    request: &EditRequest,
) -> Result<EditReceipt, BoardError<R::Error>> {
    validate_edit(request)?;
    repository.edit(request)
}
pub fn delete<R: OfficeBoardRepository>(
    repository: &mut R,
    request: &DeleteRequest,
) -> Result<DeleteReceipt, BoardError<R::Error>> {
    validate_delete(request)?;
    repository.delete(request)
}
pub fn list<R: OfficeBoardRepository>(
    repository: &R,
    request: &ListRequest,
) -> Result<ListResult, BoardError<R::Error>> {
    validate_list(request)?;
    repository.list(request)
}
pub fn show<R: OfficeBoardRepository>(
    repository: &R,
    request: &ShowRequest,
) -> Result<ShowResult, BoardError<R::Error>> {
    validate_show(request)?;
    repository.show(request)
}
pub fn categories<R: OfficeBoardRepository>(
    repository: &R,
    request: &CategoryListRequest,
) -> Result<CategoryListResult, BoardError<R::Error>> {
    validate_category_list(request)?;
    repository.categories(request)
}

pub fn validate_post<E>(request: &PostRequest) -> Result<(), BoardError<E>> {
    validate_actor(&request.actor)?;
    validate_category(&request.category)?;
    validate_title(&request.title)?;
    validate_body(&request.body, ROOT_BODY_MAX_BYTES)?;
    validate_operation_id(&request.operation_id)
}

pub fn validate_reply<E>(request: &ReplyRequest) -> Result<(), BoardError<E>> {
    validate_uuid(&request.thread_id)?;
    validate_actor(&request.actor)?;
    validate_body(&request.body, REPLY_BODY_MAX_BYTES)?;
    validate_operation_id(&request.operation_id)
}

pub fn validate_edit<E>(request: &EditRequest) -> Result<(), BoardError<E>> {
    validate_uuid(&request.entry_id)?;
    validate_actor(&request.actor)?;
    if request.expected_revision == 0 || (request.title.is_none() && request.body.is_none()) {
        return Err(BoardError::policy(BoardErrorCode::Invalid));
    }
    if let Some(title) = &request.title {
        validate_title(title)?;
    }
    if let Some(body) = &request.body {
        validate_body(body, ROOT_BODY_MAX_BYTES)?;
    }
    validate_operation_id(&request.operation_id)
}

pub fn validate_delete<E>(request: &DeleteRequest) -> Result<(), BoardError<E>> {
    validate_uuid(&request.entry_id)?;
    validate_actor(&request.actor)?;
    if request.expected_revision == 0
        || (request.moderate && !matches!(request.actor, Actor::Owner { .. }))
    {
        return Err(BoardError::policy(BoardErrorCode::Invalid));
    }
    validate_operation_id(&request.operation_id)
}

pub fn validate_list<E>(request: &ListRequest) -> Result<(), BoardError<E>> {
    validate_category(&request.category)?;
    validate_page(request.limit)?;
    if request
        .since_ms
        .is_some_and(|value| value > crate::limits::MAX_JS_SAFE_INTEGER)
    {
        return Err(BoardError::policy(BoardErrorCode::Invalid));
    }
    if request
        .cursor
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > CURSOR_MAX_BYTES)
    {
        return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
    }
    if let Some(AuthorFilter::Identity(id)) = &request.author {
        validate_uuid(id)?;
    }
    Ok(())
}

pub fn validate_show<E>(request: &ShowRequest) -> Result<(), BoardError<E>> {
    validate_uuid(&request.thread_id)?;
    validate_page(request.reply_limit)?;
    if request
        .reply_cursor
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > CURSOR_MAX_BYTES)
    {
        return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
    }
    Ok(())
}

pub fn validate_category_list<E>(request: &CategoryListRequest) -> Result<(), BoardError<E>> {
    validate_page(request.limit)?;
    if request
        .cursor
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > CURSOR_MAX_BYTES)
    {
        return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
    }
    Ok(())
}

fn validate_page<E>(value: u32) -> Result<(), BoardError<E>> {
    if value == 0 || value > MAX_PAGE_SIZE {
        Err(BoardError::policy(BoardErrorCode::Invalid))
    } else {
        Ok(())
    }
}
fn validate_uuid<E>(value: &str) -> Result<(), BoardError<E>> {
    if Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.to_string() == value)
    {
        Ok(())
    } else {
        Err(BoardError::policy(BoardErrorCode::Invalid))
    }
}
fn validate_operation_id<E>(value: &str) -> Result<(), BoardError<E>> {
    validate_uuid(value)
}
fn validate_title<E>(value: &str) -> Result<(), BoardError<E>> {
    if value.is_empty() || value.len() > TITLE_MAX_BYTES || value.chars().any(char::is_control) {
        Err(BoardError::policy(BoardErrorCode::Invalid))
    } else {
        Ok(())
    }
}
fn validate_body<E>(value: &str, max: usize) -> Result<(), BoardError<E>> {
    if value.is_empty()
        || value.len() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        Err(BoardError::policy(BoardErrorCode::Invalid))
    } else {
        Ok(())
    }
}
fn validate_category<E>(category: &Category) -> Result<(), BoardError<E>> {
    match category {
        Category::General => Ok(()),
        Category::Repository(value) if valid_repository_id(value) => Ok(()),
        Category::Repository(_) => Err(BoardError::policy(BoardErrorCode::Invalid)),
    }
}

pub fn valid_repository_id(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 2048
        || value.contains(['?', '#', '\\', '%', '@'])
        || value.ends_with('/')
        || value.chars().any(char::is_control)
    {
        return false;
    }
    let Some((host_port, path)) = value.split_once('/') else {
        return false;
    };
    if host_port.is_empty()
        || host_port != host_port.to_ascii_lowercase()
        || host_port.starts_with(['.', '-'])
        || host_port.ends_with(['.', '-'])
        || host_port.contains("..")
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return false;
    }
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    !host.is_empty()
        && host.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        && port.is_none_or(|port| port.parse::<u16>().ok().is_some_and(|value| value > 0))
}
fn validate_actor<E>(actor: &Actor) -> Result<(), BoardError<E>> {
    match actor {
        Actor::Owner { world_id } => validate_uuid(world_id),
        Actor::Identity { identity_id, name } => {
            validate_uuid(identity_id)?;
            if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
                Err(BoardError::policy(BoardErrorCode::Invalid))
            } else {
                Ok(())
            }
        }
    }
}

fn hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn unhex(value: &str) -> Result<String, BoardError<std::convert::Infallible>> {
    if !value.len().is_multiple_of(2) {
        return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
    }
    let bytes = value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).map_err(|_| ())?;
            u8::from_str_radix(text, 16).map_err(|_| ())
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| BoardError::policy(BoardErrorCode::CursorInvalid))?;
    String::from_utf8(bytes).map_err(|_| BoardError::policy(BoardErrorCode::CursorInvalid))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Actor {
        Actor::Identity {
            identity_id: "11111111-1111-4111-8111-111111111111".into(),
            name: "alice".into(),
        }
    }

    #[test]
    fn exact_content_bounds_and_controls_are_enforced() {
        for (title, body, valid) in [
            (
                "a".repeat(TITLE_MAX_BYTES),
                "x".repeat(ROOT_BODY_MAX_BYTES),
                true,
            ),
            (
                "title".into(),
                format!("{}a", "界".repeat((ROOT_BODY_MAX_BYTES - 1) / 3)),
                true,
            ),
            ("a".repeat(TITLE_MAX_BYTES + 1), "x".into(), false),
            ("a".into(), "x".repeat(ROOT_BODY_MAX_BYTES + 1), false),
            ("a".into(), "tab\tline\n".into(), true),
            ("a".into(), "bad\r".into(), false),
        ] {
            let request = PostRequest {
                category: Category::General,
                actor: identity(),
                title,
                body,
                operation_id: "22222222-2222-4222-8222-222222222222".into(),
            };
            assert_eq!(validate_post::<()>(&request).is_ok(), valid);
        }
    }

    #[test]
    fn cursors_round_trip_and_reject_malformed_or_oversized_input() {
        let cursor = Cursor {
            operation: "list".into(),
            board_revision: 4,
            page_size: 20,
            binding: "repository:host/A.B|updated".into(),
            sequence: 9,
            key: "33333333-3333-4333-8333-333333333333".into(),
        };
        assert_eq!(Cursor::parse(&cursor.encode()).unwrap(), cursor);
        for value in ["", "2.00.0.1.00.0.00", "1.gg.0.1.00.0.00"] {
            assert!(Cursor::parse(value).is_err());
        }
        assert!(Cursor::parse(&"x".repeat(CURSOR_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn repository_ids_are_canonical_credential_free_values() {
        for value in ["github.com/Org/Repo", "git.example:8443/Team/R.git"] {
            assert!(valid_repository_id(value));
        }
        for value in [
            "GitHub.com/Org/Repo",
            "user@github.com/Org/Repo",
            "github.com/Org/../Repo",
            "github.com/Org/%2e%2e/Repo",
            "github.com/Org/Repo?token=x",
            "/Org/Repo",
        ] {
            assert!(!valid_repository_id(value), "accepted {value}");
        }
    }

    #[test]
    fn list_since_must_be_a_js_safe_timestamp() {
        let request = ListRequest {
            category: Category::General,
            view: ListView::Recent,
            author: None,
            since_ms: Some(crate::limits::MAX_JS_SAFE_INTEGER),
            limit: 20,
            cursor: None,
        };
        assert!(validate_list::<()>(&request).is_ok());
        assert_eq!(
            validate_list::<()>(&ListRequest {
                since_ms: Some(crate::limits::MAX_JS_SAFE_INTEGER + 1),
                ..request
            })
            .unwrap_err()
            .code,
            BoardErrorCode::Invalid
        );
    }
}
