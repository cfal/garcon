use std::collections::HashSet;
use std::error::Error;

use garcon_base::log::{Logger, create_logger};
use garcon_js::{collation::Collation, json, trim, utf16};
use serde::Serialize;

use super::store::Mutation;
use super::{ProjectSettings, SettingsChange, SettingsStore};

impl SettingsStore {
    pub async fn reconcile_with_registry(
        &self,
        registered_chat_ids: &[String],
    ) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            let Some(order) = reconcile_order(
                &settings.pinned_chat_ids,
                &settings.normal_chat_ids,
                &settings.archived_chat_ids,
                registered_chat_ids,
            ) else {
                return Ok(Mutation::Unchanged(()));
            };
            settings.pinned_chat_ids = order.pinned_chat_ids;
            settings.normal_chat_ids = order.normal_chat_ids;
            settings.archived_chat_ids = order.archived_chat_ids;
            settings.remote_settings_version += u64::from(order.pinned_changed);
            Ok(Mutation::Save((), Vec::new()))
        })
        .await
    }

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
    dedup(&settings.pinned_chat_ids)
}

fn dedup(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| trim(id))
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReconciledOrder {
    pinned_chat_ids: Vec<String>,
    normal_chat_ids: Vec<String>,
    archived_chat_ids: Vec<String>,
    pinned_changed: bool,
}

fn reconcile_order(
    pinned: &[String],
    normal: &[String],
    archived: &[String],
    registered: &[String],
) -> Option<ReconciledOrder> {
    const LIST_NAMES: [&str; 3] = ["pinnedChatIds", "normalChatIds", "archivedChatIds"];
    let logger = create_logger("settings:chat-order");
    let before_pinned = dedup(pinned);
    let mut lists = [before_pinned.clone(), dedup(normal), dedup(archived)];
    let known: HashSet<&str> = registered.iter().map(String::as_str).collect();
    // Within-list deduplication alone does not cause a startup write.
    let mut dirty = false;
    for (list, name) in lists.iter_mut().zip(LIST_NAMES) {
        let removed = remove_matching(list, |id| !known.contains(id));
        if !removed.is_empty() {
            logger.info(&format!(
                "chat-order: removed unknown chat IDs from {name}: {}",
                json::stringify(&serde_json::json!(removed))
            ));
            dirty = true;
        }
    }
    let mut claimed = HashSet::new();
    for (list, name) in lists.iter_mut().zip(LIST_NAMES) {
        let removed = remove_matching(list, |id| !claimed.insert(id.to_owned()));
        if !removed.is_empty() {
            logger.info(&format!(
                "chat-order: removed duplicate chat IDs from {name}: {}",
                json::stringify(&serde_json::json!(removed))
            ));
            dirty = true;
        }
    }
    let mut missing: Vec<_> = registered
        .iter()
        .filter(|id| claimed.insert((*id).clone()))
        .cloned()
        .collect();
    let [pinned_chat_ids, mut normal_chat_ids, archived_chat_ids] = lists;
    if !missing.is_empty() {
        let compare = Collation::english();
        missing.sort_by(|left, right| {
            utf16::len(right)
                .cmp(&utf16::len(left))
                .then_with(|| compare.compare(right, left))
        });
        logger.info(&format!(
            "chat-order: added missing chat IDs to normalChatIds: {}",
            json::stringify(&serde_json::json!(missing))
        ));
        missing.extend(normal_chat_ids);
        normal_chat_ids = missing;
        dirty = true;
    }
    dirty.then(|| ReconciledOrder {
        pinned_changed: pinned_chat_ids != before_pinned,
        pinned_chat_ids,
        normal_chat_ids,
        archived_chat_ids,
    })
}

fn remove_matching(ids: &mut Vec<String>, mut matches: impl FnMut(&str) -> bool) -> Vec<String> {
    let mut removed = Vec::new();
    ids.retain(|id| {
        if matches(id) {
            removed.push(id.clone());
            false
        } else {
            true
        }
    });
    removed
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

#[cfg(test)]
#[path = "registry_reconciliation_tests.rs"]
mod registry_reconciliation_tests;
