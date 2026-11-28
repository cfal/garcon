use std::cell::Cell;
use std::path::Path;

use garcon_base::json_file_store::{QUARANTINE_INFIX, ReadJsonStateError};
use garcon_js::clock::{ManualClock, SystemClock};

use super::*;

fn identity() -> TelegramBotIdentity {
    TelegramBotIdentity {
        id: Number(123.0),
        username: " @@Garcon_BOT ".into(),
        first_name: "Garcon".into(),
    }
}

fn recipient(offset: f64) -> TelegramLinkResolution {
    TelegramLinkResolution {
        next_offset: Some(Number(offset)),
        recipient: Some(TelegramResolvedRecipient {
            chat_id: "1234".into(),
            username: Some("  @ALICE  ".into()),
            display_name: Some("Alice A.".into()),
        }),
    }
}

fn offset(offset: f64) -> TelegramLinkResolution {
    TelegramLinkResolution {
        next_offset: Some(Number(offset)),
        recipient: None,
    }
}

async fn oracle(action: &str, path: &Path) -> Vec<u8> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/telegram_settings_oracle.ts");
    let output = tokio::process::Command::new("bun")
        .arg(script)
        .arg(action)
        .arg(path)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut status = output.stdout;
    assert_eq!(status.pop(), Some(b'\n'));
    status
}

#[tokio::test]
async fn original_and_rust_read_and_write_each_others_notification_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("notifications.json");
    let config = root.path().to_str().unwrap();
    let initial_status = oracle("link", &path).await;
    let bun_written = tokio::fs::read(&path).await.unwrap();
    let store = TelegramSettingsStore::open(config, Rc::new(SystemClock))
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), bun_written);
    assert_eq!(
        serde_json::to_vec(&store.public_status()).unwrap(),
        initial_status
    );
    assert!(store.is_configured());
    assert_eq!(store.bot_token(), "fixture-token");
    let pending = store.pending_recipient_link().unwrap();
    assert_eq!(pending.bot_id, Some(Number(123.0)));
    assert_eq!(pending.link_code.len(), 32);
    assert!(
        store
            .apply_recipient_link_result(&pending, recipient(7.0))
            .await
            .unwrap()
    );
    let linked = store.public_status();
    let rust_written = tokio::fs::read(&path).await.unwrap();
    assert_eq!(
        oracle("normalize", &path).await,
        serde_json::to_vec(&linked).unwrap()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), rust_written);
    assert_eq!(
        oracle("clear", &path).await,
        serde_json::to_vec(&linked).unwrap()
    );
    let store = TelegramSettingsStore::open(config, Rc::new(SystemClock))
        .await
        .unwrap();
    assert_eq!(store.recipient_chat_id(), "");
    assert_eq!(store.snapshot.borrow().update_offset, Some(Number(7.0)));
    assert_eq!(store.bot_token(), "fixture-token");
    assert!(store.pending_recipient_link().is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            tokio::fs::metadata(&path)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn normalizes_the_versioned_file_like_the_original() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().to_str().unwrap();
    let path = root.path().join("notifications.json");
    for digits in ["-1", "-0.0", "5.25", "9007199254740992", "9007199254740991"] {
        let raw = format!(
            r#"{{"version":1.0,"ignored":true,"telegram":{{"botId":{digits},"updateOffset":{digits},"botToken":"  fixture  ","botUsername":" @@@BOT ","recipientUsername":" @ALICE ","chatId":123,"botFirstName":null,"recipientDisplayName":"  Alice  ","pendingLinkCode":"invalid-date-code","pendingLinkCreatedAt":"not a date"}}}}"#
        );
        tokio::fs::write(&path, &raw).await.unwrap();
        let expected = oracle("normalize", &path).await;
        let bun_written = tokio::fs::read(&path).await.unwrap();
        tokio::fs::write(&path, &raw).await.unwrap();
        let store = TelegramSettingsStore::open(config, Rc::new(SystemClock))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_vec(&store.public_status()).unwrap(),
            expected
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bun_written);
    }
}

