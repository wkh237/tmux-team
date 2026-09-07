use super::observation::{named_entry, observe, reconcile};
use super::*;
use crate::identity::{self, IdentityError, Lifetime};

fn deadline<R, O: BindingEndpoint>(endpoint: &O) -> Result<(), BindingError<R, O::Error>> {
    if endpoint.budget_available() {
        Ok(())
    } else {
        Err(BindingError::Deadline)
    }
}

pub fn bind_identity<R: BindingRepository, O: BindingEndpoint>(
    repository: &mut R,
    endpoint: &mut O,
    pane_id: &str,
    name: &str,
    save: bool,
) -> Result<IdentityPresence, BindingError<R::Error, O::Error>> {
    endpoint.begin_coordination();
    let preflight = endpoint
        .current_snapshot(&[pane_id.into()])
        .map_err(BindingError::Endpoint)?;
    if !preflight.panes.iter().any(|pane| pane.id == pane_id) {
        return Err(BindingError::PaneNotFound(pane_id.into()));
    }
    // Reconcile only the requested old name before creation. Conclusively lost
    // temporary identities release their name; create_or_resolve then allocates
    // a new UUID instead of resurrecting that old identity's history.
    repository.with_binding_transaction(|records| {
        endpoint.begin_coordination();
        if let Some(entry) = named_entry(records, name)? {
            let probe = observe(endpoint, &entry).map_err(BindingError::Endpoint)?;
            if entry.binding.is_some()
                && evaluate_binding(&entry, &probe) == BindingEvidence::Unknown
            {
                return Err(BindingError::Unverified);
            }
            reconcile(records, entry, &probe)?;
        }
        deadline(endpoint)
    })?;
    let created = identity::create_or_resolve(
        repository,
        name,
        if save {
            Lifetime::Saved
        } else {
            Lifetime::Temporary
        },
    )
    .map_err(|error| match error {
        IdentityError::InvalidName(error) => BindingError::InvalidName(error),
        IdentityError::Repository(error) => BindingError::Repository(error),
    })?;
    // Everything below may fail without undoing the separately committed
    // creation/promotion. Re-read ownership after acquiring this second lock.
    repository.with_binding_transaction(|records| {
        endpoint.begin_coordination();
        let selected = records
            .entry_by_id(&created.identity.id)?
            .ok_or(BindingError::Unverified)?;
        let mut scope = vec![pane_id.into()];
        if let Some(binding) = &selected.binding
            && binding.pane_id != pane_id
        {
            scope.push(binding.pane_id.clone());
        }
        let snapshot = endpoint
            .current_snapshot(&scope)
            .map_err(BindingError::Endpoint)?;
        let pane = snapshot
            .panes
            .iter()
            .find(|pane| pane.id == pane_id)
            .ok_or_else(|| BindingError::PaneNotFound(pane_id.into()))?;
        let mut current = None;
        if let Some(occupied) = records.entry_by_pane(pane_id, &snapshot.server.server_id)? {
            match evaluate_binding(&occupied, &EndpointProbe::Live(snapshot.clone())) {
                BindingEvidence::Active(_) if occupied.identity.id != selected.identity.id => {
                    return Err(BindingError::PaneAlreadyBound);
                }
                BindingEvidence::Active(_) => current = occupied.binding,
                BindingEvidence::Unknown => return Err(BindingError::Unverified),
                BindingEvidence::EndpointLost
                    if occupied.identity.id == selected.identity.id
                        && occupied.identity.lifetime == Lifetime::Temporary =>
                {
                    return Err(BindingError::Unverified);
                }
                _ => {
                    reconcile(records, occupied, &EndpointProbe::Live(snapshot.clone()))?;
                }
            }
        }
        if let Some(old) = &selected.binding
            && current.as_ref().is_none_or(|current| current.id != old.id)
        {
            let probe = if old.server.socket_path == snapshot.server.socket_path {
                EndpointProbe::Live(snapshot.clone())
            } else {
                observe(endpoint, &selected).map_err(BindingError::Endpoint)?
            };
            match evaluate_binding(&selected, &probe) {
                BindingEvidence::Active(_) => return Err(BindingError::NameAlreadyActive),
                BindingEvidence::Unknown => return Err(BindingError::Unverified),
                BindingEvidence::EndpointLost
                    if selected.identity.lifetime == Lifetime::Temporary =>
                {
                    return Err(BindingError::Unverified);
                }
                _ => {
                    records.detach_binding(&old.id)?;
                }
            }
        }
        let publish = current.is_none();
        let binding = match current {
            Some(binding) => binding,
            None => records.insert_binding(&selected.identity, &snapshot.server, pane)?,
        };
        if publish {
            endpoint
                .publish(&binding, &selected.identity)
                .map_err(BindingError::Endpoint)?;
        }
        let verified = endpoint
            .current_snapshot(&[pane_id.into()])
            .map_err(BindingError::Endpoint)?;
        let persisted = records
            .entry_by_pane(pane_id, &binding.server.server_id)?
            .ok_or(BindingError::Unverified)?;
        if persisted.identity.id != selected.identity.id
            || persisted.binding.as_ref() != Some(&binding)
        {
            return Err(BindingError::Unverified);
        }
        let BindingEvidence::Active(pane) =
            evaluate_binding(&persisted, &EndpointProbe::Live(verified))
        else {
            return Err(BindingError::Unverified);
        };
        records.touch_binding(&binding.id)?;
        deadline(endpoint)?;
        Ok(IdentityPresence {
            identity: selected.identity,
            presence: Presence::Active,
            pane: Some(*pane),
            binding: Some(binding),
        })
    })
}

