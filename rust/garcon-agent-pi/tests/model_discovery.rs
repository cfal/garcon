#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use garcon_agent_pi::pi_models::get_pi_available_models;
use tokio::{fs, process::Command, time::timeout};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn the_output_cap_preserves_the_exit_diagnostic_from_bun() {
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("pi");
    fs::write(
        &binary,
        b"#!/bin/sh\nexec dd if=/dev/zero bs=65536 count=100\n",
    )
    .await
    .unwrap();
    fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    let oracle = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/model-discovery.ts"
        ))
        .arg(&binary)
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    let result = get_pi_available_models(binary.to_str().unwrap(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(
        result.to_string(),
        String::from_utf8(oracle.stdout).unwrap()
    );
}

#[tokio::test]
async fn reads_the_completed_listing_and_stops_a_descendant_that_inherits_the_pipe() {
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("pi");
    fs::write(&binary, include_bytes!("fixtures/model-discovery.sh"))
        .await
        .unwrap();
    fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();

    let cancel = CancellationToken::new();
    let release = cancel.clone();
    let discover = get_pi_available_models(binary.to_str().unwrap(), &cancel);
    tokio::pin!(discover);
    let results = match timeout(Duration::from_secs(5), discover.as_mut()).await {
        Ok(result) => result.unwrap(),
        Err(error) => {
            release.cancel();
            let _ = discover.await;
            panic!("Pi did not finish reading the listing: {error}");
        }
    };
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].value, "fixture/text");
    assert_eq!(results[0].supports_images, Some(false));

    let pid = fs::read_to_string(binary.with_extension("ready"))
        .await
        .unwrap();
    assert!(pid.parse::<u32>().unwrap() > 1);
    let status = Command::new("ps")
        .args(["-p", &pid, "-o", "stat="])
        .output()
        .await
        .unwrap();
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(
        status.trim().is_empty() || status.trim().starts_with('Z'),
        "the descendant is still running: {status}"
    );
}