#[tokio::test]
async fn quarantines_corrupt_settings_without_overwriting_the_bot_token() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("notifications.json");
    let config = root.path().to_str().unwrap();
    let bytes = r#"{"version":2,"telegram":{"botToken":"fixture-token"}}"#;
    tokio::fs::write(&path, bytes).await.unwrap();
    for _ in 0..2 {
        let error = TelegramSettingsStore::open(config, Rc::new(SystemClock))
            .await
            .err()
            .unwrap();
        let error = error.downcast_ref::<ReadJsonStateError>().unwrap();
        let ReadJsonStateError::Corrupt(error) = error else {
            panic!("{error}")
        };
        let quarantine = error.quarantine_path.as_ref().unwrap();
        assert!(quarantine.contains(QUARANTINE_INFIX));
        assert_eq!(tokio::fs::read_to_string(quarantine).await.unwrap(), bytes);
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn creates_and_completes_a_one_time_recipient_link_and_clears_all_settings_with_token() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("notifications.json");
    let clock = Rc::new(ManualClock::new(1_700_000_000_000));
    let store = TelegramSettingsStore::open(root.path().to_str().unwrap(), clock.clone())
        .await
        .unwrap();
    let changes = Rc::new(Cell::new(0));
    store.on_changed(Rc::new({
        let changes = changes.clone();
        move || {
            changes.set(changes.get() + 1);
            Ok(())
        }
    }));
    assert!(!store.is_configured());
    assert_eq!(
        store
            .set_bot_token(" \u{feff} ", identity())
            .await
            .unwrap_err()
            .to_string(),
        "botToken is required"
    );
    assert_eq!(
        store.begin_recipient_link().await.unwrap_err().to_string(),
        "Telegram bot token is not configured"
    );
    store
        .set_bot_token("  fixture-token  ", identity())
        .await
        .unwrap();
    assert_eq!(store.bot_token(), "fixture-token");
    let link = store.begin_recipient_link().await.unwrap();
    let expected = store.pending_recipient_link().unwrap();
    assert_eq!(
        link,
        format!("https://t.me/garcon_bot?start={}", expected.link_code)
    );
    assert!(
        expected.link_code.len() == 32
            && expected
                .link_code
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    clock.advance(LINK_TTL_MS);
    assert!(store.public_status().pending_link);
    clock.advance(1);
    let before = tokio::fs::read(&path).await.unwrap();
    assert!(
        !store
            .apply_recipient_link_result(&expected, recipient(45.0))
            .await
            .unwrap()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
    let link = store.begin_recipient_link().await.unwrap();
    assert_ne!(
        link,
        format!("https://t.me/garcon_bot?start={}", expected.link_code)
    );
    assert!(
        !store
            .apply_recipient_link_result(&expected, recipient(45.0))
            .await
            .unwrap()
    );
    let pending = store.pending_recipient_link().unwrap();
    assert!(
        store
            .apply_recipient_link_result(&pending, recipient(45.0))
            .await
            .unwrap()
    );
    assert!(
        !store
            .apply_recipient_link_result(&pending, recipient(46.0))
            .await
            .unwrap()
    );
    let status = store.public_status();
    assert!(status.recipient_linked);
    assert!(!status.pending_link);
    assert_eq!(status.link_url, None);
    assert_eq!(status.recipient_username.as_deref(), Some("alice"));
    assert_eq!(status.recipient_display_name.as_deref(), Some("Alice A."));
    let raw = serde_json::to_string(&status).unwrap();
    for secret in ["fixture-token", &pending.link_code, "1234"] {
        assert!(!raw.contains(secret));
    }
    store.clear_bot_token().await.unwrap();
    assert!(!store.is_configured());
    assert_eq!(store.recipient_chat_id(), "");
    assert!(store.pending_recipient_link().is_none());
    assert_eq!(store.snapshot.borrow().update_offset, None);
    assert_eq!(changes.get(), 5);
}

#[derive(Default)]
struct FailingWriter {
    disk: JsonFileStore,
    fail_before_write: Cell<bool>,
    fail_after_write: Cell<bool>,
}

#[async_trait::async_trait(?Send)]
impl NotificationWriter for FailingWriter {
    async fn write(
        &self,
        path: &str,
        candidate: &NotificationSecretsSnapshot,
    ) -> Result<(), BoxError> {
        if self.fail_before_write.replace(false) {
            return Err("disk full".into());
        }
        NotificationWriter::write(&self.disk, path, candidate).await?;
        if self.fail_after_write.replace(false) {
            return Err("directory sync failed".into());
        }
        Ok(())
    }
}

#[tokio::test]
async fn applies_offsets_monotonically_and_only_publishes_after_durability() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().to_str().unwrap();
    let writer = Rc::new(FailingWriter::default());
    let store = TelegramSettingsStore::open_with(
        config,
        Rc::new(SystemClock),
        random_link_code,
        writer.clone(),
    )
    .await
    .unwrap();
    let changes = Rc::new(Cell::new(0));
    store.on_changed(Rc::new({
        let changes = changes.clone();
        move || {
            changes.set(changes.get() + 1);
            Ok(())
        }
    }));
    writer.fail_before_write.set(true);
    assert!(
        store
            .set_bot_token("absent-token", identity())
            .await
            .is_err()
    );
    assert!(!store.is_configured());
    writer.fail_after_write.set(true);
    assert!(
        store
            .set_bot_token("uncertain-token", identity())
            .await
            .is_err()
    );
    assert!(!store.is_configured());
    assert_eq!(changes.get(), 0);
    assert_eq!(
        read(&store.file_path).await.unwrap().telegram.bot_token,
        "uncertain-token"
    );

    store
        .set_bot_token("confirmed-token", identity())
        .await
        .unwrap();
    store.begin_recipient_link().await.unwrap();
    let expected = store.pending_recipient_link().unwrap();
    assert!(
        store
            .apply_recipient_link_result(&expected, offset(50.0))
            .await
            .unwrap()
    );
    assert!(
        store
            .apply_recipient_link_result(&expected, offset(20.0))
            .await
            .unwrap()
    );
    assert_eq!(changes.get(), 3);
    assert_eq!(
        store.pending_recipient_link().unwrap().offset,
        Some(Number(50.0))
    );

    writer.fail_before_write.set(true);
    assert!(
        store
            .apply_recipient_link_result(&expected, recipient(30.0))
            .await
            .is_err()
    );
    assert!(!store.public_status().recipient_linked);
    assert_eq!(changes.get(), 3);
    assert!(
        store
            .apply_recipient_link_result(&expected, recipient(30.0))
            .await
            .unwrap()
    );
    let on_disk = read(&store.file_path).await.unwrap().telegram;
    assert_eq!(on_disk.chat_id, "1234");
    assert_eq!(on_disk.update_offset, Some(Number(50.0)));
    assert!(on_disk.pending_link_code.is_empty());
    assert_eq!(changes.get(), 4);
    store.clear_recipient().await.unwrap();
    assert!(!store.public_status().recipient_linked);
    assert_eq!(store.bot_token(), "confirmed-token");
    assert_eq!(
        read(&store.file_path).await.unwrap().telegram.update_offset,
        Some(Number(50.0))
    );
    assert_eq!(changes.get(), 5);
}
