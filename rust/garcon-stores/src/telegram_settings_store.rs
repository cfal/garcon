//! Owns the controller's private `notifications.json` file.

use std::cell::RefCell;
use std::error::Error;
use std::io;
use std::rc::Rc;

use garcon_base::errors::NamedError;
use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions};
use garcon_base::keyed_lock::KeyedLock;
use garcon_contract::settings::RemoteTelegramStatus;
use garcon_js::clock::to_iso_string;
use garcon_js::date_parse::date_parse;
use garcon_js::{Clock, Number, is_safe_integer, path::native, trim};
use serde::Serialize;
use serde_json::Value;

type BoxError = Box<dyn Error>;
type ChangeListener = Rc<dyn Fn() -> Result<(), BoxError>>;
const LINK_TTL_MS: i64 = 10 * 60 * 1000;
const WRITE_LOCK: &str = "telegram-settings";

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramSecrets {
    bot_token: String,
    bot_id: Option<Number>,
    bot_username: String,
    bot_first_name: String,
    recipient_username: String,
    recipient_display_name: String,
    chat_id: String,
    pending_link_code: String,
    pending_link_created_at: String,
    update_offset: Option<Number>,
}

#[derive(Serialize)]
struct NotificationSecretsSnapshot {
    version: u8,
    telegram: TelegramSecrets,
}

pub struct TelegramBotIdentity {
    pub id: Number,
    pub username: String,
    pub first_name: String,
}

pub struct TelegramResolvedRecipient {
    pub chat_id: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
}

pub struct TelegramLinkResolution {
    pub recipient: Option<TelegramResolvedRecipient>,
    pub next_offset: Option<Number>,
}

pub struct TelegramPendingRecipientLink {
    pub bot_token: String,
    pub bot_id: Option<Number>,
    pub link_code: String,
    pub offset: Option<Number>,
}

#[async_trait::async_trait(?Send)]
trait NotificationWriter {
    async fn write(
        &self,
        path: &str,
        candidate: &NotificationSecretsSnapshot,
    ) -> Result<(), BoxError>;
}

#[async_trait::async_trait(?Send)]
impl NotificationWriter for JsonFileStore {
    async fn write(
        &self,
        path: &str,
        candidate: &NotificationSecretsSnapshot,
    ) -> Result<(), BoxError> {
        self.write_json_file_atomic(
            path,
            candidate,
            JsonWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }
}

pub struct TelegramSettingsStore {
    file_path: String,
    clock: Rc<dyn Clock>,
    link_code: fn() -> io::Result<String>,
    snapshot: RefCell<TelegramSecrets>,
    write_lock: KeyedLock,
    writer: Rc<dyn NotificationWriter>,
    listeners: RefCell<Vec<ChangeListener>>,
}

impl TelegramSettingsStore {
    pub async fn open(config_dir: &str, clock: Rc<dyn Clock>) -> Result<Self, BoxError> {
        Self::open_with(
            config_dir,
            clock,
            random_link_code,
            Rc::new(JsonFileStore::default()),
        )
        .await
    }

    async fn open_with(
        config_dir: &str,
        clock: Rc<dyn Clock>,
        link_code: fn() -> io::Result<String>,
        writer: Rc<dyn NotificationWriter>,
    ) -> Result<Self, BoxError> {
        tokio::fs::create_dir_all(config_dir).await?;
        let file_path = native::join(&[config_dir, "notifications.json"]);
        let snapshot = read(&file_path).await?;
        writer.write(&file_path, &snapshot).await?;
        Ok(Self {
            file_path,
            clock,
            link_code,
            snapshot: RefCell::new(snapshot.telegram),
            write_lock: KeyedLock::new(),
            writer,
            listeners: RefCell::new(Vec::new()),
        })
    }

    pub fn is_configured(&self) -> bool {
        !self.snapshot.borrow().bot_token.is_empty()
    }

    pub fn bot_token(&self) -> String {
        self.snapshot.borrow().bot_token.clone()
    }

    pub fn recipient_chat_id(&self) -> String {
        self.snapshot.borrow().chat_id.clone()
    }