pub fn unbind_identity<R: BindingRepository, O: BindingEndpoint>(
    repository: &mut R,
    endpoint: &mut O,
    pane_id: &str,
) -> Result<Option<UnboundIdentity>, BindingError<R::Error, O::Error>> {
    repository.with_binding_transaction(|records| {
        endpoint.begin_coordination();
        let snapshot = endpoint
            .current_snapshot(&[pane_id.into()])
            .map_err(BindingError::Endpoint)?;
        if !snapshot.panes.iter().any(|pane| pane.id == pane_id) {
            return Err(BindingError::PaneNotFound(pane_id.into()));
        }
        let Some(entry) = records.entry_by_pane(pane_id, &snapshot.server.server_id)? else {
            return Ok(None);
        };
        let evidence = evaluate_binding(&entry, &EndpointProbe::Live(snapshot));
        clear_observed(endpoint, &entry, &evidence)?;
        let retired = entry.identity.lifetime == Lifetime::Temporary;
        if retired {
            records.retire_identity(&entry.identity, false)?;
        } else if let Some(binding) = &entry.binding {
            records.detach_binding(&binding.id)?;
        }
        deadline(endpoint)?;
        let binding = matches!(evidence, BindingEvidence::Active(_))
            .then_some(entry.binding)
            .flatten();
        Ok(Some(UnboundIdentity {
            identity: entry.identity,
            retired,
            binding,
        }))
    })
}

fn clear_observed<R, O: BindingEndpoint>(
    endpoint: &mut O,
    entry: &BindingEntry,
    evidence: &BindingEvidence,
) -> Result<(), BindingError<R, O::Error>> {
    match (evidence, &entry.binding) {
        (BindingEvidence::Unknown, Some(_)) => Err(BindingError::Unverified),
        (BindingEvidence::Active(_), Some(binding)) => {
            if endpoint.clear(binding).map_err(BindingError::Endpoint)? {
                Ok(())
            } else {
                Err(BindingError::Unverified)
            }
        }
        // A mismatched marker belongs to neither this binding nor its removal.
        // Explicit retirement may detach the obsolete row but never erase it.
        _ => Ok(()),
    }
}

pub fn remove_identity<R: BindingRepository, O: BindingEndpoint>(
    repository: &mut R,
    endpoint: &mut O,
    name: &str,
    force: bool,
) -> Result<BindingEntry, BindingError<R::Error, O::Error>> {
    repository.with_binding_transaction(|records| {
        let entry =
            named_entry(records, name)?.ok_or_else(|| BindingError::NameNotFound(name.into()))?;
        if entry.identity.lifetime == Lifetime::Saved && !force {
            return Err(BindingError::ConfirmationRequired);
        }
        endpoint.begin_coordination();
        let mut cleared_binding = None;
        if entry.binding.is_some() {
            let probe = observe(endpoint, &entry).map_err(BindingError::Endpoint)?;
            let evidence = evaluate_binding(&entry, &probe);
            clear_observed(endpoint, &entry, &evidence)?;
            if matches!(evidence, BindingEvidence::Active(_)) {
                cleared_binding = entry.binding.clone();
            }
        }
        records.retire_identity(&entry.identity, true)?;
        deadline(endpoint)?;
        Ok(BindingEntry {
            identity: entry.identity,
            binding: cleared_binding,
        })
    })
}
