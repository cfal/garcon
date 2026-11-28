#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::rc::Rc;

use garcon_agent_pi::{config::create_pi_config, pi_cli::run_single_query};
use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};
use serde_json::json;
use tokio::fs;
use tokio::process::Command;

struct Environment(String);

impl AgentEnvironmentReader for Environment {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        Ok((name == "GARCON_PI_BINARY").then(|| self.0.clone()))
    }
}

#[tokio::test]
async fn echoes_stdin_and_preserves_the_real_exit_diagnostic_over_a_failed_write() {
    let directory = tempfile::tempdir().unwrap();
    let binary = directory.path().join("fake-pi");
    fs::write(&binary, include_str!("fixtures/one-shot-pi.sh"))
        .await
        .unwrap();
    fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
        .await
        .unwrap();
    let original = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/single-query.ts"
        ))
        .arg(&binary)
        .arg(directory.path())
        .output()
        .await
        .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );

    let config = create_pi_config(Rc::new(Environment(binary.to_str().unwrap().to_owned())));
    let mut options = json!({
        "model": "synthetic/success",
        "thinkingMode": "high",
        "projectPath": directory.path(),
    });
    let success = run_single_query(" fixture prompt \n", &options, None, &config)
        .await
        .unwrap();
    options["model"] = json!("synthetic/failure");
    let failure = run_single_query(&"x".repeat(1024 * 1024), &options, None, &config)
        .await
        .unwrap_err();

    assert_eq!(success, "echo: fixture prompt");
    assert_eq!(
        failure.to_string(),
        "Pi command failed with code 7: synthetic exit diagnostic"
    );
    let actual = serde_json::to_vec(&[success, failure.to_string()]).unwrap();
    assert_eq!(actual, original.stdout);
}