    pub fn pending_recipient_link(&self) -> Option<TelegramPendingRecipientLink> {
        let telegram = self.snapshot.borrow();
        self.has_active_pending_link(&telegram)
            .then(|| TelegramPendingRecipientLink {
                bot_token: telegram.bot_token.clone(),
                bot_id: telegram.bot_id,
                link_code: telegram.pending_link_code.clone(),
                offset: telegram.update_offset,
            })
    }

    pub fn public_status(&self) -> RemoteTelegramStatus {
        let telegram = self.snapshot.borrow();
        let pending_link = self.has_active_pending_link(&telegram);
        let present = |value: &str| (!value.is_empty()).then(|| value.to_owned());
        RemoteTelegramStatus {
            bot_token_available: !telegram.bot_token.is_empty(),
            bot_username: present(&telegram.bot_username),
            bot_first_name: present(&telegram.bot_first_name),
            recipient_username: present(&telegram.recipient_username),
            recipient_display_name: present(&telegram.recipient_display_name),
            recipient_linked: !telegram.chat_id.is_empty(),
            pending_link,
            link_url: pending_link.then(|| link_url(&telegram)).flatten(),
        }
    }

    pub fn on_changed(&self, listener: ChangeListener) {
        self.listeners.borrow_mut().push(listener);
    }

    pub async fn set_bot_token(
        &self,
        raw_token: &str,
        identity: TelegramBotIdentity,
    ) -> Result<(), BoxError> {
        let token = trim(raw_token);
        if token.is_empty() {
            return Err("botToken is required".into());
        }
        self.mutate(move |telegram| {
            *telegram = TelegramSecrets {
                bot_token: token.into(),
                bot_id: Some(identity.id),
                bot_username: normalize_username(&identity.username),
                bot_first_name: identity.first_name,
                ..Default::default()
            };
            Ok(((), true))
        })
        .await
    }

    pub async fn clear_bot_token(&self) -> Result<(), BoxError> {
        self.mutate(|telegram| {
            *telegram = TelegramSecrets::default();
            Ok(((), true))
        })
        .await
    }

    pub async fn begin_recipient_link(&self) -> Result<String, BoxError> {
        self.mutate(|telegram| {
            if telegram.bot_token.is_empty() || telegram.bot_username.is_empty() {
                return Err("Telegram bot token is not configured".into());
            }
            telegram.pending_link_code = (self.link_code)()?;
            telegram.pending_link_created_at = to_iso_string(self.clock.now_ms())?;
            Ok((link_url(telegram).unwrap_or_default(), true))
        })
        .await
    }

    pub async fn apply_recipient_link_result(
        &self,
        expected: &TelegramPendingRecipientLink,
        result: TelegramLinkResolution,
    ) -> Result<bool, BoxError> {
        self.mutate(|telegram| {
            if !self.has_active_pending_link(telegram)
                || telegram.pending_link_code != expected.link_code
                || telegram.bot_token != expected.bot_token
                || telegram.bot_id != expected.bot_id
            {
                return Ok((false, false));
            }
            let next_offset = match result.next_offset {
                Some(Number(offset)) => {
                    let previous = telegram.update_offset.unwrap_or(Number(0.0)).0;
                    Some(Number(if offset.is_nan() {
                        offset
                    } else {
                        previous.max(offset)
                    }))
                }
                None => telegram.update_offset,
            };
            if result.recipient.is_none() && next_offset == telegram.update_offset {
                return Ok((true, false));
            }
            telegram.update_offset = next_offset;
            if let Some(recipient) = result.recipient {
                telegram.chat_id = recipient.chat_id;
                telegram.recipient_username =
                    normalize_username(recipient.username.as_deref().unwrap_or_default());
                telegram.recipient_display_name = recipient.display_name.unwrap_or_default();
                telegram.pending_link_code.clear();
                telegram.pending_link_created_at.clear();
            }
            Ok((true, true))
        })
        .await
    }

