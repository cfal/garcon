//! Projects chat summaries and list entries without opening a transcript or
//! inspecting execution ownership.

mod wire;

use std::{collections::HashSet, rc::Rc};

use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    chat_id::{ChatId, InvalidChatIdError, chat_id_created_at},
    chat_list::{ChatListActivity, ChatListEntry, ChatListPreview, ChatOrderGroup},
    chat_snapshot::{ChatSnapshotActivity, ChatSnapshotChat},
    chat_types::ChatProcessingPhase,
    tags::normalize_tags,
};
use garcon_js::{InvalidTimeValue, OptionalNullable, json::Opaque, to_iso_string, utf16};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{
    carryover::segments::carry_over_revision,
    chat_activity_status::project_chat_activity_status,
    chat_title::{extract_first_line, resolve_chat_title},
    metadata_store::{ChatMetadata, MetadataIndex},
    registry_contracts::ChatRegistryEntry,
    store::ChatRegistry,
};

pub use wire::{ProjectedChatListEntry, ProjectedChatSnapshot};

pub trait ChatListSettings {
    fn pinned_chat_ids(&self) -> Vec<String>;
    fn normal_chat_ids(&self) -> Vec<String>;
    fn archived_chat_ids(&self) -> Vec<String>;
    fn chat_name(&self, chat_id: &ChatId) -> Option<String>;
}

#[derive(Debug, Clone, Default)]
pub struct ChatListMembershipSnapshot {
    pub pinned: HashSet<String>,
    pub normal: HashSet<String>,
    pub archived: HashSet<String>,
}

type ProcessingPhase = dyn Fn(&ChatId) -> Option<ChatProcessingPhase>;
type PendingUserAction = dyn Fn(&ChatId) -> bool;
type NativeHistoryCapability = dyn Fn(&ChatId, &ChatRegistryEntry) -> bool;

