use std::collections::HashSet;
use std::error::Error;

use super::store::Mutation;
use super::{ProjectSettings, SettingsChange, SettingsStore};

impl SettingsStore {
    pub async fn ensure_in_normal(&self, chat_id: &str) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            let before = pinned_order(settings);
            remove_from_lists(settings, chat_id);
            settings.normal_chat_ids.insert(0, chat_id.into());
            let mut events = pinned_version_change(settings, &before);
            events.push(list_change("chat-added", chat_id));
            Ok(Mutation::Save((), events))
        })
        .await
    }

    pub async fn insert_normal_chat_id_top(&self, chat_id: &str) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            move_to_top(&mut settings.normal_chat_ids, chat_id);
            Ok(Mutation::Save((), Vec::new()))
        })
        .await
    }

    pub async fn remove_from_all_order_lists(&self, chat_id: &str) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            let before = pinned_order(settings);
            if !remove_from_lists(settings, chat_id) {
                return Ok(Mutation::Unchanged(()));
            }
            Ok(Mutation::Save((), pinned_version_change(settings, &before)))
        })
        .await
    }

    pub async fn toggle_pin(&self, chat_id: &str) -> Result<bool, Box<dyn Error>> {
        self.mutate(|settings| {
            let was_pinned = remove_id(&mut settings.pinned_chat_ids, chat_id);
            if was_pinned {
                move_to_top(&mut settings.normal_chat_ids, chat_id);
            } else {
                remove_id(&mut settings.normal_chat_ids, chat_id);
                remove_id(&mut settings.archived_chat_ids, chat_id);
                if settings.ui["pinnedInsertPosition"].as_str() == Some("bottom") {
                    settings.pinned_chat_ids.push(chat_id.into());
                } else {
                    settings.pinned_chat_ids.insert(0, chat_id.into());
                }
            }
            settings.remote_settings_version += 1;
            Ok(Mutation::Save(
                !was_pinned,
                vec![
                    SettingsChange::RemoteSettings,
                    list_change("pinned-toggled", chat_id),
                ],
            ))
        })
        .await
    }

    pub async fn toggle_archive(&self, chat_id: &str) -> Result<bool, Box<dyn Error>> {
        self.mutate(|settings| {
            let before = pinned_order(settings);
            let was_archived = remove_id(&mut settings.archived_chat_ids, chat_id);
            if was_archived {
                move_to_top(&mut settings.normal_chat_ids, chat_id);
            } else {
                remove_id(&mut settings.pinned_chat_ids, chat_id);
                remove_id(&mut settings.normal_chat_ids, chat_id);
                settings.archived_chat_ids.insert(0, chat_id.into());
            }
            let mut events = pinned_version_change(settings, &before);
            events.push(list_change("archive-toggled", chat_id));
            Ok(Mutation::Save(!was_archived, events))
        })
        .await
    }
}

fn list_change(reason: &str, chat_id: &str) -> SettingsChange {
    SettingsChange::List {
        reason: reason.into(),
        chat_id: chat_id.into(),
    }
}

fn pinned_order(settings: &ProjectSettings) -> Vec<String> {
    let mut seen = HashSet::new();
    settings
        .pinned_chat_ids
        .iter()
        .filter(|id| seen.insert(*id))
        .cloned()
        .collect()
}

fn pinned_version_change(settings: &mut ProjectSettings, before: &[String]) -> Vec<SettingsChange> {
    if pinned_order(settings) == before {
        Vec::new()
    } else {
        settings.remote_settings_version += 1;
        vec![SettingsChange::RemoteSettings]
    }
}

fn remove_from_lists(settings: &mut ProjectSettings, chat_id: &str) -> bool {
    let pinned = remove_id(&mut settings.pinned_chat_ids, chat_id);
    let normal = remove_id(&mut settings.normal_chat_ids, chat_id);
    let archived = remove_id(&mut settings.archived_chat_ids, chat_id);
    pinned || normal || archived
}

fn remove_id(ids: &mut Vec<String>, chat_id: &str) -> bool {
    let before = ids.len();
    ids.retain(|id| id != chat_id);
    ids.len() != before
}

fn move_to_top(ids: &mut Vec<String>, chat_id: &str) {
    remove_id(ids, chat_id);
    ids.insert(0, chat_id.into());
}
