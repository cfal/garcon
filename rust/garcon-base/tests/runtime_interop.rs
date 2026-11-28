use std::path::Path;
use std::process::{Command, Output};

use garcon_base::server_runtime::{
    publish_server_runtime, remove_server_runtime, runtime_state_with_identity,
};
use garcon_contract::server_runtime::{CliRuntimeDescriptor, parse_cli_runtime_descriptor};
use garcon_js::{ManualClock, json};
use serde_json::Value;
use uuid::Uuid;

fn bun(args: &[&str]) -> Output {
    let output = Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/runtime_interop.ts"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

#[tokio::test]
async fn bun_and_rust_read_and_remove_the_other_runtime_descriptor() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let config = dir.path().join("config");
    tokio::fs::create_dir(&workspace).await.unwrap();
    tokio::fs::create_dir(&config).await.unwrap();
    let state = runtime_state_with_identity(
        workspace.to_str().unwrap(),
        &ManualClock::new(0),
        Uuid::nil(),
        [1; 32],
    )
    .unwrap();
    let published =
        publish_server_runtime(&state, "http://127.0.0.1:4321/", config.to_str().unwrap())
            .await
            .unwrap();
    let output = bun(&["read", &published.file_path]);
    let from_bun: Value = json::from_slice(&output.stdout).unwrap();
    assert_eq!(from_bun["instanceId"], state.identity.instance_id);
    assert_eq!(from_bun["localCapability"], state.local_capability);
    assert_eq!(from_bun["baseUrl"], "http://127.0.0.1:4321");
    assert_eq!(
        published.file_path,
        config.join("runtime.json").to_str().unwrap()
    );
    assert!(!workspace.join("runtime.json").exists());
    let output = bun(&["remove", &published.file_path, &state.identity.instance_id]);
    assert!(json::from_slice::<bool>(&output.stdout).unwrap());

    bun(&["write", &published.file_path]);
    let bytes = tokio::fs::read(&published.file_path).await.unwrap();
    let descriptor = parse_cli_runtime_descriptor(&json::from_slice(&bytes).unwrap()).unwrap();
    assert!(matches!(descriptor, CliRuntimeDescriptor::ExecutorCli(_)));
    assert_eq!(descriptor.endpoint().instance_id, "bun-executor-fixture");
    assert!(
        !remove_server_runtime(&published.file_path, &state.identity.instance_id)
            .await
            .unwrap()
    );
    assert!(
        remove_server_runtime(&published.file_path, &descriptor.endpoint().instance_id)
            .await
            .unwrap()
    );
}
