use std::{future::Future, rc::Rc};

use garcon_base::domain_error::DomainError;
use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    api_providers::ApiProtocol,
    chat_id::{ChatId, parse_chat_id},
    chat_modes::{PermissionMode, ThinkingMode},
    error_codes::ErrorCode,
    executors::{LOCAL_EXECUTOR_ID, is_executor_id},
    preambles::{ChatPreambleSelection, PendingPreambleBoundary},
    transcript_seed::NativeSeedReceipt,
    ws_events::ChatProjectPathUpdatedPayload,
};
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::{OptionalNullable, trim};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::{
    ChatRegistry, ChatRegistrySnapshot, ChatRemovalReason, IdLookup, ReferenceLease, RegistryError,
    RegistryEvent, RetainReferences, State, provider_ids,
};
use crate::{
    registry_contracts::{
        CarryOverMigrationQuarantine, CarryOverSegmentRef, ChatRegistryEntry, EntryField,
        StoredEntry,
    },
    registry_entry_codec::{assert_preamble_boundary_binding, assert_seed_receipt_binding},
};

#[derive(Debug, Clone)]
pub struct NewChatRegistryEntry {
    pub id: ChatId,
    pub entry: ChatRegistryEntry,
}

impl NewChatRegistryEntry {
    pub fn new(
        id: ChatId,
        agent_id: String,
        model: String,
        project_path: String,
        preamble_selection: ChatPreambleSelection,
    ) -> Self {
        Self {
            id,
            entry: ChatRegistryEntry {
                executor_id: OptionalNullable::ABSENT,
                agent_id,
                agent_session_id: None,
                native_session: None,
                agent_ownership_epoch: Uuid::new_v4().to_string(),
                agent_settings_by_id: IndexMap::new(),
                project_path,
                tags: Vec::new(),
                model,
                api_provider_id: None,
                model_endpoint_id: None,
                model_protocol: None,
                last_read_at: OptionalNullable::ABSENT,
                permission_mode: PermissionMode::Default,
                thinking_mode: ThinkingMode::None,
                carry_over_segments: Vec::new(),
                native_seed_receipt: None,
                carry_over_migration_quarantine: None,
                pending_preamble_boundary: None,
                preamble_selection,
                parent_chat_id: None,
                lineage: None,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedChat {
    pub id: ChatId,
    pub entry: ChatRegistryEntry,
}

#[derive(Debug, Clone)]
pub struct ChatRegistryProjectPathUpdate {
    pub path: ChatProjectPathUpdatedPayload,
    pub native_session: OptionalNullable<AgentNativeSessionRef>,
}

macro_rules! patch_fields {
    ($($field:ident: $ty:ty),+ $(,)?) => {
        #[derive(Debug, Clone, Default)]
        pub struct ChatRegistryPatch { $(pub $field: Option<$ty>,)+ }

        impl ChatRegistryPatch {
            fn apply(&self, entry: &mut StoredEntry) {
                $(if let Some(value) = &self.$field { entry.entry.$field = value.clone(); })+
                if self.last_read_at.is_some() { entry.touch(EntryField::LastReadAt); }
            }
        }
    }
}

patch_fields! {
    agent_id: String,
    native_session: Option<AgentNativeSessionRef>,
    agent_ownership_epoch: String,
    agent_settings_by_id: IndexMap<String, AgentSettingsEnvelope>,
    tags: Vec<String>,
    agent_session_id: Option<String>,
    model: String,
    api_provider_id: Option<String>,
    model_endpoint_id: Option<String>,
    model_protocol: Option<ApiProtocol>,
    last_read_at: OptionalNullable<String>,
    permission_mode: PermissionMode,
    thinking_mode: ThinkingMode,
    carry_over_segments: Vec<CarryOverSegmentRef>,
    native_seed_receipt: Option<NativeSeedReceipt>,
    carry_over_migration_quarantine: Option<CarryOverMigrationQuarantine>,
    pending_preamble_boundary: Option<PendingPreambleBoundary>,
    preamble_selection: ChatPreambleSelection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatMutationDurability {
    Confirmed,
    Unknown,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryDurability {
    Durable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconciledDurability {
    Confirmed,
    Unavailable,
    StillUnknown,
}

#[derive(Debug, Clone)]
pub struct PhasedChatUpdate {
    pub entry: ResolvedChat,
    pub durability: RegistryDurability,
    pub changed: bool,
}

#[derive(Clone, Default)]
struct Update {
    patch: ChatRegistryPatch,
    project_path: Option<String>,
    executor_id: Option<OptionalNullable<String>>,
    parent: Option<Option<ChatId>>,
}

struct LiveUpdate {
    entry: ResolvedChat,
    previous: StoredEntry,
    revision: u64,
    events: Vec<RegistryEvent>,
}

impl Update {
    fn apply(&self, entry: &mut StoredEntry) {
        self.patch.apply(entry);
        if let Some(path) = &self.project_path {
            entry.entry.project_path.clone_from(path);
        }
        if let Some(executor) = &self.executor_id {
            entry.entry.executor_id.clone_from(executor);
            entry.touch(EntryField::ExecutorId);
        }
        if let Some(parent) = &self.parent {
            entry.entry.parent_chat_id.clone_from(parent);
        }
    }

    fn events(
        &self,
        id: &ChatId,
        before: &ChatRegistryEntry,
        after: &ChatRegistryEntry,
    ) -> Vec<RegistryEvent> {
        let mut events = Vec::new();
        if let Some(last_read_at) = &self.patch.last_read_at {
            events.push(RegistryEvent::ChatReadUpdated(
                id.clone(),
                last_read_at.clone(),
            ));
        }
        if self.patch.tags.is_some() && before.tags != after.tags {
            events.push(RegistryEvent::ChatTagsUpdated(id.clone()));
        }
        if self.parent.is_some() {
            events.push(RegistryEvent::ChatParentUpdated(id.clone()));
        }
        events
    }
}

impl State {
    fn dirty(&mut self) -> u64 {
        self.revision += 1;
        self.dirty = true;
        self.revision
    }

    fn changed(&mut self, id: ChatId) -> u64 {
        let revision = self.dirty();
        self.chat_revisions.insert(id, revision);
        revision
    }
}

fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::Invalid(message.into())
}

// Once admitted, a write must finish even if its caller drops the response future.
async fn finish_write<T: 'static>(
    write: impl Future<Output = Result<T, RegistryError>> + 'static,
) -> Result<T, RegistryError> {
    tokio::task::spawn_local(write).await?
}

fn check_binding(entry: &ChatRegistryEntry) -> Result<(), RegistryError> {
    assert_preamble_boundary_binding(
        &entry.agent_ownership_epoch,
        entry.pending_preamble_boundary.as_ref(),
        &entry.preamble_selection,
    )?;
    assert_seed_receipt_binding(
        entry.agent_session_id.as_deref(),
        entry.native_seed_receipt.as_ref(),
    )?;
    Ok(())
}

fn validate_json<T, U>(
    value: &T,
    parse: impl FnOnce(&Value) -> Result<U, crate::registry_entry_codec::RegistryCodecError>,
) -> Result<U, RegistryError>
where
    T: Serialize + ?Sized,
{
    let input = serde_json::to_string(value)
        .and_then(|wire| garcon_js::json::from_str(&wire))
        .map_err(|error| invalid(error.to_string()))?;
    Ok(parse(&input)?)
}

impl ChatRegistryPatch {
    fn validate_related(&self) -> Result<(), RegistryError> {
        use crate::registry_entry_codec::{
            normalize_migration_quarantine, normalize_native_seed_receipt,
            normalize_preamble_selection, parse_carry_over_segment_refs,
            parse_pending_preamble_boundary,
        };
        if let Some(value) = &self.carry_over_segments {
            validate_json(value, parse_carry_over_segment_refs)?;
        }
        if let Some(value) = &self.native_seed_receipt {
            validate_json(value, |v| normalize_native_seed_receipt(Some(v)))?;
        }
        if let Some(value) = &self.carry_over_migration_quarantine {
            validate_json(value, |v| normalize_migration_quarantine(Some(v)))?;
        }
        if let Some(value) = &self.pending_preamble_boundary {
            validate_json(value, |v| parse_pending_preamble_boundary(Some(v)))?;
        }
        if let Some(value) = &self.preamble_selection {
            validate_json(value, |v| normalize_preamble_selection(Some(v)))?;
        }
        Ok(())
    }
}

fn check_update(
    id: &ChatId,
    current: &ChatRegistryEntry,
    update: &Update,
) -> Result<(), RegistryError> {
    let future_agent = update
        .patch
        .agent_id
        .as_deref()
        .unwrap_or(&current.agent_id);
    if let Some(Some(native)) = &update.patch.native_session
        && native.owner_id != future_agent
    {
        return Err(invalid(format!("Native session owner mismatch for {id}")));
    }
    if let Some(settings) = &update.patch.agent_settings_by_id
        && settings.iter().any(|(id, setting)| {
            id.is_empty()
                || id != &setting.owner_id
                || !(1..=9_007_199_254_740_991).contains(&setting.schema_version)
                || !setting.values.is_object()
        })
    {
        return Err(invalid(format!("Invalid agent settings for {id}")));
    }
    update.patch.validate_related()
}

fn retain<'a>(
    option: Option<&RetainReferences>,
    next: impl IntoIterator<Item = &'a str>,
    previous: impl IntoIterator<Item = &'a str>,
) -> Result<Option<ReferenceLease>, RegistryError> {
    option
        .map(|callback| {
            let next = next.into_iter().map(str::to_owned).collect::<Vec<_>>();
            let previous = previous.into_iter().map(str::to_owned).collect::<Vec<_>>();
            callback(&next, &previous).map_err(RegistryError::Reference)
        })
        .transpose()
}

impl ChatRegistry {
    pub fn add_chat(self: &Rc<Self>, new: NewChatRegistryEntry) -> Result<bool, RegistryError> {
        let NewChatRegistryEntry { id, mut entry } = new;
        if entry.agent_id.is_empty() {
            return Err(invalid("Agent not specified"));
        }
        let executor = entry.executor_id.as_deref();
        if executor.is_some_and(|text| !is_executor_id(&Value::String(text.into()))) {
            return Err(invalid("Invalid executor ID"));
        }
        if entry.model.is_empty() {
            return Err(invalid("Model not specified"));
        }
        if entry.project_path.is_empty() {
            return Err(invalid("Project path not specified"));
        }
        if self.has_chat(&id) {
            return Err(invalid(format!("Chat with ID {id} already exists")));
        }
        if entry
            .native_session
            .as_ref()
            .is_some_and(|native| native.owner_id != entry.agent_id)
        {
            return Err(invalid(format!("Native session owner mismatch for {id}")));
        }
        use crate::registry_entry_codec::{
            normalize_migration_quarantine, normalize_native_seed_receipt,
            normalize_preamble_selection, parse_carry_over_segment_refs,
            parse_pending_preamble_boundary, require_chat_lineage,
        };
        validate_json(&entry.carry_over_segments, parse_carry_over_segment_refs)?;
        validate_json(&entry.native_seed_receipt, |v| {
            normalize_native_seed_receipt(Some(v))
        })?;
        validate_json(&entry.carry_over_migration_quarantine, |v| {
            normalize_migration_quarantine(Some(v))
        })?;
        validate_json(&entry.pending_preamble_boundary, |v| {
            parse_pending_preamble_boundary(Some(v))
        })?;
        validate_json(&entry.preamble_selection, |v| {
            normalize_preamble_selection(Some(v))
        })?;
        assert_preamble_boundary_binding(
            &entry.agent_ownership_epoch,
            entry.pending_preamble_boundary.as_ref(),
            &entry.preamble_selection,
        )?;
        if entry.parent_chat_id.as_ref() == Some(&id) {
            return Err(invalid(format!("Chat {id} cannot be its own parent")));
        }
        validate_json(&entry.lineage, |v| require_chat_lineage(Some(v), &id))?;
        assert_seed_receipt_binding(
            entry.agent_session_id.as_deref(),
            entry.native_seed_receipt.as_ref(),
        )?;
        let _executor = retain(
            self.options.retain_executor_references.as_ref(),
            entry.executor_id.as_deref(),
            [],
        )?;
        let _provider = retain(
            self.options.retain_provider_references.as_ref(),
            entry.api_provider_id.as_deref(),
            [],
        )?;
        if entry
            .executor_id
            .as_deref()
            .is_none_or(|executor| executor == LOCAL_EXECUTOR_ID)
        {
            entry.executor_id = OptionalNullable::ABSENT;
        }
        entry.last_read_at = OptionalNullable::ABSENT;
        {
            let mut state = self.state.borrow_mut();
            state
                .snapshot
                .sessions
                .insert(id.clone(), StoredEntry::added(entry));
            state.changed(id.clone());
        }
        self.emit(RegistryEvent::ChatAdded(id))?;
        self.schedule_save();
        Ok(true)
    }

    pub fn remove_chat(
        self: &Rc<Self>,
        chat_id: &str,
        reason: ChatRemovalReason,
    ) -> Result<bool, RegistryError> {
        let mut state = self.state.borrow_mut();
        let Some((id, stored)) = state
            .snapshot
            .sessions
            .shift_remove_entry(&IdLookup(chat_id))
        else {
            return Ok(false);
        };
        state.chat_revisions.remove(&id);
        let revision = state.dirty();
        if let Some(executor) = stored
            .entry
            .executor_id
            .as_deref()
            .filter(|executor| *executor != LOCAL_EXECUTOR_ID)
        {
            if let Some((held, _)) = state.removed_executors.get_mut(executor) {
                *held = revision;
            } else if let Some(lease) = retain(
                self.options.retain_executor_references.as_ref(),
                [],
                [executor],
            )? {
                state
                    .removed_executors
                    .insert(executor.into(), (revision, lease));
            }
        }
        drop(state);
        self.emit(RegistryEvent::ChatRemoved(id, reason))?;
        self.schedule_save();
        Ok(true)
    }

    fn schedule_save(self: &Rc<Self>) {
        let cancel = tokio_util::sync::CancellationToken::new();
        if let Some(old) = self.state.borrow_mut().timer.replace(cancel.clone()) {
            old.cancel();
        }
        let registry = Rc::downgrade(self);
        let delay = self.options.save_delay;
        tokio::task::spawn_local(async move {
            tokio::select! { biased;
                () = cancel.cancelled() => {},
                () = tokio::time::sleep(delay) => {
                    let Some(registry) = registry.upgrade() else { return };
                    registry.state.borrow_mut().timer.take();
                    if let Err(error) = registry.flush_ordered().await {
                        use garcon_base::log::Logger;
                        garcon_base::log::create_logger("chats:registry").warn(&format!("sessions: failed to persist registry: {error}"));
                    }
                }
            }
        });
    }

    fn cancel_save(&self) {
        if let Some(timer) = self.state.borrow_mut().timer.take() {
            timer.cancel();
        }
    }

    async fn write_snapshot(&self, snapshot: &ChatRegistrySnapshot) -> Result<(), RegistryError> {
        let providers = provider_ids(snapshot);
        let inherited = {
            let state = self.state.borrow();
            let mut inherited = provider_ids(&state.snapshot);
            inherited.extend(state.durable_providers.iter().cloned());
            inherited.extend(state.uncertain_providers.iter().cloned());
            inherited
        };
        let _lease = retain(
            self.options.retain_provider_references.as_ref(),
            providers.iter().map(String::as_str),
            inherited.iter().map(String::as_str),
        )?;
        match self.options.writer.write(&self.path, snapshot).await {
            Ok(()) => {
                let mut state = self.state.borrow_mut();
                state.durable_providers = providers;
                state.uncertain_providers.clear();
                state.unknown.clear();
                Ok(())
            }
            Err(error) => {
                if error.renamed {
                    self.state
                        .borrow_mut()
                        .uncertain_providers
                        .extend(providers);
                }
                Err(error.into())
            }
        }
    }

    pub async fn flush(self: &Rc<Self>) -> Result<(), RegistryError> {
        let owner = self.clone();
        finish_write(async move { owner.flush_ordered().await }).await
    }

    async fn flush_ordered(&self) -> Result<(), RegistryError> {
        self.cancel_save();
        let _lock = self.write_lock.lock().await;
        self.flush_current().await
    }

    async fn flush_current(&self) -> Result<(), RegistryError> {
        let (snapshot, revision) = {
            let state = self.state.borrow();
            (state.snapshot.clone(), state.revision)
        };
        self.write_snapshot(&snapshot).await?;
        let mut state = self.state.borrow_mut();
        if state.revision == revision {
            state.dirty = false;
        }
        state
            .removed_executors
            .retain(|_, (removed, _)| *removed > revision);
        Ok(())
    }

    pub fn chat_mutation_durability(&self, id: &str) -> ChatMutationDurability {
        let state = self.state.borrow();
        let Some((id, _)) = state.snapshot.sessions.get_key_value(&IdLookup(id)) else {
            return ChatMutationDurability::Unavailable;
        };
        if state.unknown.contains(id) {
            ChatMutationDurability::Unknown
        } else {
            ChatMutationDurability::Confirmed
        }
    }

    pub async fn reconcile_unknown_durability(self: &Rc<Self>, id: &str) -> ReconciledDurability {
        match self.chat_mutation_durability(id) {
            ChatMutationDurability::Confirmed => ReconciledDurability::Confirmed,
            ChatMutationDurability::Unavailable => ReconciledDurability::Unavailable,
            ChatMutationDurability::Unknown => {
                if self.flush().await.is_ok()
                    && self.chat_mutation_durability(id) != ChatMutationDurability::Unknown
                {
                    ReconciledDurability::Confirmed
                } else {
                    ReconciledDurability::StillUnknown
                }
            }
        }
    }

    fn update_live(&self, id: &str, update: &Update) -> Result<Option<LiveUpdate>, RegistryError> {
        let current = self
            .state
            .borrow()
            .snapshot
            .sessions
            .get_key_value(&IdLookup(id))
            .map(|(id, entry)| (id.clone(), entry.clone()));
        let Some((id, old)) = current else {
            return Ok(None);
        };
        check_update(&id, &old.entry, update)?;
        let mut candidate = old.clone();
        update.apply(&mut candidate);
        check_binding(&candidate.entry)?;
        let next_provider = candidate.entry.api_provider_id.as_deref();
        let current_provider = old
            .entry
            .api_provider_id
            .as_deref()
            .into_iter()
            .chain(update.executor_id.as_ref().and(next_provider));
        let _provider = retain(
            self.options.retain_provider_references.as_ref(),
            next_provider,
            current_provider,
        )?;
        let events = update.events(&id, &old.entry, &candidate.entry);
        let resolved = ResolvedChat {
            id: id.clone(),
            entry: candidate.entry.clone(),
        };
        let mut state = self.state.borrow_mut();
        state.snapshot.sessions.insert(id.clone(), candidate);
        let revision = state.changed(id);
        Ok(Some(LiveUpdate {
            entry: resolved,
            previous: old,
            revision,
            events,
        }))
    }

    pub fn update_chat(
        self: &Rc<Self>,
        id: &str,
        patch: ChatRegistryPatch,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        let Some(LiveUpdate { entry, events, .. }) = self.update_live(
            id,
            &Update {
                patch,
                ..Default::default()
            },
        )?
        else {
            return Ok(None);
        };
        for event in events {
            self.emit(event)?;
        }
        self.schedule_save();
        Ok(Some(entry))
    }

    pub async fn update_chat_flushed(
        self: &Rc<Self>,
        id: &str,
        patch: ChatRegistryPatch,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        self.update_flushed(
            id,
            Update {
                patch,
                ..Default::default()
            },
        )
        .await
    }

    async fn update_flushed(
        self: &Rc<Self>,
        id: &str,
        update: Update,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        let Some(LiveUpdate {
            entry,
            previous,
            revision,
            events,
        }) = self.update_live(id, &update)?
        else {
            return Ok(None);
        };
        let owner = self.clone();
        finish_write(async move {
            owner
                .finish_live_write(entry, previous, revision, events)
                .await
        })
        .await
    }

    async fn finish_live_write(
        self: &Rc<Self>,
        entry: ResolvedChat,
        previous: StoredEntry,
        revision: u64,
        events: Vec<RegistryEvent>,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        self.cancel_save();
        let _lock = self.write_lock.lock().await;
        if let Err(error) = self.flush_current().await {
            let mut state = self.state.borrow_mut();
            if state.chat_revisions.get(&entry.id) == Some(&revision) {
                state.snapshot.sessions.insert(entry.id.clone(), previous);
                state.changed(entry.id.clone());
                drop(state);
                self.schedule_save();
            }
            return Err(error);
        }
        drop(_lock);
        for event in events {
            self.emit(event)?;
        }
        Ok(Some(entry))
    }

    pub async fn install_agent_ownership(
        self: &Rc<Self>,
        id: &str,
        executor: Option<String>,
        project_path: String,
        patch: ChatRegistryPatch,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        let executor = executor.unwrap_or_else(|| LOCAL_EXECUTOR_ID.into());
        if !is_executor_id(&Value::String(executor.clone())) || trim(&project_path).is_empty() {
            return Err(invalid("Invalid execution target"));
        }
        let executor_id = if executor == LOCAL_EXECUTOR_ID {
            OptionalNullable::ABSENT
        } else {
            OptionalNullable::some(executor)
        };
        self.update_flushed(
            id,
            Update {
                patch,
                executor_id: Some(executor_id),
                project_path: Some(project_path),
                parent: None,
            },
        )
        .await
    }

    pub async fn update_project_path(
        self: &Rc<Self>,
        id: &str,
        update: ChatRegistryProjectPathUpdate,
    ) -> Result<Option<ResolvedChat>, RegistryError> {
        if !self.has_chat(id) {
            return Ok(None);
        }
        if update.path.chat_id != id {
            return Err(invalid(format!(
                "Project path update identity mismatch: {id}"
            )));
        }
        let patch = ChatRegistryPatch {
            native_session: (!update.native_session.is_absent())
                .then(|| update.native_session.as_option().cloned()),
            ..Default::default()
        };
        let result = self
            .update_flushed(
                id,
                Update {
                    patch,
                    project_path: Some(update.path.project_path.clone()),
                    ..Default::default()
                },
            )
            .await?;
        self.publish_project_path(update.path);
        Ok(result)
    }

    pub async fn update_chat_phased(
        self: &Rc<Self>,
        id: &str,
        patch: ChatRegistryPatch,
    ) -> Result<Option<PhasedChatUpdate>, RegistryError> {
        self.update_phased(
            id,
            Update {
                patch,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn update_observed_project_path(
        self: &Rc<Self>,
        id: &str,
        update: ChatProjectPathUpdatedPayload,
    ) -> Result<Option<PhasedChatUpdate>, RegistryError> {
        if update.chat_id != id {
            return Err(invalid(format!(
                "Project path update identity mismatch: {id}"
            )));
        }
        let result = self
            .update_phased(
                id,
                Update {
                    project_path: Some(update.project_path.clone()),
                    ..Default::default()
                },
            )
            .await?;
        if result
            .as_ref()
            .is_some_and(|result| result.durability == RegistryDurability::Durable)
        {
            self.publish_project_path(update);
        }
        Ok(result)
    }

    pub async fn set_delegation_parent_phased(
        self: &Rc<Self>,
        id: &str,
        parent: Option<ChatId>,
    ) -> Result<Option<PhasedChatUpdate>, RegistryError> {
        parse_chat_id(&Value::String(id.into()))
            .map_err(crate::registry_entry_codec::RegistryCodecError::from)?;
        self.update_phased(
            id,
            Update {
                parent: Some(parent),
                ..Default::default()
            },
        )
        .await
    }

    async fn update_phased(
        self: &Rc<Self>,
        id: &str,
        update: Update,
    ) -> Result<Option<PhasedChatUpdate>, RegistryError> {
        let owner = self.clone();
        let id = id.to_owned();
        finish_write(async move { owner.write_phased(&id, update).await }).await
    }

    async fn write_phased(
        &self,
        id: &str,
        update: Update,
    ) -> Result<Option<PhasedChatUpdate>, RegistryError> {
        let _lock = self.write_lock.lock().await;
        let (id, candidate, candidate_snapshot, base, changed) = {
            let state = self.state.borrow();
            let Some((id, existing)) = state.snapshot.sessions.get_key_value(&IdLookup(id)) else {
                return Ok(None);
            };
            if state.unknown.contains(id) {
                return Err(RegistryError::DurabilityUnknown(id.clone()));
            }
            if let Some(parent) = &update.parent {
                validate_parent(&state, id, &existing.entry, parent.as_ref())?;
            }
            check_update(id, &existing.entry, &update)?;
            let mut candidate = existing.clone();
            update.apply(&mut candidate);
            check_binding(&candidate.entry)?;
            let changed = candidate.entry != existing.entry;
            let entry = ResolvedChat {
                id: id.clone(),
                entry: candidate.entry.clone(),
            };
            if !changed && !state.dirty {
                return Ok(Some(PhasedChatUpdate {
                    entry,
                    durability: RegistryDurability::Durable,
                    changed,
                }));
            }
            let mut snapshot = state.snapshot.clone();
            snapshot.sessions.insert(id.clone(), candidate);
            (id.clone(), entry, snapshot, state.revision, changed)
        };
        let durability = match self.write_snapshot(&candidate_snapshot).await {
            Ok(()) => RegistryDurability::Durable,
            Err(RegistryError::Write(error)) if error.renamed => {
                self.state.borrow_mut().unknown.insert(id.clone());
                RegistryDurability::Unknown
            }
            Err(error) => return Err(error),
        };
        let events = {
            let mut state = self.state.borrow_mut();
            let Some(current) = state.snapshot.sessions.get_mut(&id) else {
                return Ok(None);
            };
            if update.project_path.is_some() && durability == RegistryDurability::Unknown {
                return Ok(Some(PhasedChatUpdate {
                    entry: candidate,
                    durability,
                    changed,
                }));
            }
            let events = if changed {
                let previous = current.entry.clone();
                update.apply(current);
                check_binding(&current.entry)?;
                update.events(&id, &previous, &current.entry)
            } else {
                Vec::new()
            };
            let revision = if changed {
                state.changed(id)
            } else {
                state.revision
            };
            if durability == RegistryDurability::Durable && revision == base + u64::from(changed) {
                state.dirty = false;
            }
            events
        };
        drop(_lock);
        for event in events {
            self.emit(event)?;
        }
        Ok(Some(PhasedChatUpdate {
            entry: candidate,
            durability,
            changed,
        }))
    }
}

fn validate_parent(
    state: &State,
    id: &ChatId,
    entry: &ChatRegistryEntry,
    parent: Option<&ChatId>,
) -> Result<(), RegistryError> {
    if entry.parent_chat_id.as_ref() == parent {
        return Ok(());
    }
    let Some(parent) = parent else { return Ok(()) };
    let sessions = &state.snapshot.sessions;
    if !sessions.contains_key(parent) {
        return Err(DomainError::new(
            ErrorCode::PARENT_CHAT_NOT_FOUND,
            "Parent chat not found",
            404,
            false,
        )
        .into());
    }
    let mut visited = std::collections::HashSet::from([id]);
    let mut next = Some(parent);
    while let Some(ancestor) = next {
        if !visited.insert(ancestor) {
            return Err(DomainError::new(
                ErrorCode::CHAT_PARENT_CYCLE,
                "The parent relationship would contain a cycle",
                409,
                false,
            )
            .into());
        }
        next = sessions
            .get(ancestor)
            .and_then(|chat| chat.entry.parent_chat_id.as_ref());
    }
    Ok(())
}
