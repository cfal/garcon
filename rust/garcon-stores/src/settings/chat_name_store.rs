use std::error::Error;

use garcon_contract::chat_title_contracts::{CHAT_TITLE_MAX_BYTES, is_chat_title_within_limit};
use garcon_js::trim;
use serde_json::Value;

use super::settings_shared::record;
use super::store::Mutation;
use super::{ProjectSettings, SettingsChange, SettingsStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNameUpdate {
    pub title: String,
    pub changed: bool,
}

impl SettingsStore {
    pub fn chat_name(&self, chat_id: &str) -> Option<String> {
        if chat_id.is_empty() {
            return None;
        }
        self.snapshot().chat_names[chat_id]
            .as_str()
            .map(str::to_owned)
    }

    pub async fn set_session_name(
        &self,
        chat_id: &str,
        title: &str,
    ) -> Result<SessionNameUpdate, Box<dyn Error>> {
        let title = trim(title);
        self.mutate(|settings| {
            let notification = update_name(settings, chat_id, title)?;
            let result = SessionNameUpdate {
                title: title.into(),
                changed: notification.is_some(),
            };
            Ok(match notification {
                Some(notification) => Mutation::Save(result, vec![notification]),
                None => Mutation::Unchanged(result),
            })
        })
        .await
    }

    pub async fn set_session_name_if_absent(
        &self,
        chat_id: &str,
        title: &str,
    ) -> Result<bool, Box<dyn Error>> {
        self.mutate(|settings| {
            if settings.chat_names[chat_id]
                .as_str()
                .is_some_and(|title| !title.is_empty())
            {
                return Ok(Mutation::Unchanged(false));
            }
            Ok(match update_name(settings, chat_id, trim(title))? {
                Some(notification) => Mutation::Save(true, vec![notification]),
                None => Mutation::Unchanged(true),
            })
        })
        .await
    }

    pub async fn remove_session_name(&self, chat_id: &str) -> Result<(), Box<dyn Error>> {
        self.mutate(|settings| {
            let mut names = record(&settings.chat_names);
            names.shift_remove(chat_id);
            settings.chat_names = Value::Object(names).into();
            Ok(Mutation::Save((), Vec::new()))
        })
        .await
    }
}

fn update_name(
    settings: &mut ProjectSettings,
    chat_id: &str,
    title: &str,
) -> Result<Option<SettingsChange>, Box<dyn Error>> {
    if !is_chat_title_within_limit(title) {
        return Err(
            format!("Chat title must be at most {CHAT_TITLE_MAX_BYTES} UTF-8 bytes").into(),
        );
    }
    if settings.chat_names[chat_id].as_str().unwrap_or("") == title {
        return Ok(None);
    }
    let mut names = record(&settings.chat_names);
    if title.is_empty() {
        names.shift_remove(chat_id);
    } else if chat_id != "__proto__" {
        names.insert(chat_id.into(), Value::String(title.into()));
    }
    settings.chat_names = Value::Object(names).into();
    Ok(Some(SettingsChange::SessionName {
        chat_id: chat_id.into(),
        title: title.into(),
    }))
}
