use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use garcon_base::json_file_store::{
    JsonFileStore, JsonWriteOptions, ReadJsonStateError, WriteFileError,
};
use garcon_base::private_file::assert_private_file;
use garcon_js::{ManualClock, json::Opaque};
use serde_json::{Value, json};
use tokio::{fs, process::Command};
use uuid::Uuid;

async fn bun(operation: &str, path: &Path) -> String {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/json_file_store_oracle.ts"
        ))
        .arg(operation)
        .arg(path)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
async fn writes_and_reads_original_state_in_both_directions() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original.json");
    let rust = root.path().join("rust.json");
    let store = JsonFileStore::default();
    bun("write", &original).await;
    assert_private_file(&original).await.unwrap();
    let state = store
        .read_json_state_file(original.to_str().unwrap(), Opaque::default, Ok)
        .await
        .unwrap();
    assert_eq!(
        state,
        Opaque::from_value(json!({"z": 1e21, "a": [1, "synthetic"]}))
    );

    store
        .write_json_file_atomic(
            rust.to_str().unwrap(),
            &state,
            JsonWriteOptions {
                mode: Some(0o600),
                trailing_newline: Some(false),
            },
        )
        .await
        .unwrap();
    let report: Value = garcon_js::json::from_str(&bun("read", &rust).await).unwrap();
    let original_bytes = fs::read_to_string(&original).await.unwrap();
    assert!(original_bytes.contains("1e+21"));
    assert!(!original_bytes.ends_with('\n'));
    assert_eq!(report["raw"], original_bytes);
    assert_eq!(report["state"], report["parsed"]);
    assert_eq!(report["mode"], 0o600);
    assert_eq!(report["entries"], json!(["original.json", "rust.json"]));
}

#[tokio::test]
async fn quarantines_malformed_state_without_losing_its_bytes_or_mode() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("auth.json");
    let file_path = path.to_str().unwrap();
    let store = JsonFileStore::new(ManualClock::new(0), || {
        Uuid::from_u128(0x12345678_0000_4000_8000_000000000000)
    });
    let bytes = br#"{"synthetic": "#;
    store
        .write_file_atomic(file_path, bytes, Some(0o600))
        .await
        .unwrap();
    let error = store
        .read_json_state_file(file_path, Opaque::default, Ok)
        .await
        .unwrap_err();
    let ReadJsonStateError::Corrupt(error) = error else {
        panic!("{error}")
    };
    let quarantine = error.quarantine_path.unwrap();
    assert_eq!(
        quarantine,
        format!("{file_path}.corrupt-19700101T000000000Z-12345678")
    );
    assert_eq!(fs::read(&quarantine).await.unwrap(), bytes);
    assert_eq!(
        fs::metadata(&quarantine)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(!path.exists());
    assert_eq!(bun("read-quarantine", &path).await.trim_end(), quarantine);

    fs::write(&path, bytes).await.unwrap();
    let original_quarantine = bun("read-quarantine", &path).await;
    let error = store
        .read_json_state_file(file_path, Opaque::default, Ok)
        .await
        .unwrap_err();
    let ReadJsonStateError::Corrupt(error) = error else {
        panic!("{error}")
    };
    assert_eq!(
        error.quarantine_path.as_deref(),
        Some(original_quarantine.trim_end())
    );
}

#[tokio::test]
async fn returns_empty_only_when_the_file_and_tombstone_are_both_absent() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let file_path = path.to_str().unwrap();
    let store = JsonFileStore::default();
    let value = store
        .read_json_state_file(file_path, || Opaque::from_value(json!({"fresh": true})), Ok)
        .await
        .unwrap();
    assert_eq!(value["fresh"], true);
    for suffix in ["second", "first"] {
        fs::write(format!("{file_path}.corrupt-{suffix}"), b"{")
            .await
            .unwrap();
    }
    let error = store
        .read_json_state_file(file_path, Opaque::default, Ok)
        .await
        .unwrap_err();
    let ReadJsonStateError::Corrupt(error) = error else {
        panic!("{error}")
    };
    assert_eq!(
        error.quarantine_path,
        Some(format!("{file_path}.corrupt-second"))
    );
}

#[tokio::test]
async fn rejects_concurrent_reads_without_creating_duplicate_quarantines() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let file_path = path.to_str().unwrap();
    let store = JsonFileStore::default();
    fs::write(&path, b"{").await.unwrap();
    let read = || store.read_json_state_file(file_path, Opaque::default, Ok);
    let (left, right) = tokio::join!(read(), read());
    let left = left.unwrap_err();
    let right = right.unwrap_err();
    let (ReadJsonStateError::Corrupt(left), ReadJsonStateError::Corrupt(right)) = (left, right)
    else {
        panic!("Expected both reads to reject corrupt state");
    };
    assert!(left.quarantine_path.is_some());
    assert_eq!(left.quarantine_path, right.quarantine_path);
    let mut entries = fs::read_dir(root.path()).await.unwrap();
    assert!(entries.next_entry().await.unwrap().is_some());
    assert!(entries.next_entry().await.unwrap().is_none());
}

#[tokio::test]
async fn keeps_the_target_directory_and_removes_the_candidate_on_rename_failure() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    let file_path = path.to_str().unwrap();
    let store = JsonFileStore::default();
    fs::create_dir(&path).await.unwrap();
    let read_error = store
        .read_json_state_file(file_path, Opaque::default, Ok)
        .await
        .unwrap_err();
    assert!(matches!(read_error, ReadJsonStateError::Io(_)));
    let write_error = store
        .write_json_file_atomic(file_path, &json!({"ok": true}), JsonWriteOptions::default())
        .await
        .unwrap_err();
    let WriteFileError::Atomic(error) = write_error else {
        panic!("{write_error}")
    };
    assert!(!error.renamed);
    assert!(
        error
            .to_string()
            .starts_with("Atomic write of state.json failed before rename:")
    );
    let entries: Vec<_> = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["state.json"]);
    assert!(path.is_dir());
}

#[tokio::test]
async fn opens_the_same_candidate_name_as_the_original() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("state.json");
    let uuid = Uuid::from_u128(0x12345678_0000_4000_8000_000000000000);
    let store = JsonFileStore::new(ManualClock::new(0), || uuid);
    let candidate = root
        .path()
        .join(format!(".state.json.{}.{uuid}.tmp", std::process::id()));
    fs::create_dir(&candidate).await.unwrap();
    let error = store
        .write_file_atomic(file.to_str().unwrap(), b"synthetic", None)
        .await
        .unwrap_err();
    let WriteFileError::Io(error) = error else {
        panic!("{error}")
    };
    assert_eq!(error.kind(), std::io::ErrorKind::IsADirectory);
    assert!(!file.exists());
    assert!(candidate.is_dir());
}
