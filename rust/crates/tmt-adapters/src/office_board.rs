//! JSON boundary shared by one-shot companion calls and the local HTTP service.

use serde::Deserialize;
use serde_json::{Value, json};
use tmt_core::{
    office_board::{
        self, Actor, AuthorFilter, BoardErrorCode, Category, CategoryListRequest, DeleteRequest,
        EditRequest, ListRequest, ListView, PostRequest, ReplyRequest, ShowRequest,
    },
    office_protocol::OfficeInvocation,
};

use crate::{
    config::ConfigPaths,
    storage::{Storage, local_owner_actor},
};

pub const BOARD_WIRE_LIMIT: usize = 65_536;
pub const BOARD_OUTPUT_LIMIT: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CategoryInput {
    kind: String,
    #[serde(default)]
    repository_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActorInput {
    kind: String,
    #[serde(default)]
    identity_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PostInput {
    category: CategoryInput,
    actor: ActorInput,
    title: String,
    body: String,
    operation_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplyInput {
    thread_id: String,
    actor: ActorInput,
    body: String,
    operation_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditInput {
    entry_id: String,
    actor: ActorInput,
    title: Option<String>,
    body: Option<String>,
    if_revision: u64,
    operation_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteInput {
    entry_id: String,
    actor: ActorInput,
    moderate: bool,
    if_revision: u64,
    operation_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput {
    category: CategoryInput,
    view: Option<String>,
    author: Option<ActorInput>,
    since_ms: Option<u64>,
    limit: Option<u32>,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShowInput {
    thread_id: String,
    reply_limit: Option<u32>,
    reply_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CategoriesInput {
    limit: Option<u32>,
    cursor: Option<String>,
}

pub fn execute(operation: OfficeInvocation, input: &[u8]) -> Vec<u8> {
    if let Err(code) = validate_wire(operation, input) {
        return serde_json::to_vec(&json!({"error":code.code()})).unwrap();
    }
    let paths = match ConfigPaths::discover() {
        Ok(paths) => paths,
        Err(_) => return br#"{"error":"STORAGE_ERROR"}"#.to_vec(),
    };
    execute_at(operation, input, &paths.database)
}

pub fn execute_at(
    operation: OfficeInvocation,
    input: &[u8],
    database: &std::path::Path,
) -> Vec<u8> {
    if let Err(code) = validate_wire(operation, input) {
        return serde_json::to_vec(&json!({"error":code.code()})).unwrap();
    }
    let value = execute_inner(operation, input, database)
        .unwrap_or_else(|code| json!({"error":code.code()}));
    serde_json::to_vec(&value).unwrap_or_else(|_| br#"{"error":"STORAGE_ERROR"}"#.to_vec())
}

fn validate_wire(operation: OfficeInvocation, input: &[u8]) -> Result<(), BoardErrorCode> {
    if input.len() > BOARD_WIRE_LIMIT {
        return Err(BoardErrorCode::Invalid);
    }
    let op = |v: Option<String>| v.unwrap_or_else(|| "00000000-0000-4000-8000-000000000000".into());
    match operation {
        OfficeInvocation::BoardPost => {
            let v: PostInput = decode(input)?;
            office_board::validate_post::<std::convert::Infallible>(&PostRequest {
                category: category(v.category)?,
                actor: pre_actor(v.actor)?,
                title: v.title,
                body: v.body,
                operation_id: op(v.operation_id),
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardReply => {
            let v: ReplyInput = decode(input)?;
            office_board::validate_reply::<std::convert::Infallible>(&ReplyRequest {
                thread_id: v.thread_id,
                actor: pre_actor(v.actor)?,
                body: v.body,
                operation_id: op(v.operation_id),
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardEdit => {
            let v: EditInput = decode(input)?;
            office_board::validate_edit::<std::convert::Infallible>(&EditRequest {
                entry_id: v.entry_id,
                actor: pre_actor(v.actor)?,
                title: v.title,
                body: v.body,
                expected_revision: v.if_revision,
                operation_id: op(v.operation_id),
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardDelete => {
            let v: DeleteInput = decode(input)?;
            office_board::validate_delete::<std::convert::Infallible>(&DeleteRequest {
                entry_id: v.entry_id,
                actor: pre_actor(v.actor)?,
                moderate: v.moderate,
                expected_revision: v.if_revision,
                operation_id: op(v.operation_id),
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardList => {
            let v: ListInput = decode(input)?;
            office_board::validate_list::<std::convert::Infallible>(&ListRequest {
                category: category(v.category)?,
                view: match v.view.as_deref().unwrap_or("recent") {
                    "recent" => ListView::Recent,
                    "updated" => ListView::Updated,
                    _ => return Err(BoardErrorCode::Invalid),
                },
                author: author_filter(v.author)?,
                since_ms: v.since_ms,
                limit: v.limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                cursor: v.cursor,
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardShow => {
            let v: ShowInput = decode(input)?;
            office_board::validate_show::<std::convert::Infallible>(&ShowRequest {
                thread_id: v.thread_id,
                reply_limit: v.reply_limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                reply_cursor: v.reply_cursor,
            })
            .map_err(|e| e.code)
        }
        OfficeInvocation::BoardCategories => {
            let v: CategoriesInput = decode(input)?;
            office_board::validate_category_list::<std::convert::Infallible>(&CategoryListRequest {
                limit: v.limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                cursor: v.cursor,
            })
            .map_err(|e| e.code)
        }
        _ => Err(BoardErrorCode::Invalid),
    }
}
fn pre_actor(value: ActorInput) -> Result<Actor, BoardErrorCode> {
    match value {
        ActorInput {
            kind,
            identity_id: None,
            name: None,
        } if kind == "owner" => Ok(Actor::Owner {
            world_id: "00000000-0000-4000-8000-000000000000".into(),
        }),
        ActorInput {
            kind,
            identity_id: Some(identity_id),
            name: Some(name),
        } if kind == "identity" => Ok(Actor::Identity { identity_id, name }),
        _ => Err(BoardErrorCode::Invalid),
    }
}

fn execute_inner(
    operation: OfficeInvocation,
    input: &[u8],
    database: &std::path::Path,
) -> Result<Value, BoardErrorCode> {
    if input.len() > BOARD_WIRE_LIMIT {
        return Err(BoardErrorCode::Invalid);
    }
    let mut storage = Storage::open(database).map_err(|_| BoardErrorCode::Storage)?;
    let result = (|| match operation {
        OfficeInvocation::BoardPost => {
            let input: PostInput = decode(input)?;
            let request = PostRequest {
                category: category(input.category)?,
                actor: actor(&mut storage, input.actor)?,
                title: input.title,
                body: input.body,
                operation_id: operation_id(input.operation_id)?,
            };
            office_board::create_thread(&mut storage, &request)
                .map(create_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardReply => {
            let input: ReplyInput = decode(input)?;
            let request = ReplyRequest {
                thread_id: input.thread_id,
                actor: actor(&mut storage, input.actor)?,
                body: input.body,
                operation_id: operation_id(input.operation_id)?,
            };
            office_board::reply(&mut storage, &request)
                .map(create_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardEdit => {
            let input: EditInput = decode(input)?;
            let request = EditRequest {
                entry_id: input.entry_id,
                actor: actor(&mut storage, input.actor)?,
                title: input.title,
                body: input.body,
                expected_revision: input.if_revision,
                operation_id: operation_id(input.operation_id)?,
            };
            office_board::edit(&mut storage, &request)
                .map(edit_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardDelete => {
            let input: DeleteInput = decode(input)?;
            let request = DeleteRequest {
                entry_id: input.entry_id,
                actor: actor(&mut storage, input.actor)?,
                moderate: input.moderate,
                expected_revision: input.if_revision,
                operation_id: operation_id(input.operation_id)?,
            };
            office_board::delete(&mut storage, &request)
                .map(delete_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardList => {
            let input: ListInput = decode(input)?;
            let request = ListRequest {
                category: category(input.category)?,
                view: match input.view.as_deref().unwrap_or("recent") {
                    "recent" => ListView::Recent,
                    "updated" => ListView::Updated,
                    _ => return Err(BoardErrorCode::Invalid),
                },
                author: author_filter(input.author)?,
                since_ms: input.since_ms,
                limit: input.limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                cursor: input.cursor,
            };
            office_board::list(&storage, &request)
                .map(list_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardShow => {
            let input: ShowInput = decode(input)?;
            let request = ShowRequest {
                thread_id: input.thread_id,
                reply_limit: input.reply_limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                reply_cursor: input.reply_cursor,
            };
            office_board::show(&storage, &request)
                .map(show_value)
                .map_err(|e| e.code)
        }
        OfficeInvocation::BoardCategories => {
            let input: CategoriesInput = decode(input)?;
            let request = CategoryListRequest {
                limit: input.limit.unwrap_or(office_board::DEFAULT_PAGE_SIZE),
                cursor: input.cursor,
            };
            office_board::categories(&storage, &request)
                .map(categories_value)
                .map_err(|e| e.code)
        }
        _ => Err(BoardErrorCode::Invalid),
    })();
    let close = storage.close().map_err(|_| BoardErrorCode::Storage);
    match (result, close) {
        (Err(e), _) => Err(e),
        (Ok(v), Ok(())) => Ok(v),
        (Ok(_), Err(e)) => Err(e),
    }
}

fn decode<'a, T: Deserialize<'a>>(input: &'a [u8]) -> Result<T, BoardErrorCode> {
    serde_json::from_slice(input).map_err(|_| BoardErrorCode::Invalid)
}
fn operation_id(value: Option<String>) -> Result<String, BoardErrorCode> {
    let value = value.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if uuid::Uuid::parse_str(&value)
        .ok()
        .is_some_and(|id| id.to_string() == value)
    {
        Ok(value)
    } else {
        Err(BoardErrorCode::Invalid)
    }
}
fn category(value: CategoryInput) -> Result<Category, BoardErrorCode> {
    match value {
        CategoryInput {
            kind,
            repository_id: None,
        } if kind == "general" => Ok(Category::General),
        CategoryInput {
            kind,
            repository_id: Some(id),
        } if kind == "repository" => Ok(Category::Repository(id)),
        _ => Err(BoardErrorCode::Invalid),
    }
}
fn actor(storage: &mut Storage, value: ActorInput) -> Result<Actor, BoardErrorCode> {
    match value {
        ActorInput {
            kind,
            identity_id: Some(id),
            name: Some(name),
        } if kind == "identity" => Ok(Actor::Identity {
            identity_id: id,
            name,
        }),
        ActorInput {
            kind,
            identity_id: None,
            name: None,
        } if kind == "owner" => local_owner_actor(storage).map_err(|_| BoardErrorCode::Storage),
        _ => Err(BoardErrorCode::Invalid),
    }
}
fn author_filter(value: Option<ActorInput>) -> Result<Option<AuthorFilter>, BoardErrorCode> {
    match value {
        None => Ok(None),
        Some(ActorInput {
            kind,
            identity_id: None,
            name: None,
        }) if kind == "owner" => Ok(Some(AuthorFilter::Owner)),
        Some(ActorInput {
            kind,
            identity_id: Some(id),
            name: None,
        }) if kind == "identity" => Ok(Some(AuthorFilter::Identity(id))),
        _ => Err(BoardErrorCode::Invalid),
    }
}
fn category_value(v: &Category) -> Value {
    match v {
        Category::General => json!({"kind":"general"}),
        Category::Repository(repository_id) => {
            json!({"kind":"repository","repositoryId":repository_id})
        }
    }
}
fn actor_value(v: &Actor) -> Value {
    match v {
        Actor::Owner { .. } => json!({"kind":"owner"}),
        Actor::Identity { identity_id, name } => {
            json!({"kind":"identity","identityId":identity_id,"name":name})
        }
    }
}
fn entry_value(v: &office_board::Entry) -> Value {
    let mut o = serde_json::Map::from_iter([
        ("id".into(), json!(v.id)),
        ("threadId".into(), json!(v.thread_id)),
        ("category".into(), category_value(&v.category)),
        ("author".into(), actor_value(&v.author)),
        ("revision".into(), json!(v.revision)),
        ("deleted".into(), json!(v.deleted)),
        ("createdAtMs".into(), json!(v.created_at_ms)),
        ("updatedAtMs".into(), json!(v.updated_at_ms)),
    ]);
    if let Some(title) = &v.title {
        o.insert("title".into(), json!(title));
    }
    if let Some(body) = &v.body {
        o.insert("body".into(), json!(body));
    }
    Value::Object(o)
}
fn create_value(v: office_board::CreateReceipt) -> Value {
    json!({"entryId":v.entry_id,"threadId":v.thread_id,"revision":v.revision,"created":v.created,"operationId":v.operation_id})
}
fn edit_value(v: office_board::EditReceipt) -> Value {
    json!({"entryId":v.entry_id,"revision":v.revision,"changed":v.changed,"operationId":v.operation_id})
}
fn delete_value(v: office_board::DeleteReceipt) -> Value {
    json!({"entryId":v.entry_id,"revision":v.revision,"deleted":v.deleted,"changed":v.changed,"moderated":v.moderated,"operationId":v.operation_id})
}
fn list_value(v: office_board::ListResult) -> Value {
    json!({"threads":v.threads.iter().map(|t|{let mut e=entry_value(&t.entry);if let Value::Object(ref mut o)=e{o.remove("body");o.insert("replyCount".into(),json!(t.reply_count));o.insert("activitySequence".into(),json!(t.activity_sequence));}e}).collect::<Vec<_>>(),"nextCursor":v.next_cursor,"boardRevision":v.board_revision})
}
fn show_value(v: office_board::ShowResult) -> Value {
    json!({"thread":entry_value(&v.thread),"replies":v.replies.iter().map(entry_value).collect::<Vec<_>>(),"nextCursor":v.next_cursor,"boardRevision":v.board_revision})
}
fn categories_value(v: office_board::CategoryListResult) -> Value {
    json!({"categories":v.categories.iter().map(category_value).collect::<Vec<_>>(),"nextCursor":v.next_cursor,"boardRevision":v.board_revision})
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn operation_inputs_reject_cross_operation_fields() {
        assert!(decode::<CategoriesInput>(br#"{"limit":20,"title":"x"}"#).is_err());
        assert!(decode::<PostInput>(br#"{"category":{"kind":"general"},"actor":{"kind":"owner"},"title":"t","body":"b","cursor":"x"}"#).is_err());
        assert!(decode::<ReplyInput>(br#"{"threadId":"11111111-1111-4111-8111-111111111111","actor":{"kind":"owner"},"body":"b","title":"x"}"#).is_err());
        assert!(decode::<DeleteInput>(br#"{"entryId":"11111111-1111-4111-8111-111111111111","actor":{"kind":"owner"},"ifRevision":1,"operationId":null}"#).is_err());
    }

    #[test]
    fn optional_nulls_are_accepted_but_required_fields_are_not() {
        assert!(decode::<CategoriesInput>(br#"{"limit":null,"cursor":null}"#).is_ok());
        assert!(decode::<PostInput>(br#"{"category":{"kind":"general"},"actor":{"kind":"owner"},"title":"t","body":"b","operationId":null}"#).is_ok());
        assert!(decode::<DeleteInput>(br#"{"entryId":"11111111-1111-4111-8111-111111111111","actor":{"kind":"owner"},"moderate":false,"ifRevision":1,"operationId":null}"#).is_ok());
    }

    #[test]
    fn invalid_wire_input_has_no_database_or_owner_side_effect() {
        let directory = crate::test_support::TestDirectory::new();
        let database = directory.path.join("missing/state.db");
        let output = execute_at(
            OfficeInvocation::BoardPost,
            br#"{"category":{"kind":"general"},"actor":{"kind":"owner"},"title":"","body":"b"}"#,
            &database,
        );
        assert_eq!(output, br#"{"error":"BOARD_INVALID"}"#);
        assert!(!database.exists());
    }
}