pub struct ChatListProjectorDeps {
    pub registry: Rc<ChatRegistry>,
    pub settings: Rc<dyn ChatListSettings>,
    pub metadata: Rc<MetadataIndex>,
    pub processing_phase: Rc<ProcessingPhase>,
    pub has_pending_user_action: Rc<PendingUserAction>,
    pub can_reload_from_native_history: Rc<NativeHistoryCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummaryProjection {
    pub chat: ProjectedChatSnapshot,
    pub processing_phase: Option<ChatProcessingPhase>,
}

#[derive(Debug, thiserror::Error)]
pub enum ChatListProjectionError {
    #[error(transparent)]
    ChatId(#[from] InvalidChatIdError),
    #[error(transparent)]
    Time(#[from] InvalidTimeValue),
}

pub struct ChatListProjector(ChatListProjectorDeps);

impl ChatListProjector {
    pub fn new(deps: ChatListProjectorDeps) -> Self {
        Self(deps)
    }

    pub fn membership_snapshot(&self) -> ChatListMembershipSnapshot {
        let settings = &self.0.settings;
        ChatListMembershipSnapshot {
            pinned: settings.pinned_chat_ids().into_iter().collect(),
            normal: settings.normal_chat_ids().into_iter().collect(),
            archived: settings.archived_chat_ids().into_iter().collect(),
        }
    }

    pub fn build_summary(
        &self,
        chat_id: &ChatId,
    ) -> Result<Option<ChatSummaryProjection>, ChatListProjectionError> {
        let Some(session) = self.0.registry.get_chat(chat_id) else {
            return Ok(None);
        };
        let metadata = self.0.metadata.get_chat_metadata(chat_id);
        self.summary(chat_id, &session, metadata.as_ref()).map(Some)
    }

    pub fn build_one(
        &self,
        chat_id: &ChatId,
    ) -> Result<Option<ProjectedChatListEntry>, ChatListProjectionError> {
        let Some(session) = self.0.registry.get_chat(chat_id) else {
            return Ok(None);
        };
        let metadata = self.0.metadata.get_chat_metadata(chat_id);
        let summary = self.summary(chat_id, &session, metadata.as_ref())?;
        Ok(Some(list_entry(
            summary,
            &session,
            metadata.as_ref(),
            &self.membership_snapshot(),
        )))
    }

    pub fn build_many<'a>(
        &self,
        sessions: impl IntoIterator<Item = (&'a ChatId, &'a ChatRegistryEntry)>,
    ) -> Result<IndexMap<ChatId, ProjectedChatListEntry>, ChatListProjectionError> {
        let metadata = self.0.metadata.list_all_chat_metadata();
        let membership = self.membership_snapshot();
        sessions
            .into_iter()
            .map(|(id, session)| {
                let metadata = metadata.get(id.as_str());
                let summary = self.summary(id, session, metadata)?;
                Ok((
                    id.clone(),
                    list_entry(summary, session, metadata, &membership),
                ))
            })
            .collect()
    }

    fn summary(
        &self,
        chat_id: &ChatId,
        session: &ChatRegistryEntry,
        metadata: Option<&ChatMetadata>,
    ) -> Result<ChatSummaryProjection, ChatListProjectionError> {
        let inferred_created_at = to_iso_string(chat_id_created_at(chat_id)?)?;
        let override_title = self.0.settings.chat_name(chat_id);
        let title = resolve_chat_title(
            override_title.as_deref(),
            metadata.map(|entry| entry.first_message.as_str()),
        );
        let processing_phase = (self.0.processing_phase)(chat_id);
        let activity_status = project_chat_activity_status(
            processing_phase,
            (self.0.has_pending_user_action)(chat_id),
            self.0.metadata.get_run_outcome(chat_id),
        );
        Ok(ChatSummaryProjection {
            chat: ProjectedChatSnapshot(ChatSnapshotChat {
                id: chat_id.clone(),
                executor_id: session.executor_id.clone(),
                title: title.into(),
                activity_status,
                agent_id: session.agent_id.clone(),
                agent_ownership_epoch: session.agent_ownership_epoch.clone(),
                carry_over_revision: carry_over_revision(
                    &session.carry_over_segments,
                    session.carry_over_migration_quarantine.as_ref(),
                ),
                model: nonempty(Some(&session.model)).map(str::to_owned),
                api_provider_id: session.api_provider_id.clone(),
                model_endpoint_id: session.model_endpoint_id.clone(),
                model_protocol: session.model_protocol,
                permission_mode: session.permission_mode,
                thinking_mode: session.thinking_mode,
                project_path: session.project_path.clone(),
                tags: normalize_tags(
                    &session
                        .tags
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect::<Vec<_>>(),
                ),
                can_reload_from_native_history: (self.0.can_reload_from_native_history)(
                    chat_id, session,
                ),
                activity: ChatSnapshotActivity {
                    created_at: Some(
                        nonempty(metadata.and_then(|entry| entry.created_at.as_deref()))
                            .map_or(inferred_created_at, str::to_owned),
                    ),
                    last_activity_at: metadata.and_then(|entry| entry.last_activity.clone()),
                },
            }),
            processing_phase,
        })
    }
}

fn list_entry(
    summary: ChatSummaryProjection,
    session: &ChatRegistryEntry,
    metadata: Option<&ChatMetadata>,
    membership: &ChatListMembershipSnapshot,
) -> ProjectedChatListEntry {
    let ChatSummaryProjection {
        chat: ProjectedChatSnapshot(chat),
        processing_phase,
    } = summary;
    let order_group = classify_order_group(&chat.id, membership);
    let first_message = nonempty(metadata.map(|entry| entry.first_message.as_str()));
    let first_preview = extract_first_line(first_message.unwrap_or(&chat.title)).to_owned();
    let last_preview = extract_first_line(
        nonempty(metadata.map(|entry| entry.last_message.as_str()))
            .or(first_message)
            .unwrap_or(&chat.title),
    )
    .to_owned();
    let last_read_at = session.last_read_at.as_deref().map(str::to_owned);
    let last_activity_at = chat.activity.last_activity_at;
    let is_unread = nonempty(last_activity_at.as_deref()).is_some_and(|activity| {
        nonempty(last_read_at.as_deref()).is_none_or(|read| utf16::cmp(activity, read).is_gt())
    });
    ProjectedChatListEntry(ChatListEntry {
        id: chat.id,
        executor_id: chat.executor_id,
        parent_chat_id: session.parent_chat_id.clone(),
        lineage: session.lineage.clone(),
        agent_settings: session
            .agent_settings_by_id
            .get(&chat.agent_id)
            .cloned()
            .unwrap_or_else(|| AgentSettingsEnvelope {
                owner_id: chat.agent_id.clone(),
                schema_version: 1,
                values: Opaque::from_value(Value::Object(Map::new())),
            }),
        agent_id: chat.agent_id,
        agent_ownership_epoch: chat.agent_ownership_epoch,
        model: chat.model,
        api_provider_id: nullable(chat.api_provider_id),
        model_endpoint_id: nullable(chat.model_endpoint_id),
        model_protocol: nullable(chat.model_protocol),
        permission_mode: chat.permission_mode,
        thinking_mode: chat.thinking_mode,
        title: chat.title,
        project_path: chat.project_path,
        is_pinned: order_group == ChatOrderGroup::Pinned,
        is_archived: order_group == ChatOrderGroup::Archived,
        order_group,
        tags: chat.tags,
        activity: ChatListActivity {
            created_at: chat.activity.created_at,
            last_activity_at,
            last_read_at,
        },
        preview: ChatListPreview {
            last_message: last_preview,
            first_message: Some(first_preview),
        },
        is_active: processing_phase.is_some(),
        is_processing: processing_phase.is_some(),
        processing_phase,
        activity_status: chat.activity_status,
        can_reload_from_native_history: chat.can_reload_from_native_history,
        is_unread,
    })
}

pub fn classify_order_group(
    chat_id: &str,
    membership: &ChatListMembershipSnapshot,
) -> ChatOrderGroup {
    if membership.pinned.contains(chat_id) {
        ChatOrderGroup::Pinned
    } else if membership.normal.contains(chat_id) {
        ChatOrderGroup::Normal
    } else if membership.archived.contains(chat_id) {
        ChatOrderGroup::Archived
    } else {
        ChatOrderGroup::Orphan
    }
}

fn nullable<T>(value: Option<T>) -> OptionalNullable<T> {
    value.map_or(OptionalNullable::NULL, OptionalNullable::some)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}
