//! SQLite repository for the installation-owned local Office discussion board.

use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};
use tmt_core::office_board::{
    Actor, AuthorFilter, BoardError, BoardErrorCode, Category, CategoryListRequest,
    CategoryListResult, CreateReceipt, Cursor, DeleteReceipt, DeleteRequest, EditReceipt,
    EditRequest, Entry, ListRequest, ListResult, ListView, OfficeBoardRepository, PostRequest,
    REPLY_LIMIT, ReplyRequest, ShowRequest, ShowResult, ThreadSummary,
};

use super::{
    Storage, StorageError, StorageErrorCode, errors::classify,
    identities::with_immediate_transaction,
};

impl From<StorageError> for BoardError<StorageError> {
    fn from(error: StorageError) -> Self {
        Self::storage(error)
    }
}

pub fn local_owner_actor(storage: &mut Storage) -> Result<Actor, StorageError> {
    with_immediate_transaction(storage, "local Office owner", |transaction| {
        if let Some(id) = transaction
            .query_row(
                "SELECT id FROM office_local_worlds WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| classify(error, "Read local Office world"))?
        {
            return Ok(Actor::Owner { world_id: id });
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO office_local_worlds (singleton, id, created_at_ms) VALUES (1, ?, ?)",
                params![id, timestamp()?],
            )
            .map_err(|error| classify(error, "Create local Office world"))?;
        Ok(Actor::Owner { world_id: id })
    })
}

impl OfficeBoardRepository for Storage {
    type Error = StorageError;

    fn post(&mut self, request: &PostRequest) -> Result<CreateReceipt, BoardError<Self::Error>> {
        tmt_core::office_board::validate_post(request)?;
        with_immediate_transaction(self, "Office board post", |tx| {
            let actor = active_actor(tx, &request.actor)?;
            let digest = intent(&[
                "post",
                &category_key(&request.category),
                &request.title,
                &request.body,
            ]);
            if let Some(receipt) = replay_create(tx, &actor.key(), &request.operation_id, &digest)?
            {
                return Ok(receipt);
            }
            let sequence = next_sequence(tx)?;
            let id = uuid::Uuid::new_v4().to_string();
            let now = timestamp()?;
            let (category_kind, repository_id) = category_columns(&request.category);
            let (author_kind, author_id, author_name) = actor_columns(&actor);
            tx.execute("INSERT INTO office_board_entries (id,thread_id,is_root,category_kind,repository_id,author_kind,author_id,author_name,revision,deleted,created_sequence,activity_sequence,created_at_ms,updated_at_ms,title,body) VALUES (?,?,1,?,?,?,?,?,1,0,?,?,?,?,?,?)",
                params![id,id,category_kind,repository_id,author_kind,author_id,author_name,sequence as i64,sequence as i64,now,now,request.title,request.body])
                .map_err(|error| BoardError::storage(classify(error, "Create Office board thread")))?;
            advance_board(tx)?;
            let receipt = CreateReceipt {
                entry_id: id.clone(),
                thread_id: id.clone(),
                revision: 1,
                created: true,
                operation_id: request.operation_id.clone(),
            };
            store_create(tx, &actor.key(), &digest, &receipt)?;
            Ok(receipt)
        })
    }

    fn reply(&mut self, request: &ReplyRequest) -> Result<CreateReceipt, BoardError<Self::Error>> {
        tmt_core::office_board::validate_reply(request)?;
        with_immediate_transaction(self, "Office board reply", |tx| {
            let actor = active_actor(tx, &request.actor)?;
            let digest = intent(&["reply", &request.thread_id, &request.body]);
            if let Some(receipt) = replay_create(tx, &actor.key(), &request.operation_id, &digest)?
            {
                return Ok(receipt);
            }
            let root = tx.query_row("SELECT category_kind,repository_id,deleted FROM office_board_entries WHERE id=? AND is_root=1", [&request.thread_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,row.get::<_,bool>(2)?))).optional().map_err(|e| BoardError::storage(classify(e,"Read Office board thread")))?.ok_or_else(|| BoardError::policy(BoardErrorCode::ThreadNotFound))?;
            if root.2 {
                return Err(BoardError::policy(BoardErrorCode::ThreadNotFound));
            }
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM office_board_entries WHERE thread_id=? AND is_root=0",
                    [&request.thread_id],
                    |row| row.get(0),
                )
                .map_err(|e| BoardError::storage(classify(e, "Count Office board replies")))?;
            if count >= REPLY_LIMIT as i64 {
                return Err(BoardError::policy(BoardErrorCode::Invalid));
            }
            let sequence = next_sequence(tx)?;
            let id = uuid::Uuid::new_v4().to_string();
            let now = timestamp()?;
            let (author_kind, author_id, author_name) = actor_columns(&actor);
            tx.execute("INSERT INTO office_board_entries (id,thread_id,is_root,category_kind,repository_id,author_kind,author_id,author_name,revision,deleted,created_sequence,activity_sequence,created_at_ms,updated_at_ms,title,body) VALUES (?,?,0,?,?,?,?,?,1,0,?,?,?,?,NULL,?)", params![id,request.thread_id,root.0,root.1,author_kind,author_id,author_name,sequence as i64,sequence as i64,now,now,request.body]).map_err(|e| BoardError::storage(classify(e,"Create Office board reply")))?;
            tx.execute(
                "UPDATE office_board_entries SET activity_sequence=?,updated_at_ms=? WHERE id=?",
                params![sequence as i64, now, request.thread_id],
            )
            .map_err(|e| BoardError::storage(classify(e, "Update Office board activity")))?;
            advance_board(tx)?;
            let receipt = CreateReceipt {
                entry_id: id,
                thread_id: request.thread_id.clone(),
                revision: 1,
                created: true,
                operation_id: request.operation_id.clone(),
            };
            store_create(tx, &actor.key(), &digest, &receipt)?;
            Ok(receipt)
        })
    }

    fn edit(&mut self, request: &EditRequest) -> Result<EditReceipt, BoardError<Self::Error>> {
        tmt_core::office_board::validate_edit(request)?;
        with_immediate_transaction(self, "Office board edit", |tx| {
            let actor = active_actor(tx, &request.actor)?;
            let digest = edit_intent(request);
            if let Some(value) = replay_edit(tx, &actor.key(), &request.operation_id, &digest)? {
                return Ok(value);
            }
            let row = entry_edit_row(tx, &request.entry_id)?
                .ok_or_else(|| BoardError::policy(BoardErrorCode::EntryNotFound))?;
            if row.revision != request.expected_revision {
                return Err(BoardError::policy(BoardErrorCode::RevisionConflict));
            }
            if row.author_key != actor.key() {
                return Err(BoardError::policy(BoardErrorCode::Forbidden));
            }
            if request.title.is_some() && !row.is_root {
                return Err(BoardError::policy(BoardErrorCode::Invalid));
            }
            if !row.is_root
                && request
                    .body
                    .as_ref()
                    .is_some_and(|body| body.len() > tmt_core::office_board::REPLY_BODY_MAX_BYTES)
            {
                return Err(BoardError::policy(BoardErrorCode::Invalid));
            }
            if row.deleted {
                return Err(BoardError::policy(BoardErrorCode::Forbidden));
            }
            let body = request.body.as_deref().unwrap_or(&row.body);
            let title = request.title.as_deref().or(row.title.as_deref());
            let changed = body != row.body || title != row.title.as_deref();
            let revision = if changed {
                let sequence = next_sequence(tx)?;
                let revision = row.revision + 1;
                let now = timestamp()?;
                tx.execute("UPDATE office_board_entries SET title=?,body=?,revision=?,updated_at_ms=? WHERE id=?",params![title,body,revision as i64,now,request.entry_id]).map_err(|e|BoardError::storage(classify(e,"Edit Office board entry")))?;
                tx.execute("UPDATE office_board_entries SET activity_sequence=?,updated_at_ms=? WHERE id=?",params![sequence as i64,now,row.thread_id]).map_err(|e|BoardError::storage(classify(e,"Update Office board activity")))?;
                advance_board(tx)?;
                revision
            } else {
                row.revision
            };
            let receipt = EditReceipt {
                entry_id: request.entry_id.clone(),
                revision,
                changed,
                operation_id: request.operation_id.clone(),
            };
            store_edit(tx, &actor.key(), &digest, &receipt)?;
            Ok(receipt)
        })
    }

    fn delete(
        &mut self,
        request: &DeleteRequest,
    ) -> Result<DeleteReceipt, BoardError<Self::Error>> {
        tmt_core::office_board::validate_delete(request)?;
        with_immediate_transaction(self, "Office board delete", |tx| {
            let actor = active_actor(tx, &request.actor)?;
            let digest = intent(&[
                "delete",
                &request.entry_id,
                &request.expected_revision.to_string(),
                if request.moderate {
                    "moderate"
                } else {
                    "author"
                },
            ]);
            if let Some(value) = replay_delete(tx, &actor.key(), &request.operation_id, &digest)? {
                return Ok(value);
            }
            let row = entry_edit_row(tx, &request.entry_id)?
                .ok_or_else(|| BoardError::policy(BoardErrorCode::EntryNotFound))?;
            if row.revision != request.expected_revision {
                return Err(BoardError::policy(BoardErrorCode::RevisionConflict));
            }
            let own = row.author_key == actor.key();
            if !own && !(request.moderate && matches!(actor, Actor::Owner { .. })) {
                return Err(BoardError::policy(BoardErrorCode::Forbidden));
            }
            let changed = !row.deleted;
            let revision = if changed {
                let sequence = next_sequence(tx)?;
                let revision = row.revision + 1;
                let now = timestamp()?;
                tx.execute("UPDATE office_board_entries SET deleted=1,title=NULL,body=NULL,revision=?,updated_at_ms=? WHERE id=?",params![revision as i64,now,request.entry_id]).map_err(|e|BoardError::storage(classify(e,"Delete Office board entry")))?;
                tx.execute("UPDATE office_board_entries SET activity_sequence=?,updated_at_ms=? WHERE id=?",params![sequence as i64,now,row.thread_id]).map_err(|e|BoardError::storage(classify(e,"Update Office board activity")))?;
                advance_board(tx)?;
                revision
            } else {
                row.revision
            };
            let receipt = DeleteReceipt {
                entry_id: request.entry_id.clone(),
                revision,
                deleted: true,
                changed,
                moderated: !own,
                operation_id: request.operation_id.clone(),
            };
            store_delete(tx, &actor.key(), &digest, &receipt)?;
            Ok(receipt)
        })
    }

    fn list(&self, request: &ListRequest) -> Result<ListResult, BoardError<Self::Error>> {
        tmt_core::office_board::validate_list(request)?;
        let tx = self
            .connection()
            .map_err(BoardError::storage)?
            .unchecked_transaction()
            .map_err(|e| BoardError::storage(classify(e, "Open Office board read snapshot")))?;
        let board_revision = board_revision(&tx)?;
        let binding = list_binding(request);
        let cursor = parse_cursor(
            request.cursor.as_deref(),
            "list",
            request.limit,
            &binding,
            board_revision,
        )?;
        let last_seq = cursor
            .as_ref()
            .map_or(i64::MAX, |c| i64::try_from(c.sequence).unwrap_or(i64::MAX));
        let last_id = cursor.as_ref().map_or("~", |c| c.key.as_str());
        let (kind, repo) = category_columns(&request.category);
        let author_kind = request.author.as_ref().map(|a| {
            if matches!(a, AuthorFilter::Owner) {
                "owner"
            } else {
                "identity"
            }
        });
        let author_id = request.author.as_ref().and_then(|a| match a {
            AuthorFilter::Identity(id) => Some(id.as_str()),
            AuthorFilter::Owner => None,
        });
        let since = i64::try_from(request.since_ms.unwrap_or(0)).unwrap_or(i64::MAX);
        let take = i64::from(request.limit) + 1;
        let sql = list_sql(request.view);
        let mut statement = tx
            .prepare(&sql)
            .map_err(|e| BoardError::storage(classify(e, "Prepare Office board list")))?;
        let mapped = statement
            .query_map(
                params![
                    kind,
                    repo,
                    author_kind,
                    author_kind,
                    author_id,
                    author_id,
                    since,
                    since,
                    last_seq,
                    last_seq,
                    last_id,
                    take
                ],
                decode_summary,
            )
            .map_err(|e| BoardError::storage(classify(e, "List Office board threads")))?;
        let mut threads = mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| BoardError::storage(classify(e, "Read Office board threads")))?;
        let next = if threads.len() > request.limit as usize {
            threads.pop();
            let last = threads.last().expect("lookahead has prior item");
            let sequence = if matches!(request.view, ListView::Recent) {
                entry_sequence(&tx, &last.entry.id)?
            } else {
                last.activity_sequence
            };
            Some(
                Cursor {
                    operation: "list".into(),
                    board_revision,
                    page_size: request.limit,
                    binding,
                    sequence,
                    key: last.entry.id.clone(),
                }
                .encode(),
            )
        } else {
            None
        };
        drop(statement);
        tx.commit()
            .map_err(|e| BoardError::storage(classify(e, "Close Office board read snapshot")))?;
        Ok(ListResult {
            threads,
            next_cursor: next,
            board_revision,
        })
    }

    fn show(&self, request: &ShowRequest) -> Result<ShowResult, BoardError<Self::Error>> {
        tmt_core::office_board::validate_show(request)?;
        let tx = self
            .connection()
            .map_err(BoardError::storage)?
            .unchecked_transaction()
            .map_err(|e| BoardError::storage(classify(e, "Open Office board show snapshot")))?;
        let rev = board_revision(&tx)?;
        let binding = request.thread_id.clone();
        let cursor = parse_cursor(
            request.reply_cursor.as_deref(),
            "replies",
            request.reply_limit,
            &binding,
            rev,
        )?;
        let after = cursor.as_ref().map_or(0, |c| c.sequence);
        let thread = query_entry(&tx, &request.thread_id)?
            .filter(|e| e.id == e.thread_id)
            .ok_or_else(|| BoardError::policy(BoardErrorCode::ThreadNotFound))?;
        let mut statement = tx
            .prepare(REPLIES_SQL)
            .map_err(|e| BoardError::storage(classify(e, "Prepare Office board replies")))?;
        let rows = statement
            .query_map(
                params![
                    request.thread_id,
                    after as i64,
                    i64::from(request.reply_limit) + 1
                ],
                |row| Ok((decode_entry(row)?, row.get::<_, i64>(13)? as u64)),
            )
            .map_err(|e| BoardError::storage(classify(e, "List Office board replies")))?;
        let mut values = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| BoardError::storage(classify(e, "Read Office board replies")))?;
        let next = if values.len() > request.reply_limit as usize {
            values.pop();
            let last = values.last().unwrap();
            Some(
                Cursor {
                    operation: "replies".into(),
                    board_revision: rev,
                    page_size: request.reply_limit,
                    binding,
                    sequence: last.1,
                    key: last.0.id.clone(),
                }
                .encode(),
            )
        } else {
            None
        };
        let replies = values.into_iter().map(|v| v.0).collect();
        drop(statement);
        tx.commit()
            .map_err(|e| BoardError::storage(classify(e, "Close Office board show snapshot")))?;
        Ok(ShowResult {
            thread,
            replies,
            next_cursor: next,
            board_revision: rev,
        })
    }

    fn categories(
        &self,
        request: &CategoryListRequest,
    ) -> Result<CategoryListResult, BoardError<Self::Error>> {
        tmt_core::office_board::validate_category_list(request)?;
        let tx = self
            .connection()
            .map_err(BoardError::storage)?
            .unchecked_transaction()
            .map_err(|e| BoardError::storage(classify(e, "Open Office board category snapshot")))?;
        let rev = board_revision(&tx)?;
        let cursor = parse_cursor(
            request.cursor.as_deref(),
            "categories",
            request.limit,
            "",
            rev,
        )?;
        let after = cursor.as_ref().map(|c| c.key.as_str());
        let include_general = after.is_none();
        let repo_take = request.limit as usize - usize::from(include_general);
        let mut statement=tx.prepare("SELECT DISTINCT repository_id FROM office_board_entries WHERE is_root=1 AND category_kind='repository' AND (? IS NULL OR repository_id>?) ORDER BY repository_id COLLATE BINARY LIMIT ?").map_err(|e|BoardError::storage(classify(e,"Prepare Office board categories")))?;
        let repos = statement
            .query_map(
                params![after, after, i64::try_from(repo_take + 1).unwrap()],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| BoardError::storage(classify(e, "List Office board categories")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| BoardError::storage(classify(e, "Read Office board categories")))?;
        let mut categories = Vec::new();
        if include_general {
            categories.push(Category::General);
        }
        categories.extend(
            repos
                .iter()
                .take(repo_take)
                .cloned()
                .map(Category::Repository),
        );
        let next = if repos.len() > repo_take {
            let key = if repo_take == 0 {
                String::new()
            } else {
                repos[repo_take - 1].clone()
            };
            Some(
                Cursor {
                    operation: "categories".into(),
                    board_revision: rev,
                    page_size: request.limit,
                    binding: String::new(),
                    sequence: 0,
                    key,
                }
                .encode(),
            )
        } else {
            None
        };
        drop(statement);
        tx.commit().map_err(|e| {
            BoardError::storage(classify(e, "Close Office board category snapshot"))
        })?;
        Ok(CategoryListResult {
            categories,
            next_cursor: next,
            board_revision: rev,
        })
    }
}

