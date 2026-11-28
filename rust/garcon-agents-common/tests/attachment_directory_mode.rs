#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use garcon_agents_common::shared::attachment_files::materialize_attachment_files;
use garcon_agents_common::shared::attachments::AttachmentInput;

#[tokio::test]
async fn attachment_directory_is_private_as_in_bun() {
    let original = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/attachment-directory-mode.ts"
        ))
        .output()
        .await
        .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    let original: u32 = garcon_js::json::from_slice(&original.stdout).unwrap();
    assert_eq!(original, 0o700);

    let attachments = [AttachmentInput {
        data: "data:text/plain;base64,Ynl0ZXM=",
        name: Some("fixture.txt"),
        mime_type: None,
    }];
    let materialized = materialize_attachment_files("garcon-attachment-mode-test", &attachments)
        .await
        .unwrap();
    let directory = Path::new(&materialized.files[0].path).parent().unwrap();
    let actual = tokio::fs::metadata(directory)
        .await
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    materialized.cleanup().await;

    assert_eq!(
        actual, original,
        "directory mode: {actual:04o}, expected {original:04o}"
    );
}