    pub async fn clear_recipient(&self) -> Result<(), BoxError> {
        self.mutate(|telegram| {
            telegram.recipient_username.clear();
            telegram.recipient_display_name.clear();
            telegram.chat_id.clear();
            telegram.pending_link_code.clear();
            telegram.pending_link_created_at.clear();
            Ok(((), true))
        })
        .await
    }

    fn has_active_pending_link(&self, telegram: &TelegramSecrets) -> bool {
        !telegram.pending_link_code.is_empty()
            && date_parse(&telegram.pending_link_created_at).is_some_and(|created_at| {
                self.clock.now_ms().saturating_sub(created_at) <= LINK_TTL_MS
            })
    }

    async fn mutate<T>(
        &self,
        update: impl FnOnce(&mut TelegramSecrets) -> Result<(T, bool), BoxError>,
    ) -> Result<T, BoxError> {
        let (result, changed) = self
            .write_lock
            .run_exclusive(
                WRITE_LOCK,
                || async {
                    let mut snapshot = read(&self.file_path).await?;
                    let (result, changed) = update(&mut snapshot.telegram)?;
                    if changed {
                        self.writer.write(&self.file_path, &snapshot).await?;
                        self.snapshot.replace(snapshot.telegram);
                    }
                    Ok::<_, BoxError>((result, changed))
                },
                None,
            )
            .await??;
        if changed {
            let listeners = self.listeners.borrow().clone();
            for listener in listeners {
                listener()?;
            }
        }
        Ok(result)
    }
}

fn random_link_code() -> io::Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    const HEX: &[u8] = b"0123456789abcdef";
    Ok(bytes
        .into_iter()
        .flat_map(|byte| {
            [
                HEX[(byte >> 4) as usize] as char,
                HEX[(byte & 0xf) as usize] as char,
            ]
        })
        .collect())
}

fn link_url(telegram: &TelegramSecrets) -> Option<String> {
    (!telegram.bot_username.is_empty() && !telegram.pending_link_code.is_empty()).then(|| {
        format!(
            "https://t.me/{}?start={}",
            telegram.bot_username, telegram.pending_link_code
        )
    })
}

fn normalize_username(value: &str) -> String {
    trim(value).trim_start_matches('@').to_lowercase()
}

fn normalize_snapshot(value: &Value) -> Result<NotificationSecretsSnapshot, BoxError> {
    let invalid = |message: &str| -> BoxError {
        Box::new(NamedError {
            name: "TypeError".into(),
            message: message.into(),
            code: None,
        })
    };
    if !value.is_object() {
        return Err(invalid("Notification state must be a JSON object"));
    }
    let telegram = &value["telegram"];
    if value["version"].as_f64() != Some(1.0) || !telegram.is_object() {
        return Err(invalid(
            "Notification state must use version 1 with a telegram object",
        ));
    }
    let string = |key| telegram[key].as_str().unwrap_or_default();
    let safe_integer = |key| telegram[key].as_f64().filter(|v| is_safe_integer(*v));
    Ok(NotificationSecretsSnapshot {
        version: 1,
        telegram: TelegramSecrets {
            bot_token: string("botToken").into(),
            bot_id: safe_integer("botId").map(Number),
            bot_username: normalize_username(string("botUsername")),
            bot_first_name: string("botFirstName").into(),
            recipient_username: normalize_username(string("recipientUsername")),
            recipient_display_name: string("recipientDisplayName").into(),
            chat_id: string("chatId").into(),
            pending_link_code: string("pendingLinkCode").into(),
            pending_link_created_at: string("pendingLinkCreatedAt").into(),
            update_offset: safe_integer("updateOffset")
                .filter(|v| *v >= 0.0)
                .map(Number),
        },
    })
}

async fn read(path: &str) -> Result<NotificationSecretsSnapshot, BoxError> {
    Ok(JsonFileStore::default()
        .read_json_state_file(
            path,
            || NotificationSecretsSnapshot {
                version: 1,
                telegram: TelegramSecrets::default(),
            },
            |value| normalize_snapshot(&value),
        )
        .await?)
}

#[cfg(test)]
mod tests;