const REPLIES_SQL: &str = "SELECT id,thread_id,category_kind,repository_id,author_kind,author_id,author_name,revision,deleted,created_at_ms,updated_at_ms,title,body,created_sequence FROM office_board_entries WHERE thread_id=? AND is_root=0 AND created_sequence>? ORDER BY created_sequence,id LIMIT ?";
fn list_sql(view: ListView) -> String {
    let (sequence, time) = if matches!(view, ListView::Recent) {
        ("created_sequence", "created_at_ms")
    } else {
        ("activity_sequence", "updated_at_ms")
    };
    format!(
        "SELECT id,thread_id,category_kind,repository_id,author_kind,author_id,author_name,revision,deleted,created_at_ms,updated_at_ms,title,body,activity_sequence,(SELECT count(*) FROM office_board_entries r WHERE r.thread_id=e.id AND r.is_root=0 AND r.deleted=0) FROM office_board_entries e WHERE is_root=1 AND category_kind=? AND repository_id IS ? AND (? IS NULL OR author_kind=?) AND (? IS NULL OR author_id=?) AND (?=0 OR {time}>=?) AND ({sequence}<? OR ({sequence}=? AND id<?)) ORDER BY {sequence} DESC,id DESC LIMIT ?"
    )
}

struct EditRow {
    thread_id: String,
    is_root: bool,
    author_key: String,
    revision: u64,
    deleted: bool,
    title: Option<String>,
    body: String,
}
fn entry_edit_row(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Option<EditRow>, BoardError<StorageError>> {
    tx.query_row("SELECT thread_id,is_root,author_kind,author_id,revision,deleted,title,COALESCE(body,'') FROM office_board_entries WHERE id=?",[id],|r|Ok(EditRow{thread_id:r.get(0)?,is_root:r.get(1)?,author_key:format!("{}:{}",r.get::<_,String>(2)?,r.get::<_,String>(3)?),revision:r.get::<_,i64>(4)? as u64,deleted:r.get(5)?,title:r.get(6)?,body:r.get(7)?})).optional().map_err(|e|BoardError::storage(classify(e,"Read Office board entry")))
}
fn active_actor(tx: &Transaction<'_>, actor: &Actor) -> Result<Actor, BoardError<StorageError>> {
    match actor {
        Actor::Identity { identity_id, .. } => tx
            .query_row(
                "SELECT name FROM identities WHERE id=? AND retired_at_ms IS NULL",
                [identity_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| BoardError::storage(classify(e, "Revalidate Office board identity")))?
            .map(|name| Actor::Identity {
                identity_id: identity_id.clone(),
                name,
            })
            .ok_or_else(|| BoardError::policy(BoardErrorCode::Forbidden)),
        Actor::Owner { world_id } => {
            let matches: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM office_local_worlds WHERE singleton=1 AND id=?)",
                    [world_id],
                    |r| r.get(0),
                )
                .map_err(|e| BoardError::storage(classify(e, "Revalidate Office board owner")))?;
            if matches {
                Ok(actor.clone())
            } else {
                Err(BoardError::policy(BoardErrorCode::Forbidden))
            }
        }
    }
}
fn next_sequence(tx: &Transaction<'_>) -> Result<u64, BoardError<StorageError>> {
    let value:i64=tx.query_row("UPDATE office_board_state SET next_sequence=next_sequence+1 WHERE singleton=1 RETURNING next_sequence-1",[],|r|r.get(0)).map_err(|e|BoardError::storage(classify(e,"Allocate Office board sequence")))?;
    Ok(value as u64)
}
fn advance_board(tx: &Transaction<'_>) -> Result<(), BoardError<StorageError>> {
    tx.execute(
        "UPDATE office_board_state SET revision=revision+1 WHERE singleton=1",
        [],
    )
    .map_err(|e| BoardError::storage(classify(e, "Advance Office board revision")))?;
    Ok(())
}
fn board_revision(tx: &Transaction<'_>) -> Result<u64, BoardError<StorageError>> {
    tx.query_row(
        "SELECT revision FROM office_board_state WHERE singleton=1",
        [],
        |r| r.get::<_, i64>(0).map(|v| v as u64),
    )
    .map_err(|e| BoardError::storage(classify(e, "Read Office board revision")))
}
fn timestamp() -> Result<i64, StorageError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| {
            StorageError::new(super::StorageErrorCode::Unknown, "Read system clock failed")
                .caused_by(e)
        })?
        .as_millis()
        .try_into()
        .map_err(|e| {
            StorageError::new(
                super::StorageErrorCode::Unknown,
                "System timestamp is too large",
            )
            .caused_by(e)
        })
}
fn category_columns(c: &Category) -> (&'static str, Option<&str>) {
    match c {
        Category::General => ("general", None),
        Category::Repository(id) => ("repository", Some(id)),
    }
}
fn category_key(c: &Category) -> String {
    match c {
        Category::General => "general".into(),
        Category::Repository(id) => format!("repository:{id}"),
    }
}
fn actor_columns(a: &Actor) -> (&'static str, &str, Option<&str>) {
    match a {
        Actor::Owner { world_id } => ("owner", world_id, None),
        Actor::Identity { identity_id, name } => ("identity", identity_id, Some(name)),
    }
}
fn intent(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn edit_intent(request: &EditRequest) -> String {
    let revision = request.expected_revision.to_string();
    let mut parts = vec!["edit", request.entry_id.as_str(), revision.as_str()];
    match &request.title {
        Some(value) => parts.extend(["title:some", value.as_str()]),
        None => parts.push("title:none"),
    }
    match &request.body {
        Some(value) => parts.extend(["body:some", value.as_str()]),
        None => parts.push("body:none"),
    }
    intent(&parts)
}
fn list_binding(r: &ListRequest) -> String {
    format!(
        "{}|{:?}|{:?}|{:?}",
        category_key(&r.category),
        r.view,
        r.author,
        r.since_ms
    )
}
fn parse_cursor(
    value: Option<&str>,
    op: &str,
    limit: u32,
    binding: &str,
    revision: u64,
) -> Result<Option<Cursor>, BoardError<StorageError>> {
    let Some(value) = value else { return Ok(None) };
    let c = Cursor::parse(value).map_err(|e| BoardError::policy(e.code))?;
    if c.operation != op || c.page_size != limit || c.binding != binding {
        return Err(BoardError::policy(BoardErrorCode::CursorInvalid));
    }
    if c.board_revision != revision {
        return Err(BoardError::policy(BoardErrorCode::CursorStale));
    }
    Ok(Some(c))
}
fn decode_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let kind: String = row.get(2)?;
    let repo: Option<String> = row.get(3)?;
    let author_kind: String = row.get(4)?;
    let author_id: String = row.get(5)?;
    let name: Option<String> = row.get(6)?;
    Ok(Entry {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        category: if kind == "general" {
            Category::General
        } else {
            Category::Repository(repo.unwrap_or_default())
        },
        author: if author_kind == "owner" {
            Actor::Owner {
                world_id: author_id,
            }
        } else {
            Actor::Identity {
                identity_id: author_id,
                name: name.unwrap_or_default(),
            }
        },
        revision: row.get::<_, i64>(7)? as u64,
        deleted: row.get(8)?,
        created_at_ms: row.get::<_, i64>(9)? as u64,
        updated_at_ms: row.get::<_, i64>(10)? as u64,
        title: row.get(11)?,
        body: row.get(12)?,
    })
}
fn decode_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadSummary> {
    Ok(ThreadSummary {
        entry: decode_entry(row)?,
        activity_sequence: row.get::<_, i64>(13)? as u64,
        reply_count: row.get::<_, i64>(14)? as u64,
    })
}
fn query_entry(tx: &Transaction<'_>, id: &str) -> Result<Option<Entry>, BoardError<StorageError>> {
    tx.query_row("SELECT id,thread_id,category_kind,repository_id,author_kind,author_id,author_name,revision,deleted,created_at_ms,updated_at_ms,title,body FROM office_board_entries WHERE id=?",[id],decode_entry).optional().map_err(|e|BoardError::storage(classify(e,"Read Office board entry")))
}
fn entry_sequence(tx: &Transaction<'_>, id: &str) -> Result<u64, BoardError<StorageError>> {
    tx.query_row(
        "SELECT created_sequence FROM office_board_entries WHERE id=?",
        [id],
        |r| r.get::<_, i64>(0).map(|v| v as u64),
    )
    .map_err(|e| BoardError::storage(classify(e, "Read Office board sequence")))
}

