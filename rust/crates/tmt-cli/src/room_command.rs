//! CLI projection of the shared room owner. No Office process or pane routing.

mod dispatch;

use crate::{
    identity_context,
    invocation::{OutputMode, RoomOperation},
    output::{Failure, after_cleanup, table},
};
use std::io::{self, Write};
use tmt_adapters::{
    config::ConfigPaths,
    room::RoomWire,
    storage::{RoomStoreError, Storage},
};
use tmt_core::room::{self, MeetingRoom, ResolveError, RoomRepository};

pub(super) fn failure(error: RoomStoreError) -> Failure {
    let (message, exit) = match &error {
        RoomStoreError::Invalid => ("Invalid room name, identifier or membership.", 1),
        RoomStoreError::NotFound => ("Room was not found.", 3),
        RoomStoreError::RevisionConflict => ("Room changed; refresh before retrying.", 1),
        RoomStoreError::IdentityInactive => ("A selected identity is no longer active.", 3),
        RoomStoreError::Retired => (
            "Room is retired; history is retained but new work is disabled.",
            1,
        ),
        RoomStoreError::Storage(_) => ("Could not access room storage.", 1),
    };
    Failure::new(error.code(), message, exit).caused_by(error)
}

pub(super) fn resolve(storage: &mut Storage, selector: &str) -> Result<MeetingRoom, Failure> {
    room::resolve_room(storage, selector).map_err(|error| resolve_failure(error, selector))
}

pub(super) fn resolve_history(
    storage: &mut Storage,
    selector: &str,
) -> Result<MeetingRoom, Failure> {
    room::resolve_historical_room(storage, selector)
        .map_err(|error| resolve_failure(error, selector))
}

fn resolve_failure(error: ResolveError<RoomStoreError>, selector: &str) -> Failure {
    match error {
        ResolveError::Repository(error) => failure(error),
        ResolveError::NotFound => Failure::new(
            "ROOM_NOT_FOUND",
            format!("Room '{selector}' was not found."),
            3,
        ),
        ResolveError::Ambiguous(rooms) => Failure::new(
            "ROOM_AMBIGUOUS",
            format!(
                "Room name '{selector}' is ambiguous. Use one of these UUIDs: {}.",
                rooms
                    .iter()
                    .map(|room| room.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            1,
        ),
    }
}

enum Report {
    One(MeetingRoom),
    List(Vec<MeetingRoom>),
}

fn run(operation: RoomOperation) -> Result<Report, Failure> {
    let selector = match &operation {
        RoomOperation::Membership { identity, .. } => {
            Some(identity_context::required(identity.as_deref())?)
        }
        _ => None,
    };
    let paths = ConfigPaths::discover().map_err(|error| {
        Failure::new("CONFIG_ERROR", "Could not resolve configuration paths.", 1).caused_by(error)
    })?;
    let mut storage = Storage::open(paths.database).map_err(|error| failure(error.into()))?;
    let pending = (|| match operation {
        RoomOperation::Dispatch { .. } => unreachable!("dispatch has its own composition"),
        RoomOperation::Create(name) => room::create(&mut storage, name)
            .map(Report::One)
            .map_err(failure),
        RoomOperation::List => storage
            .list_meeting_rooms()
            .map(Report::List)
            .map_err(failure),
        RoomOperation::Show(room) => resolve_history(&mut storage, &room).map(Report::One),
        RoomOperation::Retire(room) => {
            let room = resolve_history(&mut storage, &room)?;
            storage
                .retire_meeting_room(&room.id, room.revision)
                .map(Report::One)
                .map_err(failure)
        }
        RoomOperation::Membership { room, change, .. } => {
            let room = resolve(&mut storage, &room)?;
            let identity = identity_context::resolve(
                &mut storage,
                selector.expect("membership has an identity selector"),
            )?;
            storage
                .change_meeting_membership(&room.id, &identity.id, change)
                .map(Report::One)
                .map_err(failure)
        }
    })();
    after_cleanup(pending, || storage.close())
}

pub fn execute(operation: RoomOperation, mode: OutputMode) -> io::Result<u8> {
    if matches!(operation, RoomOperation::Dispatch { .. }) {
        return dispatch::execute(operation, mode);
    }
    let report = match run(operation) {
        Ok(report) => report,
        Err(error) => return error.publish(mode),
    };
    let mut out = io::stdout().lock();
    if mode.json {
        let value = match &report {
            Report::One(room) => serde_json::json!({"room": RoomWire::from(room)}),
            Report::List(rooms) => {
                serde_json::json!({"rooms": rooms.iter().map(RoomWire::from).collect::<Vec<_>>()})
            }
        };
        writeln!(out, "{value}")?;
    } else {
        let rooms = match &report {
            Report::One(room) => std::slice::from_ref(room),
            Report::List(rooms) => rooms,
        };
        if rooms.is_empty() {
            writeln!(out, "No rooms. Create one with: tmt room create <name>")?;
        } else {
            table::write(
                &mut out,
                ["ROOM", "STATE", "MEMBERS", "REVISION", "ID"],
                rooms.iter().map(|room| {
                    [
                        room.name.clone(),
                        if room.retired { "retired" } else { "active" }.into(),
                        room.member_ids.len().to_string(),
                        room.revision.to_string(),
                        room.id.clone(),
                    ]
                }),
            )?;
            if let Report::One(room) = &report {
                for id in &room.member_ids {
                    writeln!(out, "  {id}")?;
                }
            }
        }
    }
    Ok(0)
}
