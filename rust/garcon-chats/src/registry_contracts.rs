//! The current `chats.json` format. Transcript rows never live here.

use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    api_providers::ApiProtocol,
    chat_id::ChatId,
    chat_modes::{PermissionMode, ThinkingMode},
    chat_parentage::ChatLineage,
    executors::ExecutorId,
    preambles::{ChatPreambleSelection, PendingPreambleBoundary},
    transcript_seed::NativeSeedReceipt,
};
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::OptionalNullable;
use indexmap::IndexMap;
use serde::{Serialize, Serializer, ser::SerializeMap};

pub const CHAT_REGISTRY_VERSION: u64 = 6;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverMigrationQuarantine {
    pub artifact_id: String,
    pub error_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverHandoffTarget {
    pub agent_id: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryOverSegmentRef {
    pub id: String,
    pub agent_id: String,
    pub model: String,
    pub captured_at: String,
    pub stored_message_count: u64,
    pub visible_message_count: u64,
    pub trailing_handoff: Option<CarryOverHandoffTarget>,
}

macro_rules! entry_fields {
    ($($variant:ident => $field:ident: $ty:ty = $wire:literal),+ $(,)?) => {
        #[derive(Debug, Clone, PartialEq)]
        pub struct ChatRegistryEntry {
            $(pub $field: $ty,)+
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum EntryField { $($variant,)+ }

        impl EntryField {
            fn write<M: SerializeMap>(self, map: &mut M, entry: &ChatRegistryEntry) -> Result<(), M::Error> {
                match self { $(Self::$variant => map.serialize_entry($wire, &entry.$field),)+ }
            }
        }
    };
}

entry_fields! {
    ExecutorId => executor_id: OptionalNullable<ExecutorId> = "executorId",
    AgentId => agent_id: String = "agentId",
    AgentSessionId => agent_session_id: Option<String> = "agentSessionId",
    NativeSession => native_session: Option<AgentNativeSessionRef> = "nativeSession",
    AgentOwnershipEpoch => agent_ownership_epoch: String = "agentOwnershipEpoch",
    AgentSettingsById => agent_settings_by_id: IndexMap<String, AgentSettingsEnvelope> = "agentSettingsById",
    ProjectPath => project_path: String = "projectPath",
    Tags => tags: Vec<String> = "tags",
    Model => model: String = "model",
    ApiProviderId => api_provider_id: Option<String> = "apiProviderId",
    ModelEndpointId => model_endpoint_id: Option<String> = "modelEndpointId",
    ModelProtocol => model_protocol: Option<ApiProtocol> = "modelProtocol",
    LastReadAt => last_read_at: OptionalNullable<String> = "lastReadAt",
    PermissionMode => permission_mode: PermissionMode = "permissionMode",
    ThinkingMode => thinking_mode: ThinkingMode = "thinkingMode",
    CarryOverSegments => carry_over_segments: Vec<CarryOverSegmentRef> = "carryOverSegments",
    NativeSeedReceipt => native_seed_receipt: Option<NativeSeedReceipt> = "nativeSeedReceipt",
    CarryOverMigrationQuarantine => carry_over_migration_quarantine: Option<CarryOverMigrationQuarantine> = "carryOverMigrationQuarantine",
    PendingPreambleBoundary => pending_preamble_boundary: Option<PendingPreambleBoundary> = "pendingPreambleBoundary",
    PreambleSelection => preamble_selection: ChatPreambleSelection = "preambleSelection",
    ParentChatId => parent_chat_id: Option<ChatId> = "parentChatId",
    Lineage => lineage: Option<ChatLineage> = "lineage",
}

const LOADED_ORDER: &[EntryField] = {
    use EntryField::*;
    &[
        ExecutorId,
        AgentId,
        AgentSessionId,
        NativeSession,
        AgentOwnershipEpoch,
        AgentSettingsById,
        ProjectPath,
        Tags,
        Model,
        ApiProviderId,
        ModelEndpointId,
        ModelProtocol,
        LastReadAt,
        PermissionMode,
        ThinkingMode,
        CarryOverSegments,
        NativeSeedReceipt,
        CarryOverMigrationQuarantine,
        PendingPreambleBoundary,
        PreambleSelection,
        ParentChatId,
        Lineage,
    ]
};

const ADDED_ORDER: &[EntryField] = {
    use EntryField::*;
    &[
        ExecutorId,
        AgentId,
        NativeSession,
        AgentOwnershipEpoch,
        AgentSettingsById,
        ProjectPath,
        Tags,
        AgentSessionId,
        Model,
        ApiProviderId,
        ModelEndpointId,
        ModelProtocol,
        PermissionMode,
        ThinkingMode,
        CarryOverSegments,
        NativeSeedReceipt,
        CarryOverMigrationQuarantine,
        PendingPreambleBoundary,
        PreambleSelection,
        ParentChatId,
        Lineage,
    ]
};

// Object assignment keeps an existing field's position and appends new ones.
#[derive(Debug, Clone)]
pub(crate) struct StoredEntry {
    pub(crate) entry: ChatRegistryEntry,
    order: Vec<EntryField>,
}

impl StoredEntry {
    pub(crate) fn loaded(entry: ChatRegistryEntry) -> Self {
        Self::with_order(entry, LOADED_ORDER)
    }

    pub(crate) fn added(entry: ChatRegistryEntry) -> Self {
        Self::with_order(entry, ADDED_ORDER)
    }

    fn with_order(entry: ChatRegistryEntry, order: &[EntryField]) -> Self {
        let mut order = order.to_vec();
        if entry.executor_id.is_absent() {
            order.retain(|key| *key != EntryField::ExecutorId);
        }
        Self { entry, order }
    }

    pub(crate) fn touch(&mut self, field: EntryField) {
        if !self.order.contains(&field) {
            self.order.push(field);
        }
    }
}

impl Serialize for StoredEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for &field in &self.order {
            if (field == EntryField::ExecutorId && self.entry.executor_id.is_absent())
                || (field == EntryField::LastReadAt && self.entry.last_read_at.is_absent())
            {
                continue;
            }
            field.write(&mut map, &self.entry)?;
        }
        map.end()
    }
}

impl Serialize for ChatRegistryEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for &field in LOADED_ORDER {
            if (field == EntryField::ExecutorId && self.executor_id.is_absent())
                || (field == EntryField::LastReadAt && self.last_read_at.is_absent())
            {
                continue;
            }
            field.write(&mut map, self)?;
        }
        map.end()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatRegistrySnapshot {
    pub version: u64,
    pub(crate) sessions: IndexMap<ChatId, StoredEntry>,
}

impl ChatRegistrySnapshot {
    pub fn empty() -> Self {
        Self {
            version: CHAT_REGISTRY_VERSION,
            sessions: IndexMap::new(),
        }
    }
}
