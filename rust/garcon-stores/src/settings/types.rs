//! Durable settings records from `server/controller/settings/types.ts`.

use garcon_contract::settings::{
    RecentAgentSetting, RemoteExecutionDefaults, RemoteFeatureSettings,
};
use garcon_js::json::Opaque;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub features: RemoteFeatureSettings,
    pub ui: Opaque,
    pub paths: Opaque,
    pub chat_names: Opaque,
    pub remote_settings_version: u64,
    pub pinned_chat_ids: Vec<String>,
    pub normal_chat_ids: Vec<String>,
    pub archived_chat_ids: Vec<String>,
    pub recent_agent_settings: Vec<RecentAgentSetting>,
    pub execution_defaults: RemoteExecutionDefaults,
    pub chat_folders: Vec<ChatFolder>,
    pub saved_chat_searches: Vec<SavedChatSearch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFolder {
    pub id: String,
    pub name: String,
    pub filter: FolderFilter,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFilter {
    pub text_tokens: Vec<String>,
    pub tags: Vec<String>,
    pub agents: Vec<String>,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FolderFilterStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderFilterStatus {
    Active,
    Unread,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatSearch {
    pub id: String,
    pub title: Option<String>,
    pub query: String,
    pub show_as_sidebar_pill: bool,
    pub show_in_sidebar_menu: bool,
    pub show_in_search_dialog: bool,
    pub created_at: String,
    pub updated_at: String,
}
