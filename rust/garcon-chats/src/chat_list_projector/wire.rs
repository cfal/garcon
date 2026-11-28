//! The controller literals and the common boundary parsers order the same
//! typed fields differently.

use std::ops::Deref;

use garcon_contract::{chat_list::ChatListEntry, chat_snapshot::ChatSnapshotChat};
use serde::{Serialize, Serializer, ser::SerializeMap};

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedChatListEntry(pub ChatListEntry);

impl Deref for ProjectedChatListEntry {
    type Target = ChatListEntry;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectedChatSnapshot(pub ChatSnapshotChat);

impl Deref for ProjectedChatSnapshot {
    type Target = ChatSnapshotChat;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

macro_rules! fields {
    ($map:ident, $entry:ident; $($wire:literal : $field:ident),+ $(,)?) => {
        $($map.serialize_entry($wire, &$entry.$field)?;)+
    };
}

impl Serialize for ProjectedChatListEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let entry = &self.0;
        let mut map = serializer.serialize_map(None)?;
        fields!(map, entry; "id": id, "activityStatus": activity_status);
        if !entry.executor_id.is_absent() {
            map.serialize_entry("executorId", &entry.executor_id)?;
        }
        fields!(map, entry;
            "parentChatId": parent_chat_id, "lineage": lineage, "agentId": agent_id,
            "agentOwnershipEpoch": agent_ownership_epoch, "model": model,
            "apiProviderId": api_provider_id, "modelEndpointId": model_endpoint_id, "modelProtocol": model_protocol,
            "permissionMode": permission_mode, "thinkingMode": thinking_mode, "agentSettings": agent_settings,
            "title": title, "projectPath": project_path, "orderGroup": order_group, "tags": tags,
            "activity": activity, "preview": preview, "isActive": is_active, "isProcessing": is_processing,
            "processingPhase": processing_phase, "canReloadFromNativeHistory": can_reload_from_native_history,
            "isPinned": is_pinned, "isArchived": is_archived, "isUnread": is_unread,
        );
        map.end()
    }
}

impl Serialize for ProjectedChatSnapshot {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let entry = &self.0;
        let mut map = serializer.serialize_map(None)?;
        fields!(map, entry; "id": id, "activityStatus": activity_status);
        if !entry.executor_id.is_absent() {
            map.serialize_entry("executorId", &entry.executor_id)?;
        }
        fields!(map, entry;
            "agentId": agent_id, "agentOwnershipEpoch": agent_ownership_epoch, "carryOverRevision": carry_over_revision,
            "model": model, "apiProviderId": api_provider_id, "modelEndpointId": model_endpoint_id, "modelProtocol": model_protocol,
            "permissionMode": permission_mode, "thinkingMode": thinking_mode, "title": title, "projectPath": project_path,
            "tags": tags, "canReloadFromNativeHistory": can_reload_from_native_history, "activity": activity,
        );
        map.end()
    }
}