type StoredReceipt = (
    String,
    Option<String>,
    u64,
    Option<bool>,
    Option<bool>,
    Option<bool>,
    Option<bool>,
);

fn replay_row(
    tx: &Transaction<'_>,
    actor: &str,
    op: &str,
    digest: &str,
    kind: &str,
) -> Result<Option<StoredReceipt>, BoardError<StorageError>> {
    let row=tx.query_row("SELECT intent_digest,result_kind,entry_id,thread_id,revision,created,changed,deleted,moderated FROM office_board_operations WHERE actor_key=? AND operation_id=?",params![actor,op],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,i64>(4)? as u64,r.get::<_,Option<bool>>(5)?,r.get::<_,Option<bool>>(6)?,r.get::<_,Option<bool>>(7)?,r.get::<_,Option<bool>>(8)?))).optional().map_err(|e|BoardError::storage(classify(e,"Read Office board receipt")))?;
    match row {
        None => Ok(None),
        Some((d, k, id, thread, rev, created, changed, deleted, moderated))
            if d == digest && k == kind =>
        {
            Ok(Some((
                id, thread, rev, created, changed, deleted, moderated,
            )))
        }
        Some(_) => Err(BoardError::policy(BoardErrorCode::IdempotencyConflict)),
    }
}
fn replay_create(
    tx: &Transaction<'_>,
    actor: &str,
    op: &str,
    digest: &str,
) -> Result<Option<CreateReceipt>, BoardError<StorageError>> {
    replay_row(tx, actor, op, digest, "create")?
        .map(|r| {
            valid_receipt_base(&r.0, r.2)?;
            let thread_id =
                r.1.filter(|id| canonical_uuid(id))
                    .ok_or_else(corrupt_receipt)?;
            if r.3 != Some(true) || r.4.is_some() || r.5.is_some() || r.6.is_some() {
                return Err(corrupt_receipt());
            }
            Ok(CreateReceipt {
                entry_id: r.0,
                thread_id,
                revision: r.2,
                created: true,
                operation_id: op.into(),
            })
        })
        .transpose()
}
fn replay_edit(
    tx: &Transaction<'_>,
    actor: &str,
    op: &str,
    digest: &str,
) -> Result<Option<EditReceipt>, BoardError<StorageError>> {
    replay_row(tx, actor, op, digest, "edit")?
        .map(|r| {
            valid_receipt_base(&r.0, r.2)?;
            if r.1.is_some() || r.3.is_some() || r.4.is_none() || r.5.is_some() || r.6.is_some() {
                return Err(corrupt_receipt());
            }
            Ok(EditReceipt {
                entry_id: r.0,
                revision: r.2,
                changed: r.4.unwrap(),
                operation_id: op.into(),
            })
        })
        .transpose()
}
fn replay_delete(
    tx: &Transaction<'_>,
    actor: &str,
    op: &str,
    digest: &str,
) -> Result<Option<DeleteReceipt>, BoardError<StorageError>> {
    replay_row(tx, actor, op, digest, "delete")?
        .map(|r| {
            valid_receipt_base(&r.0, r.2)?;
            if r.1.is_some() || r.3.is_some() || r.4.is_none() || r.5 != Some(true) || r.6.is_none()
            {
                return Err(corrupt_receipt());
            }
            Ok(DeleteReceipt {
                entry_id: r.0,
                revision: r.2,
                deleted: true,
                changed: r.4.unwrap(),
                moderated: r.6.unwrap(),
                operation_id: op.into(),
            })
        })
        .transpose()
}
fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.to_string() == value)
}
fn corrupt_receipt() -> BoardError<StorageError> {
    BoardError::storage(StorageError::new(
        StorageErrorCode::Corrupt,
        "Read Office board receipt failed",
    ))
}
fn valid_receipt_base(id: &str, revision: u64) -> Result<(), BoardError<StorageError>> {
    if canonical_uuid(id) && (1..=tmt_core::limits::MAX_JS_SAFE_INTEGER).contains(&revision) {
        Ok(())
    } else {
        Err(corrupt_receipt())
    }
}
fn store_create(
    tx: &Transaction<'_>,
    actor: &str,
    digest: &str,
    r: &CreateReceipt,
) -> Result<(), BoardError<StorageError>> {
    tx.execute("INSERT INTO office_board_operations(actor_key,operation_id,intent_digest,result_kind,entry_id,thread_id,revision,created)VALUES(?,?,?,'create',?,?,?,?)",params![actor,r.operation_id,digest,r.entry_id,r.thread_id,r.revision as i64,r.created]).map_err(|e|BoardError::storage(classify(e,"Store Office board receipt")))?;
    Ok(())
}
fn store_edit(
    tx: &Transaction<'_>,
    actor: &str,
    digest: &str,
    r: &EditReceipt,
) -> Result<(), BoardError<StorageError>> {
    tx.execute("INSERT INTO office_board_operations(actor_key,operation_id,intent_digest,result_kind,entry_id,revision,changed)VALUES(?,?,?,'edit',?,?,?)",params![actor,r.operation_id,digest,r.entry_id,r.revision as i64,r.changed]).map_err(|e|BoardError::storage(classify(e,"Store Office board receipt")))?;
    Ok(())
}
fn store_delete(
    tx: &Transaction<'_>,
    actor: &str,
    digest: &str,
    r: &DeleteReceipt,
) -> Result<(), BoardError<StorageError>> {
    tx.execute("INSERT INTO office_board_operations(actor_key,operation_id,intent_digest,result_kind,entry_id,revision,changed,deleted,moderated)VALUES(?,?,?,'delete',?,?,?,1,?)",params![actor,r.operation_id,digest,r.entry_id,r.revision as i64,r.changed,r.moderated]).map_err(|e|BoardError::storage(classify(e,"Store Office board receipt")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;

    fn insert_identity(storage: &Storage, id: &str, name: &str) {
        storage.connection().unwrap().execute("INSERT INTO identities (id,name,canonical_name,lifetime,created_at,updated_at) VALUES (?,?,?,'temporary','now','now')",params![id,name,name]).unwrap();
    }
    fn post(storage: &mut Storage, actor: Actor, operation_id: &str) -> CreateReceipt {
        storage
            .post(&PostRequest {
                category: Category::General,
                actor,
                title: "Hello".into(),
                body: "Body\tline\n".into(),
                operation_id: operation_id.into(),
            })
            .unwrap()
    }

    #[test]
    fn mutations_replay_without_activity_and_soft_delete_without_body_receipts() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let identity_id = "11111111-1111-4111-8111-111111111111";
        insert_identity(&storage, identity_id, "alice");
        let actor = Actor::Identity {
            identity_id: identity_id.into(),
            name: "stale name ignored".into(),
        };
        let operation = "22222222-2222-4222-8222-222222222222";
        let created = post(&mut storage, actor.clone(), operation);
        assert_eq!(post(&mut storage, actor.clone(), operation), created);
        let revision: u64 = storage
            .connection()
            .unwrap()
            .query_row("SELECT revision FROM office_board_state", [], |r| {
                r.get::<_, i64>(0).map(|v| v as u64)
            })
            .unwrap();
        assert_eq!(revision, 1);
        let reply = storage
            .reply(&ReplyRequest {
                thread_id: created.thread_id.clone(),
                actor: actor.clone(),
                body: "reply".into(),
                operation_id: "33333333-3333-4333-8333-333333333333".into(),
            })
            .unwrap();
        let invalid = storage
            .edit(&EditRequest {
                entry_id: reply.entry_id.clone(),
                actor: actor.clone(),
                title: None,
                body: Some("x".repeat(tmt_core::office_board::REPLY_BODY_MAX_BYTES + 1)),
                expected_revision: 1,
                operation_id: "55555555-5555-4555-8555-555555555555".into(),
            })
            .unwrap_err();
        assert_eq!(invalid.code, BoardErrorCode::Invalid);
        let preserved: String = storage
            .connection()
            .unwrap()
            .query_row(
                "SELECT body FROM office_board_entries WHERE id=?",
                [&reply.entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, "reply");
        let listed = storage
            .list(&ListRequest {
                category: Category::General,
                view: ListView::Updated,
                author: None,
                since_ms: None,
                limit: 1,
                cursor: None,
            })
            .unwrap();
        assert_eq!(listed.threads[0].reply_count, 1);
        assert_eq!(
            listed.threads[0].entry.author,
            Actor::Identity {
                identity_id: identity_id.into(),
                name: "alice".into()
            }
        );
        assert_eq!(post(&mut storage, actor.clone(), operation), created);
        assert_eq!(
            storage
                .post(&PostRequest {
                    category: Category::General,
                    actor: actor.clone(),
                    title: "Hello".into(),
                    body: "different".into(),
                    operation_id: operation.into()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::IdempotencyConflict
        );
        let deleted = storage
            .delete(&DeleteRequest {
                entry_id: reply.entry_id.clone(),
                actor: actor.clone(),
                moderate: false,
                expected_revision: 1,
                operation_id: "44444444-4444-4444-8444-444444444444".into(),
            })
            .unwrap();
        assert!(deleted.changed);
        let stored: (Option<String>, Option<String>) = storage
            .connection()
            .unwrap()
            .query_row(
                "SELECT title,body FROM office_board_entries WHERE id=?",
                [reply.entry_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (None, None));
        let receipt_columns: String = storage
            .connection()
            .unwrap()
            .query_row(
                "SELECT group_concat(name,',') FROM pragma_table_info('office_board_operations')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!receipt_columns.contains("body"));
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE identities SET retired_at_ms=1 WHERE id=?",
                [identity_id],
            )
            .unwrap();
        assert_eq!(
            storage
                .post(&PostRequest {
                    category: Category::General,
                    actor: actor.clone(),
                    title: "Hello".into(),
                    body: "Body\tline\n".into(),
                    operation_id: operation.into()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::Forbidden
        );
        let replacement = "66666666-6666-4666-8666-666666666666";
        insert_identity(&storage, replacement, "alice");
        assert_eq!(
            storage
                .edit(&EditRequest {
                    entry_id: created.entry_id,
                    actor: Actor::Identity {
                        identity_id: replacement.into(),
                        name: "alice".into()
                    },
                    title: Some("stolen".into()),
                    body: None,
                    expected_revision: 1,
                    operation_id: "77777777-7777-4777-8777-777777777777".into()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::Forbidden
        );
        storage.close().unwrap();
    }

    #[test]
    fn cursors_go_stale_and_category_pages_are_bounded() {
        let directory = TestDirectory::new();
        let database = directory.path.join("state.db");
        let mut storage = Storage::open(&database).unwrap();
        let owner = local_owner_actor(&mut storage).unwrap();
        for index in 0..55 {
            storage
                .post(&PostRequest {
                    category: Category::Repository(format!("host/Repo{index:02}")),
                    actor: owner.clone(),
                    title: "t".into(),
                    body: "b".into(),
                    operation_id: uuid::Uuid::new_v4().to_string(),
                })
                .unwrap();
        }
        let first = storage
            .categories(&CategoryListRequest {
                limit: 50,
                cursor: None,
            })
            .unwrap();
        assert_eq!(first.categories.len(), 50);
        assert!(matches!(first.categories[0], Category::General));
        let second = storage
            .categories(&CategoryListRequest {
                limit: 50,
                cursor: first.next_cursor.clone(),
            })
            .unwrap();
        assert_eq!(second.categories.len(), 6);
        storage
            .post(&PostRequest {
                category: Category::General,
                actor: owner,
                title: "t".into(),
                body: "b".into(),
                operation_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
        let stale = storage
            .categories(&CategoryListRequest {
                limit: 50,
                cursor: first.next_cursor,
            })
            .unwrap_err();
        assert_eq!(stale.code, BoardErrorCode::CursorStale);
        storage.close().unwrap();
        let mut reopened = Storage::open(database).unwrap();
        let general = reopened
            .categories(&CategoryListRequest {
                limit: 1,
                cursor: None,
            })
            .unwrap();
        assert_eq!(general.categories, vec![Category::General]);
        let repository = reopened
            .categories(&CategoryListRequest {
                limit: 1,
                cursor: general.next_cursor,
            })
            .unwrap();
        assert_eq!(
            repository.categories,
            vec![Category::Repository("host/Repo00".into())]
        );
        let plan: String = reopened.connection().unwrap().query_row(
            "EXPLAIN QUERY PLAN SELECT DISTINCT repository_id FROM office_board_entries WHERE is_root=1 AND category_kind='repository' ORDER BY repository_id COLLATE BINARY LIMIT 51",
            [],
            |row| row.get(3),
        ).unwrap();
        assert!(plan.contains("office_board_categories"), "{plan}");
        reopened.close().unwrap();
    }

    #[test]
    fn owner_moderation_is_explicit_and_never_grants_editing() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        insert_identity(&storage, id, "alice");
        let entry = post(
            &mut storage,
            Actor::Identity {
                identity_id: id.into(),
                name: "alice".into(),
            },
            "22222222-2222-4222-8222-222222222222",
        );
        let owner = local_owner_actor(&mut storage).unwrap();
        assert_eq!(
            storage
                .edit(&EditRequest {
                    entry_id: entry.entry_id.clone(),
                    actor: owner.clone(),
                    title: Some("owner rewrite".into()),
                    body: None,
                    expected_revision: 1,
                    operation_id: "33333333-3333-4333-8333-333333333333".into()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::Forbidden
        );
        assert_eq!(
            storage
                .delete(&DeleteRequest {
                    entry_id: entry.entry_id.clone(),
                    actor: owner.clone(),
                    moderate: false,
                    expected_revision: 1,
                    operation_id: "44444444-4444-4444-8444-444444444444".into()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::Forbidden
        );
        let receipt = storage
            .delete(&DeleteRequest {
                entry_id: entry.entry_id,
                actor: owner,
                moderate: true,
                expected_revision: 1,
                operation_id: "55555555-5555-4555-8555-555555555555".into(),
            })
            .unwrap();
        assert!(receipt.moderated);
        storage.close().unwrap();
    }

    #[test]
    fn reply_limit_is_exact_and_rejection_has_no_partial_write() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let owner = local_owner_actor(&mut storage).unwrap();
        let root = post(
            &mut storage,
            owner.clone(),
            "11111111-1111-4111-8111-111111111111",
        );
        for _ in 0..REPLY_LIMIT {
            storage
                .reply(&ReplyRequest {
                    thread_id: root.thread_id.clone(),
                    actor: owner.clone(),
                    body: "r".into(),
                    operation_id: uuid::Uuid::new_v4().to_string(),
                })
                .unwrap();
        }
        let before:(i64,i64)=storage.connection().unwrap().query_row("SELECT (SELECT count(*) FROM office_board_entries WHERE is_root=0),revision FROM office_board_state",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(
            storage
                .reply(&ReplyRequest {
                    thread_id: root.thread_id,
                    actor: owner,
                    body: "overflow".into(),
                    operation_id: uuid::Uuid::new_v4().to_string()
                })
                .unwrap_err()
                .code,
            BoardErrorCode::Invalid
        );
        let after:(i64,i64)=storage.connection().unwrap().query_row("SELECT (SELECT count(*) FROM office_board_entries WHERE is_root=0),revision FROM office_board_state",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(before, after);
        assert_eq!(before.0, REPLY_LIMIT as i64);
        storage.close().unwrap();
    }

    #[test]
    fn corrupted_create_edit_and_delete_receipts_fail_closed_without_panic() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let owner = local_owner_actor(&mut storage).unwrap();
        let op = "11111111-1111-4111-8111-111111111111";
        let created = post(&mut storage, owner.clone(), op);
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_board_operations SET thread_id=NULL WHERE operation_id=?",
                [op],
            )
            .unwrap();
        let error = storage
            .post(&PostRequest {
                category: Category::General,
                actor: owner.clone(),
                title: "Hello".into(),
                body: "Body\tline\n".into(),
                operation_id: op.into(),
            })
            .unwrap_err();
        assert_eq!(error.code, BoardErrorCode::Storage);
        assert_eq!(error.source.unwrap().code, StorageErrorCode::Corrupt);
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_board_operations SET thread_id=?,created=1 WHERE operation_id=?",
                params![created.thread_id, op],
            )
            .unwrap();
        let edit_request = EditRequest {
            entry_id: created.entry_id.clone(),
            actor: owner.clone(),
            title: Some("edit".into()),
            body: None,
            expected_revision: 1,
            operation_id: "22222222-2222-4222-8222-222222222222".into(),
        };
        let edit = storage.edit(&edit_request).unwrap();
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_board_operations SET changed=NULL WHERE operation_id=?",
                [&edit.operation_id],
            )
            .unwrap();
        let error = storage.edit(&edit_request).unwrap_err();
        assert_eq!(error.code, BoardErrorCode::Storage);
        assert_eq!(error.source.unwrap().code, StorageErrorCode::Corrupt);
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_board_operations SET changed=1 WHERE operation_id=?",
                [&edit.operation_id],
            )
            .unwrap();
        let delete_request = DeleteRequest {
            entry_id: created.entry_id,
            actor: owner,
            moderate: false,
            expected_revision: edit.revision,
            operation_id: "33333333-3333-4333-8333-333333333333".into(),
        };
        let deleted = storage.delete(&delete_request).unwrap();
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_board_operations SET deleted=NULL WHERE operation_id=?",
                [&deleted.operation_id],
            )
            .unwrap();
        let error = storage.delete(&delete_request).unwrap_err();
        assert_eq!(error.code, BoardErrorCode::Storage);
        assert_eq!(error.source.unwrap().code, StorageErrorCode::Corrupt);
        storage.close().unwrap();
    }

    #[test]
    fn list_and_reply_cursors_continue_then_stale_only_after_changed_mutation() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let owner = local_owner_actor(&mut storage).unwrap();
        let mut roots = Vec::new();
        for _ in 0..3 {
            roots.push(post(
                &mut storage,
                owner.clone(),
                &uuid::Uuid::new_v4().to_string(),
            ));
        }
        let request = ListRequest {
            category: Category::General,
            view: ListView::Recent,
            author: None,
            since_ms: None,
            limit: 2,
            cursor: None,
        };
        let first = storage.list(&request).unwrap();
        assert_eq!(first.threads.len(), 2);
        let second = storage
            .list(&ListRequest {
                cursor: first.next_cursor.clone(),
                ..request.clone()
            })
            .unwrap();
        assert_eq!(second.threads.len(), 1);
        assert_ne!(first.threads[0].entry.id, second.threads[0].entry.id);
        let root = &roots[0];
        let mut replay_request = None;
        for _ in 0..3 {
            let request = ReplyRequest {
                thread_id: root.thread_id.clone(),
                actor: owner.clone(),
                body: "r".into(),
                operation_id: uuid::Uuid::new_v4().to_string(),
            };
            storage.reply(&request).unwrap();
            replay_request = Some(request);
        }
        let show = ShowRequest {
            thread_id: root.thread_id.clone(),
            reply_limit: 2,
            reply_cursor: None,
        };
        let replies = storage.show(&show).unwrap();
        assert_eq!(replies.replies.len(), 2);
        assert_eq!(
            storage
                .show(&ShowRequest {
                    reply_cursor: replies.next_cursor.clone(),
                    ..show.clone()
                })
                .unwrap()
                .replies
                .len(),
            1
        );
        let stable_list_cursor = storage.list(&request).unwrap().next_cursor;
        let before_replay_revision = replies.board_revision;
        storage.reply(&replay_request.unwrap()).unwrap();
        assert_eq!(
            storage.show(&show).unwrap().board_revision,
            before_replay_revision
        );
        assert!(
            storage
                .list(&ListRequest {
                    cursor: stable_list_cursor.clone(),
                    ..request.clone()
                })
                .is_ok()
        );
        let noop = storage
            .edit(&EditRequest {
                entry_id: root.entry_id.clone(),
                actor: owner.clone(),
                title: Some("Hello".into()),
                body: None,
                expected_revision: 1,
                operation_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
        assert!(!noop.changed);
        assert!(
            storage
                .list(&ListRequest {
                    cursor: stable_list_cursor.clone(),
                    ..request.clone()
                })
                .is_ok()
        );
        storage
            .edit(&EditRequest {
                entry_id: root.entry_id.clone(),
                actor: owner,
                title: Some("changed".into()),
                body: None,
                expected_revision: 1,
                operation_id: uuid::Uuid::new_v4().to_string(),
            })
            .unwrap();
        assert_eq!(
            storage
                .list(&ListRequest {
                    cursor: stable_list_cursor,
                    ..request
                })
                .unwrap_err()
                .code,
            BoardErrorCode::CursorStale
        );
        assert_eq!(
            storage
                .show(&ShowRequest {
                    reply_cursor: replies.next_cursor,
                    ..show
                })
                .unwrap_err()
                .code,
            BoardErrorCode::CursorStale
        );
        storage.close().unwrap();
    }

    #[test]
    fn stale_revision_and_lost_response_replays_preserve_state_and_side_effect_tables() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let owner = local_owner_actor(&mut storage).unwrap();
        let op = "11111111-1111-4111-8111-111111111111";
        let original = post(&mut storage, owner.clone(), op);
        let edit = storage
            .edit(&EditRequest {
                entry_id: original.entry_id.clone(),
                actor: owner.clone(),
                title: Some("v2".into()),
                body: None,
                expected_revision: 1,
                operation_id: "22222222-2222-4222-8222-222222222222".into(),
            })
            .unwrap();
        let stale = storage
            .edit(&EditRequest {
                entry_id: original.entry_id.clone(),
                actor: owner.clone(),
                title: Some("lost".into()),
                body: None,
                expected_revision: 1,
                operation_id: "33333333-3333-4333-8333-333333333333".into(),
            })
            .unwrap_err();
        assert_eq!(stale.code, BoardErrorCode::RevisionConflict);
        let shown = storage
            .show(&ShowRequest {
                thread_id: original.thread_id.clone(),
                reply_limit: 20,
                reply_cursor: None,
            })
            .unwrap();
        assert_eq!(shown.thread.title.as_deref(), Some("v2"));
        assert_eq!(shown.thread.revision, edit.revision);
        let edit_replay = EditRequest {
            entry_id: original.entry_id.clone(),
            actor: owner.clone(),
            title: Some("v2".into()),
            body: None,
            expected_revision: 1,
            operation_id: "22222222-2222-4222-8222-222222222222".into(),
        };
        let delete_request = DeleteRequest {
            entry_id: original.entry_id.clone(),
            actor: owner.clone(),
            moderate: false,
            expected_revision: edit.revision,
            operation_id: "44444444-4444-4444-8444-444444444444".into(),
        };
        let deleted = storage.delete(&delete_request).unwrap();
        assert_eq!(storage.edit(&edit_replay).unwrap(), edit);
        assert_eq!(storage.delete(&delete_request).unwrap(), deleted);
        assert_eq!(post(&mut storage, owner, op), original);
        for table in [
            "request_attempts",
            "request_responses",
            "request_recipient_attention_identities",
            "identity_hooks",
        ] {
            let sql = format!("SELECT count(*) FROM {table}");
            let count: i64 = storage
                .connection()
                .unwrap()
                .query_row(&sql, [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "unexpected side effect in {table}");
        }
        storage.close().unwrap();
    }

    #[test]
    fn board_query_plans_use_recent_updated_and_reply_indexes() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        for (view, index) in [
            (ListView::Recent, "office_board_recent"),
            (ListView::Updated, "office_board_updated"),
        ] {
            let sql = format!("EXPLAIN QUERY PLAN {}", list_sql(view));
            let plan = storage
                .connection()
                .unwrap()
                .prepare(&sql)
                .unwrap()
                .query_map(
                    params![
                        "general",
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        Option::<String>::None,
                        0_i64,
                        0_i64,
                        i64::MAX,
                        i64::MAX,
                        "~",
                        21_i64
                    ],
                    |r| r.get::<_, String>(3),
                )
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(" ");
            assert!(plan.contains(index), "{plan}");
            assert!(!plan.contains("SCAN office_board_entries"), "{plan}");
        }
        let sql = format!("EXPLAIN QUERY PLAN {REPLIES_SQL}");
        let plan = storage
            .connection()
            .unwrap()
            .prepare(&sql)
            .unwrap()
            .query_map(
                params!["11111111-1111-4111-8111-111111111111", 0_i64, 21_i64],
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join(" ");
        assert!(plan.contains("office_board_replies"), "{plan}");
        assert!(!plan.contains("SCAN office_board_entries"), "{plan}");
        storage.close().unwrap();
    }

    #[test]
    fn independently_committed_replies_have_exact_count_and_monotonic_revision() {
        let directory = TestDirectory::new();
        let database = directory.path.join("state.db");
        let mut first = Storage::open(&database).unwrap();
        let owner = local_owner_actor(&mut first).unwrap();
        let root = post(
            &mut first,
            owner.clone(),
            "11111111-1111-4111-8111-111111111111",
        );
        first.close().unwrap();
        let mut second = Storage::open(&database).unwrap();
        second
            .reply(&ReplyRequest {
                thread_id: root.thread_id.clone(),
                actor: owner.clone(),
                body: "one".into(),
                operation_id: "22222222-2222-4222-8222-222222222222".into(),
            })
            .unwrap();
        let first_revision: i64 = second
            .connection()
            .unwrap()
            .query_row("SELECT revision FROM office_board_state", [], |r| r.get(0))
            .unwrap();
        second.close().unwrap();
        let mut third = Storage::open(&database).unwrap();
        third
            .reply(&ReplyRequest {
                thread_id: root.thread_id,
                actor: owner,
                body: "two".into(),
                operation_id: "33333333-3333-4333-8333-333333333333".into(),
            })
            .unwrap();
        let second_revision: i64 = third
            .connection()
            .unwrap()
            .query_row("SELECT revision FROM office_board_state", [], |r| r.get(0))
            .unwrap();
        assert!(second_revision > first_revision);
        let listed = third
            .list(&ListRequest {
                category: Category::General,
                view: ListView::Updated,
                author: None,
                since_ms: None,
                limit: 20,
                cursor: None,
            })
            .unwrap();
        assert_eq!(listed.threads[0].reply_count, 2);
        third.close().unwrap();
    }

    #[test]
    fn concurrent_reply_limit_and_stale_edit_are_serialized_without_lost_updates() {
        use std::sync::{Arc, Barrier};
        let directory = TestDirectory::new();
        let database = directory.path.join("state.db");
        let mut setup = Storage::open(&database).unwrap();
        let owner = local_owner_actor(&mut setup).unwrap();
        let root = post(
            &mut setup,
            owner.clone(),
            "11111111-1111-4111-8111-111111111111",
        );
        for _ in 0..(REPLY_LIMIT - 1) {
            setup
                .reply(&ReplyRequest {
                    thread_id: root.thread_id.clone(),
                    actor: owner.clone(),
                    body: "r".into(),
                    operation_id: uuid::Uuid::new_v4().to_string(),
                })
                .unwrap();
        }
        let before: i64 = setup
            .connection()
            .unwrap()
            .query_row("SELECT revision FROM office_board_state", [], |r| r.get(0))
            .unwrap();
        setup.close().unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for body in ["a", "b"] {
            let db = database.clone();
            let gate = barrier.clone();
            let actor = owner.clone();
            let thread = root.thread_id.clone();
            handles.push(std::thread::spawn(move || {
                let mut storage = Storage::open(db).unwrap();
                gate.wait();
                storage
                    .reply(&ReplyRequest {
                        thread_id: thread,
                        actor,
                        body: body.into(),
                        operation_id: uuid::Uuid::new_v4().to_string(),
                    })
                    .map(|_| None)
                    .unwrap_or_else(|e| Some(e.code))
            }));
        }
        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|v| v.is_none()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|v| **v == Some(BoardErrorCode::Invalid))
                .count(),
            1
        );
        let mut storage = Storage::open(&database).unwrap();
        let state:(i64,i64)=storage.connection().unwrap().query_row("SELECT (SELECT count(*) FROM office_board_entries WHERE is_root=0),revision FROM office_board_state",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(state, (REPLY_LIMIT as i64, before + 1));
        let edit_root = post(
            &mut storage,
            owner.clone(),
            "22222222-2222-4222-8222-222222222222",
        );
        storage.close().unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for title in ["winner-a", "winner-b"] {
            let db = database.clone();
            let gate = barrier.clone();
            let actor = owner.clone();
            let entry = edit_root.entry_id.clone();
            handles.push(std::thread::spawn(move || {
                let mut storage = Storage::open(db).unwrap();
                gate.wait();
                storage
                    .edit(&EditRequest {
                        entry_id: entry,
                        actor,
                        title: Some(title.into()),
                        body: None,
                        expected_revision: 1,
                        operation_id: uuid::Uuid::new_v4().to_string(),
                    })
                    .map(|_| None)
                    .unwrap_or_else(|e| Some(e.code))
            }));
        }
        barrier.wait();
        let outcomes = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes.iter().filter(|v| v.is_none()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|v| **v == Some(BoardErrorCode::RevisionConflict))
                .count(),
            1
        );
        let mut storage = Storage::open(database).unwrap();
        let shown = storage
            .show(&ShowRequest {
                thread_id: edit_root.thread_id,
                reply_limit: 20,
                reply_cursor: None,
            })
            .unwrap();
        assert_eq!(shown.thread.revision, 2);
        assert!(matches!(
            shown.thread.title.as_deref(),
            Some("winner-a" | "winner-b")
        ));
        storage.close().unwrap();
    }
}
